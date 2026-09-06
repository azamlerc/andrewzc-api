// routes/mcp.js
// Remote MCP server exposing entity photographs.
//
// Why remote rather than a local stdio server: a local one is proxied through
// the desktop app, so it disappears whenever the Mac sleeps or Andrew is on
// his phone. Most of the useful cases are in the field, which is exactly when
// a desktop-bound connector is unavailable.
//
// Four tools:
//   entity_thumbnails(list, key)                 every thumbnail for one entity
//   entity_image(list, key, filename)            one full-size image
//   image_upload_begin(list, key, count)         allocate presigned upload targets
//   image_upload_complete(list, key, filenames)  record them against the entity
//
// No image bytes pass through this server in either direction beyond the reads,
// and none pass through the conversation at all. Uploads go client → S3 directly
// on presigned URLs, exactly as edit.html and the v4 CLI already do.
//
// Thumbnails are the default because base64 image data is expensive in an
// assistant's context — a handful of full-size JPEGs would crowd out the work
// they were fetched for. Full size is a deliberate second call.
//
// The tools take a list and an entity key, never a URL or an S3 path. The
// server composes the object key itself and will only serve filenames that
// appear in that entity's own images array, so it cannot be aimed at
// arbitrary objects in the bucket.

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { getEntity, appendEntityImages } from "../database.js";
import {
  getImageObject, imageUploadsConfigured, presignImageUploadPair,
  nextImageIndex, imageFilenameForEntity, isValidEntityImageFilename,
  IMAGE_SPEC,
} from "../aws.js";

export const mcpRouter = express.Router();

const MAX_THUMBS      = 12;
const MAX_FULL_BYTES  = 5 * 1024 * 1024;

const text = (s) => ({ content: [{ type: "text", text: s }], isError: false });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });

// ---- Bearer auth ------------------------------------------------------------
// MCP_TOKEN is required. Without it the route refuses to serve rather than
// defaulting open — this endpoint reads private data.

mcpRouter.use((req, res, next) => {
  const expected = process.env.MCP_TOKEN;
  if (!expected) return res.status(503).json({ error: "MCP_TOKEN not configured" });
  const got = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (got !== expected) return res.status(401).json({ error: "unauthorized" });
  return next();
});

// ---- Shared lookup ----------------------------------------------------------

async function loadImages(list, key) {
  const entity = await getEntity(list, key);
  if (!entity) return { error: `No entity "${key}" on the ${list} list.` };

  const images = Array.isArray(entity.images) ? entity.images.filter(Boolean) : [];
  if (images.length === 0) {
    return { error: `${entity.name || key} has no images. (Photos live in the images array; an empty one means none were uploaded.)` };
  }
  return { entity, images };
}

// ---- Server -----------------------------------------------------------------

