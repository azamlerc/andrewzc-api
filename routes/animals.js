// routes/animals.js
// Animals endpoints: artists (static config) and images.
// Mounted at /animals in server.js.

import express from "express";
import { getAnimalsImages } from "../database.js";
import { artists } from "../config/animals.js";
import { cleanError } from "./middleware.js";

export const animalsRouter = express.Router();

// GET /animals/artists
// Returns the static artist configuration list.
animalsRouter.get("/artists", (_req, res) => {
  return res.json({ artists });
});

// GET /animals/images
// Returns image records. Optional ?artist= and ?style= filters.
animalsRouter.get("/images", async (req, res) => {
  const artistId = req.query.artist ? String(req.query.artist).trim() : null;
  const style    = req.query.style  ? String(req.query.style).trim()  : null;
  try {
    const images = await getAnimalsImages({ artistId, style });
    return res.json({ images });
  } catch (err) {
    console.error("GET /animals/images failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});
