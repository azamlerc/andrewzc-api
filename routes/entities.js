// routes/entities.js
// Entity CRUD, geo search, bingo, props query, and similar.
// Mounted at /entities in server.js.

import express from "express";
import {
  getEntity, createEntity, updateEntity, enrichEntity, appendEntityImages, deleteEntity,
  getBingoEntities,
  getEntitiesNearPoint, getEntitiesNearEntity,
  searchByName, queryByProps,
  searchByVector, getSimilarEntities, embedText,
} from "../database.js";
import {
  imageUploadsConfigured,
  nextImageIndex,
  imageFilenameForEntity,
  isValidEntityImageFilename,
  presignImageUploadPair,
} from "../aws.js";
import { requireAdminSession } from "./auth.js";
import { strip, stripKeepSummary, cleanError } from "./middleware.js";

export const entitiesRouter = express.Router();

function requireS3(res) {
  if (imageUploadsConfigured()) return true;
  res.status(503).json({ error: "unavailable", message: "S3 upload not configured" });
  return false;
}

// ---- Name / vector search ----

entitiesRouter.get("/", async (req, res) => {
  const nameQuery   = req.query.name   ? String(req.query.name).trim()   : null;
  const searchQuery = req.query.search ? String(req.query.search).trim() : null;
  const listFilter  = req.query.list   ? String(req.query.list)          : null;
  const limit       = Math.min(parseInt(req.query.limit) || 50, 50);

  if (nameQuery) {
    try {
      const results = await searchByName(nameQuery, { listFilter, limit });
      return res.json({ name: nameQuery, results: results.map(strip) });
    } catch (err) {
      console.error("GET /entities?name= failed:", err);
      return res.status(500).json({ error: "internal_error", message: cleanError(err) });
    }
  }

  if (searchQuery) {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: "unavailable", message: "Semantic search not configured" });
    }
    try {
      const vector  = await embedText(searchQuery);
      const results = await searchByVector(vector, { listFilter, limit });
      return res.json({ query: searchQuery, results: results.map(strip) });
    } catch (err) {
      console.error("GET /entities?search= failed:", err);
      return res.status(500).json({ error: "internal_error", message: cleanError(err) });
    }
  }

  return res.status(400).json({ error: "bad_request", message: "Missing ?name= or ?search=" });
});

// ---- Bingo ----