function buildServer() {
  const server = new McpServer(
    { name: "andrewzc-images", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "entity_thumbnails",
    {
      title: "Entity thumbnails",
      description:
        "Return every thumbnail photograph attached to one entity on andrewzc.net. " +
        "Use this to actually look at what an entity's photos show — to check whether they " +
        "match what the entity claims, to spot mislabelled or orphaned images, or when Andrew " +
        "mentions a place he has photographed. Thumbnails are small and cheap; prefer this over " +
        "entity_image unless fine detail matters.",
      inputSchema: {
        list: z.string().describe('Page key, e.g. "hamburgers", "mosques", "confluence".'),
        key:  z.string().describe('Entity key within that list, e.g. "manhattns-burgers".'),
      },
    },
    async ({ list, key }) => {
      if (!imageUploadsConfigured()) return fail("S3 is not configured on this server.");

      const found = await loadImages(list, key);
      if (found.error) return fail(found.error);
      const { entity, images } = found;

      const wanted = images.slice(0, MAX_THUMBS);
      const results = await Promise.all(
        wanted.map(async (filename) => {
          try {
            const obj = await getImageObject(list, filename, { thumb: true });
            return obj ? { filename, obj } : { filename, missing: true };
          } catch (err) {
            return { filename, error: err?.message || String(err) };
          }
        })
      );

      const content = [{
        type: "text",
        text: `${entity.name || key} (${list}) — ${images.length} image${images.length === 1 ? "" : "s"}` +
              (images.length > wanted.length ? `, showing the first ${wanted.length}` : "") +
              `. Filenames: ${images.join(", ")}`,
      }];

      for (const r of results) {
        if (r.obj) {
          content.push({ type: "text", text: r.filename });
          content.push({
            type: "image",
            data: r.obj.bytes.toString("base64"),
            mimeType: r.obj.contentType,
          });
        } else if (r.missing) {
          content.push({ type: "text", text: `${r.filename} — listed on the entity but not in the bucket (orphaned reference).` });
        } else {
          content.push({ type: "text", text: `${r.filename} — could not be read: ${r.error}` });
        }
      }

      return { content, isError: false };
    }
  );

  server.registerTool(
    "entity_image",
    {
      title: "Entity image, full size",
      description:
        "Return one full-size photograph for an entity. Call entity_thumbnails first to see " +
        "what is available and to get the filename. Only use this when the thumbnail is genuinely " +
        "too small to answer the question — full-size images are large.",
      inputSchema: {
        list:     z.string().describe("Page key."),
        key:      z.string().describe("Entity key within that list."),
        filename: z.string().describe('Filename from the entity\'s images array, e.g. "manhattns-burgers5.jpg".'),
      },
    },
    async ({ list, key, filename }) => {
      if (!imageUploadsConfigured()) return fail("S3 is not configured on this server.");

      const found = await loadImages(list, key);
      if (found.error) return fail(found.error);
      const { entity, images } = found;

      if (!images.includes(filename)) {
        return fail(`"${filename}" is not on ${entity.name || key}. Available: ${images.join(", ")}`);
      }

      let obj;
      try {
        obj = await getImageObject(list, filename, { thumb: false });
      } catch (err) {
        return fail(`Could not read ${filename}: ${err?.message || err}`);
      }
      if (!obj) return fail(`${filename} is listed on the entity but missing from the bucket.`);

      if (obj.bytes.length > MAX_FULL_BYTES) {
        return fail(
          `${filename} is ${(obj.bytes.length / 1048576).toFixed(1)} MB, over the ${MAX_FULL_BYTES / 1048576} MB limit. ` +
          `Use entity_thumbnails instead.`
        );
      }

      return {
        content: [
          { type: "text", text: `${entity.name || key} (${list}) — ${filename}, full size` },
          { type: "image", data: obj.bytes.toString("base64"), mimeType: obj.contentType },
        ],
        isError: false,
      };
    }
  );

  // ---- Writes ----------------------------------------------------------------
  // Deliberately two steps with the bytes going nowhere near this server.
  // begin hands out presigned URLs, the caller resizes and PUTs straight to S3,
  // complete records the filenames. Same contract edit.html and the v4 CLI use,
  // so nothing here is a new pathway — it is the existing one with a third client.

  server.registerTool(
    "image_upload_begin",
    {
      title: "Begin an image upload",
      description:
        "Allocate upload targets for photographs to be attached to an entity. Returns one filename " +
        "and two presigned S3 URLs per image (original and thumbnail), plus the encoding spec to " +
        "resize with. The caller does the resizing and the PUTs; image bytes never pass through the " +
        "server or through the conversation. Follow with image_upload_complete once both PUTs succeed " +
        "for a filename — an image that is uploaded but never completed stays invisible to the site.",
      inputSchema: {
        list:  z.string().describe("Page key the entity belongs to."),
        key:   z.string().describe("Entity key."),
        count: z.number().int().min(1).max(20).default(1).describe("How many images to allocate."),
      },
    },
    async ({ list, key, count = 1 }) => {
      if (!imageUploadsConfigured()) return fail("S3 is not configured on this server.");

      const entity = await getEntity(list, key);
      if (!entity) return fail(`No entity "${key}" on the ${list} list. Check the key before uploading — an image filed against the wrong entity is tedious to unpick.`);

      let index = nextImageIndex(entity);
      const uploads = [];
      for (let i = 0; i < count; i += 1) {
        uploads.push(await presignImageUploadPair(list, imageFilenameForEntity(entity, index++)));
      }

      const existing = Array.isArray(entity.images) ? entity.images.length : 0;
      return text(JSON.stringify({
        entity: { list, key, name: entity.name, existingImages: existing },
        spec: IMAGE_SPEC,
        uploads: uploads.map(u => ({
          filename: u.filename,
          originalUploadUrl: u.originalUploadUrl,
          thumbUploadUrl: u.thumbUploadUrl,
        })),
        note: "PUT the full-size JPEG to originalUploadUrl and the thumbnail to thumbUploadUrl, both with Content-Type: image/jpeg. URLs expire in 5 minutes.",
      }, null, 2));
    }
  );

  server.registerTool(
    "image_upload_complete",
    {
      title: "Complete an image upload",
      description:
        "Record uploaded filenames against the entity, making them visible on the site. Only call this " +
        "after both the original and thumbnail PUTs have succeeded for each filename.",
      inputSchema: {
        list:      z.string().describe("Page key."),
        key:       z.string().describe("Entity key."),
        filenames: z.array(z.string()).min(1).describe("Filenames returned by image_upload_begin."),
      },
    },
    async ({ list, key, filenames }) => {
      const clean = Array.from(new Set(filenames.map(n => String(n || "").trim()).filter(Boolean)));
      if (clean.length === 0) return fail("No filenames given.");

      const bad = clean.filter(n => !isValidEntityImageFilename(key, n));
      if (bad.length) return fail(`These do not match the "${key}" naming pattern: ${bad.join(", ")}. Only filenames from image_upload_begin are accepted.`);

      const doc = await appendEntityImages(list, key, clean);
      if (!doc) return fail(`No entity "${key}" on the ${list} list.`);

      const all = Array.isArray(doc.images) ? doc.images : [];
      return text(`Added ${clean.join(", ")} to ${doc.name || key} (${list}). It now has ${all.length} image${all.length === 1 ? "" : "s"}: ${all.join(", ")}`);
    }
  );

  return server;
}

// ---- Transport --------------------------------------------------------------
// Stateless: a fresh server and transport per request. There is no session
// state worth keeping between calls, and this survives restarts and multiple
// instances without any shared store.

mcpRouter.post("/", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => { transport.close(); server.close(); });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
});

// GET and DELETE are only meaningful for stateful sessions.
mcpRouter.get("/",    (_req, res) => res.status(405).json({ error: "method_not_allowed" }));
mcpRouter.delete("/", (_req, res) => res.status(405).json({ error: "method_not_allowed" }));
