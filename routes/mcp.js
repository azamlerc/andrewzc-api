// routes/mcp.js
// Remote MCP server exposing entity photographs.
//
// Why remote rather than a local stdio server: a local one is proxied through
// the desktop app, so it disappears whenever the Mac sleeps or Andrew is on
// his phone. Most of the useful cases are in the field, which is exactly when
// a desktop-bound connector is unavailable.
//
// Two tools:
//   entity_thumbnails(list, key)          every thumbnail for one entity
//   entity_image(list, key, filename)     one full-size image
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

import { getEntity } from "../database.js";
import { getImageObject, imageUploadsConfigured } from "../aws.js";

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
