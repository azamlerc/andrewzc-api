import express from "express";
import { getPortfolioProjects } from "../database.js";
import { strip, cleanError } from "./middleware.js";

export const portfolioRouter = express.Router();

portfolioRouter.get("/", async (_req, res) => {
  try {
    const projects = await getPortfolioProjects();
    return res.json({ projects: projects.map(strip) });
  } catch (err) {
    console.error("GET /portfolio failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});
