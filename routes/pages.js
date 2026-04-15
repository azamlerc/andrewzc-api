// routes/pages.js
// GET/POST/PUT /pages and /pages/:id/entities

import express from "express";
import { getPage, getPages, getPageSummaries, getPageWithEntities, createPage, updatePage } from "../database.js";
import { requireAdminSession } from "./auth.js";
import { strip, cleanError } from "./middleware.js";

export const pagesRouter = express.Router();

pagesRouter.get("/", async (_req, res) => {
  try {
    const pages = await getPages();
    return res.json({ pages: pages.map(strip) });
  } catch (err) {
    console.error("GET /pages failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

pagesRouter.get("/summaries", async (_req, res) => {
  try {
    const summaries = await getPageSummaries();
    return res.json({ pages: summaries });
  } catch (err) {
    console.error("GET /pages/summaries failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

pagesRouter.get("/:id", async (req, res) => {
  try {
    const page = await getPage(req.params.id);
    if (!page) return res.status(404).json({ error: "page_not_found", message: `No page found for key='${req.params.id}'` });
    return res.json(strip(page));
  } catch (err) {
    console.error("GET /pages/:id failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

pagesRouter.get("/:id/entities", async (req, res) => {
  try {
    const result = await getPageWithEntities(req.params.id);
    if (!result) return res.status(404).json({ error: "page_not_found", message: `No page found for key='${req.params.id}'` });
    return res.json({
      "--info--": strip(result.page),
      entities:  result.entities.map(strip),
    });
  } catch (err) {
    console.error("GET /pages/:id/entities failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

pagesRouter.post("/", requireAdminSession, async (req, res) => {
  const payload = { ...(req.body || {}) };
  delete payload._id;
  delete payload.key;
  try {
    const result = await createPage(payload);
    if (result.error === "missing_name") return res.status(400).json({ error: "bad_request", message: "Missing name" });
    if (result.error === "bad_key")      return res.status(400).json({ error: "bad_request", message: "Could not derive key" });
    return res.status(201).json(strip(result.doc));
  } catch (err) {
    if (err?.code === 11000 || String(err).includes("E11000")) {
      return res.status(409).json({ error: "conflict", message: "Page already exists" });
    }
    console.error("POST /pages failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

pagesRouter.put("/:id", requireAdminSession, async (req, res) => {
  const patch = { ...(req.body || {}) };
  delete patch._id;
  delete patch.key;
  try {
    const doc = await updatePage(req.params.id, patch);
    if (!doc) return res.status(404).json({ error: "page_not_found", message: `No page found for key='${req.params.id}'` });
    return res.json(strip(doc));
  } catch (err) {
    console.error("PUT /pages/:id failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});
