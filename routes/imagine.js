// routes/imagine.js
// Imagine endpoints: prompts, images, models.
// Mounted at /imagine in server.js.

import express from "express";
import { getPrompts, getPrompt, getImagineImages } from "../database.js";
import { cleanError } from "./middleware.js";
import { models } from "../config/models.js";

export const imagineRouter = express.Router();

// GET /imagine/prompts
// Returns all prompts. Optional ?category= filter; category=new returns the 80
// prompts with the most recently created images.
imagineRouter.get("/prompts", async (req, res) => {
  const category = req.query.category ? String(req.query.category).trim() : null;
  try {
    const prompts = await getPrompts({ category });
    return res.json({ prompts });
  } catch (err) {
    console.error("GET /imagine/prompts failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// GET /imagine/prompts/:id
// Returns a single prompt with its image records.
// Optional ?category= returns prevId/nextId for navigation within that category.
imagineRouter.get("/prompts/:id", async (req, res) => {
  const { id } = req.params;
  const category = req.query.category ? String(req.query.category).trim() : null;
  try {
    const result = await getPrompt(id, { category });
    if (!result) return res.status(404).json({ error: "not_found", message: "Prompt not found" });
    return res.json(result);
  } catch (err) {
    console.error("GET /imagine/prompts/:id failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// GET /imagine/models
// Returns model configuration from static config. No DB query needed.
imagineRouter.get("/models", (_req, res) => {
  return res.json({ models });
});

// GET /imagine/images
// Returns image records. Optional ?model= and ?style= filters.
imagineRouter.get("/images", async (req, res) => {
  const model = req.query.model ? String(req.query.model).trim() : null;
  const style = req.query.style ? String(req.query.style).trim() : null;
  try {
    const images = await getImagineImages({ model, style });
    return res.json({ images });
  } catch (err) {
    console.error("GET /imagine/images failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});