entitiesRouter.post("/bingo", async (req, res) => {
  const pageKeys = Array.isArray(req.body?.pages)
    ? Array.from(new Set(req.body.pages.map((k) => String(k || "").trim()).filter(Boolean)))
    : [];
  const countryCodes = Array.isArray(req.body?.countries)
    ? Array.from(new Set(req.body.countries.map((c) => String(c || "").trim().toUpperCase()).filter(Boolean)))
    : [];
  const stateCodes = Array.isArray(req.body?.states)
    ? Array.from(new Set(req.body.states.map((c) => String(c || "").trim().toUpperCase()).filter(Boolean)))
    : [];

  if (pageKeys.length === 0) return res.status(400).json({ error: "bad_request", message: "Missing non-empty pages array" });

  const hasCountries = countryCodes.length > 0;
  const hasStates    = stateCodes.length > 0;
  if (hasCountries === hasStates) return res.status(400).json({ error: "bad_request", message: "Provide exactly one of countries or states" });

  const scopeCodes = hasCountries ? countryCodes : stateCodes;
  if (scopeCodes.some((c) => !/^[A-Z]{2}$/.test(c))) return res.status(400).json({ error: "bad_request", message: "Country/state codes must be two letters" });

  try {
    const result = await getBingoEntities({ pageKeys, ...(hasCountries ? { countries: countryCodes } : { states: stateCodes }) });
    if (result.error === "pages_not_found") {
      return res.status(404).json({ error: "page_not_found", message: `Unknown page keys: ${result.missingPages.join(", ")}`, missingPages: result.missingPages });
    }
    return res.json({ scope: hasCountries ? "countries" : "states", pages: result.pages.map(strip), entities: result.entities.map(strip) });
  } catch (err) {
    console.error("POST /entities/bingo failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Geo: nearby point (no entity context) ----

entitiesRouter.get("/nearby", async (req, res) => {
  const lat        = parseFloat(req.query.lat);
  const lon        = parseFloat(req.query.lon);
  const radiusKm   = parseFloat(req.query.radius) || 50;
  const listFilter = req.query.list ? String(req.query.list) : null;
  const limit      = Math.min(parseInt(req.query.limit) || 50, 100);

  if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: "bad_request", message: "Missing or invalid ?lat= and ?lon=" });

  try {
    const results = await getEntitiesNearPoint(lon, lat, { radiusKm, listFilter, limit });
    return res.json({ lat, lon, radiusKm, results: results.map(strip) });
  } catch (err) {
    console.error("GET /entities/nearby failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Props query ----

entitiesRouter.get("/:list/props", async (req, res) => {
  const { list } = req.params;
  const limit    = Math.min(parseInt(req.query.limit) || 50, 50);
  const sortBy   = req.query.sortBy  ? String(req.query.sortBy)  : null;
  const sortDir  = req.query.sortDir === "asc" ? 1 : -1;

  let filter = {};
  if (req.query.filter) {
    try { filter = JSON.parse(req.query.filter); }
    catch { return res.status(400).json({ error: "bad_request", message: "Invalid ?filter= JSON" }); }
  }

  try {
    const result = await queryByProps(list, filter, { limit, sortBy, sortDir });
    if (result.error === "page_not_found") return res.status(404).json({ error: "page_not_found", message: `No page found for key='${list}'` });
    return res.json({ list, filter, results: result.results.map(strip) });
  } catch (err) {
    console.error("GET /entities/:list/props failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Similar ----

entitiesRouter.get("/:list/:key/similar", async (req, res) => {
  const { list, key } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 50);
  try {
    const result = await getSimilarEntities(list, key, { limit });
    if (result.error === "not_found")    return res.status(404).json({ error: "not_found", message: "Entity not found" });
    if (result.error === "no_embedding") return res.status(404).json({ error: "not_found", message: "Entity has no embedding" });
    return res.json({ list, key, results: result.results.map(strip) });
  } catch (err) {
    console.error("GET /entities/:list/:key/similar failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Geo: nearby entity ----

entitiesRouter.get("/:list/:key/nearby", async (req, res) => {
  const { list, key } = req.params;
  const radiusKm = parseFloat(req.query.radius) || 50;
  const limit    = Math.min(parseInt(req.query.limit) || 50, 50);
  try {
    const result = await getEntitiesNearEntity(list, key, { radiusKm, limit });
    if (result.error === "not_found")   return res.status(404).json({ error: "not_found", message: "Entity not found" });
    if (result.error === "no_location") return res.status(404).json({ error: "not_found", message: "Entity has no location" });
    return res.json({ list, key, radiusKm, ...result.source, results: result.results.map(strip) });
  } catch (err) {
    console.error("GET /entities/:list/:key/nearby failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Single entity ----

entitiesRouter.get("/:list/:key", async (req, res) => {
  const { list, key } = req.params;
  try {
    const doc = await getEntity(list, key);
    if (!doc) return res.status(404).json({ error: "not_found", message: "Entity not found" });
    return res.json(stripKeepSummary(doc));
  } catch (err) {
    console.error("GET /entities/:list/:key failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Create ----

entitiesRouter.post("/:list", requireAdminSession, async (req, res) => {
  const { list } = req.params;
  const payload  = { ...(req.body || {}) };
  delete payload._id; delete payload.list; delete payload.key;
  try {
    const result = await createEntity(list, payload);
    if (result.error === "page_not_found") return res.status(404).json({ error: "page_not_found", message: `No page found for key='${list}'` });
    if (result.error === "missing_name")   return res.status(400).json({ error: "bad_request",    message: "Missing name" });
    if (result.error === "bad_key")        return res.status(400).json({ error: "bad_request",    message: "Could not derive key" });
    return res.status(201).json(strip(result.doc));
  } catch (err) {
    if (err?.code === 11000 || String(err).includes("E11000")) return res.status(409).json({ error: "conflict", message: "Entity already exists" });
    console.error("POST /entities/:list failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Update ----

entitiesRouter.put("/:list/:key", requireAdminSession, async (req, res) => {
  const { list, key } = req.params;
  const patch = { ...(req.body || {}) };
  delete patch._id; delete patch.list; delete patch.key;
  try {
    const doc = await updateEntity(list, key, patch);
    if (!doc) return res.status(404).json({ error: "not_found", message: "Entity not found" });
    return res.json(strip(doc));
  } catch (err) {
    console.error("PUT /entities/:list/:key failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Enrich ----

entitiesRouter.post("/:list/:key/enrich", requireAdminSession, async (req, res) => {
  const { list, key } = req.params;
  try {
    const result = await enrichEntity(list, key);
    if (result.error === "not_found") return res.status(404).json({ error: "not_found", message: "Entity not found" });
    return res.json({ enriched: result.enriched, doc: strip(result.doc) });
  } catch (err) {
    console.error("POST /entities/:list/:key/enrich failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Images ----

entitiesRouter.post("/:list/:key/images/presign", requireAdminSession, async (req, res) => {
  if (!requireS3(res)) return;
  const { list, key } = req.params;
  const count = Math.min(Math.max(parseInt(req.body?.count) || 1, 1), 20);
  try {
    const entity = await getEntity(list, key);
    if (!entity) return res.status(404).json({ error: "not_found", message: "Entity not found" });
    let index = nextImageIndex(entity);
    const uploads = [];
    for (let i = 0; i < count; i += 1) {
      uploads.push(await presignImageUploadPair(list, imageFilenameForEntity(entity, index++)));
    }
    return res.json({ list, key, uploads });
  } catch (err) {
    console.error("POST /entities/:list/:key/images/presign failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

entitiesRouter.post("/:list/:key/images/complete", requireAdminSession, async (req, res) => {
  const { list, key } = req.params;
  const filenames = Array.isArray(req.body?.filenames) ? req.body.filenames : [];
  const clean = Array.from(new Set(filenames.map((n) => String(n || "").trim()).filter(Boolean)));
  if (clean.length === 0) return res.status(400).json({ error: "bad_request", message: "Missing filenames" });
  if (clean.some((n) => !isValidEntityImageFilename(key, n))) return res.status(400).json({ error: "bad_request", message: "Invalid filename for entity" });
  try {
    const doc = await appendEntityImages(list, key, clean);
    if (!doc) return res.status(404).json({ error: "not_found", message: "Entity not found" });
    return res.json({ ok: true, entity: strip(doc), added: clean });
  } catch (err) {
    console.error("POST /entities/:list/:key/images/complete failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Delete ----

entitiesRouter.delete("/:list/:key", requireAdminSession, async (req, res) => {
  const { list, key } = req.params;
  try {
    const doc = await deleteEntity(list, key);
    if (!doc) return res.status(404).json({ error: "not_found", message: "Entity not found" });
    return res.json({ ok: true, deleted: strip(doc) });
  } catch (err) {
    console.error("DELETE /entities/:list/:key failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});
