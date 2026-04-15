// routes/lookup.js
// Top-level lookup endpoints: /flags, /countries, /cities, /trips, /artists,
// /search, /coords, /wiki
// Mounted at "/" in server.js.

import express from "express";
import {
  getFlagsData,
  getEntitiesByCountry, getEntitiesByCity, getEntitiesByTrip, getEntitiesByArtist,
} from "../database.js";
import { cityKeyToDisplayName } from "../utils.js";
import { naturalLanguageSearch } from "../search.js";
import { getCoordsFromUrl } from "../wiki.js";
import { strip, cleanError } from "./middleware.js";

export const lookupRouter = express.Router();

lookupRouter.get("/flags", async (_req, res) => {
  try {
    return res.json(await getFlagsData());
  } catch (err) {
    console.error("GET /flags failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

lookupRouter.get("/countries/:code", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  try {
    const result = await getEntitiesByCountry(code);
    return res.json({ country: strip(result.country), entities: result.entities.map(strip) });
  } catch (err) {
    console.error("GET /countries/:code failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

lookupRouter.get("/cities/:key", async (req, res) => {
  const city = cityKeyToDisplayName(req.params.key);
  if (!city) return res.status(400).json({ error: "bad_request", message: "Missing city key" });
  try {
    const result = await getEntitiesByCity(city);
    return res.json({ city: strip(result.city), entities: result.entities.map(strip) });
  } catch (err) {
    console.error("GET /cities/:key failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

lookupRouter.get("/trips/:key", async (req, res) => {
  const key = String(req.params.key || "").trim();
  if (!key) return res.status(400).json({ error: "bad_request", message: "Missing trip key" });
  try {
    const result = await getEntitiesByTrip(key);
    return res.json({ page: strip(result.page), entities: result.entities.map(strip) });
  } catch (err) {
    console.error("GET /trips/:key failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

lookupRouter.get("/artists/:key", async (req, res) => {
  const key = String(req.params.key || "").trim();
  if (!key) return res.status(400).json({ error: "bad_request", message: "Missing artist key" });
  try {
    const result = await getEntitiesByArtist(key);
    return res.json({ artist: strip(result.artist), entities: result.entities.map(strip) });
  } catch (err) {
    console.error("GET /artists/:key failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

lookupRouter.post("/search", async (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (!query) return res.status(400).json({ error: "bad_request", message: "Missing query" });
  try {
    const result = await naturalLanguageSearch(query);
    return res.json({ ...result, results: result.results.map(strip) });
  } catch (err) {
    console.error("POST /search failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

lookupRouter.get("/coords", async (req, res) => {
  const url  = String(req.query.url  || "").trim();
  const list = String(req.query.list || "").trim();
  if (!url) return res.status(400).json({ error: "bad_request", message: "Missing ?url=" });
  try { new URL(url); } catch { return res.status(400).json({ error: "bad_request", message: "Invalid URL" }); }
  try {
    const result = await getCoordsFromUrl(url, { list });
    return res.json(result ?? { coords: null, location: null });
  } catch (err) {
    console.error("GET /coords failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

lookupRouter.get("/wiki", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "bad_request", message: "Missing ?q=" });
  try {
    const params = new URLSearchParams({ action: "query", list: "search", srsearch: q, format: "json", srlimit: "1" });
    const response = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
      headers: { "User-Agent": "andrewzc/1.0 (personal project)" },
    });
    if (!response.ok) return res.status(502).json({ error: "wiki_error", message: "Wikipedia request failed" });
    const json  = await response.json();
    const title = json?.query?.search?.[0]?.title;
    if (!title) return res.json({ link: null });
    return res.json({ link: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` });
  } catch (err) {
    console.error("GET /wiki failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});
