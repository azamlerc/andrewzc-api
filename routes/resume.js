// routes/resume.js
// GET /resume
// GET /resume/:custom

import express from "express";
import { getResume } from "../database.js";
import { strip, cleanError } from "./middleware.js";

export const resumeRouter = express.Router();

resumeRouter.get("/", async (_req, res) => {
  try {
    const entries = await getResume();
    return res.json({ entries });
  } catch (err) {
    console.error("GET /resume failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

resumeRouter.get("/:custom", async (req, res) => {
  const custom = req.params.custom.trim();
  try {
    const entries = await getResume(custom);
    return res.json({ entries });
  } catch (err) {
    console.error(`GET /resume/${req.params.custom} failed:`, err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});
