// routes/agents.js
// HTTP endpoints for all agents.
// POST /agents/hygiene       { entityId }
// POST /agents/hygiene/batch {}
// POST /agents/projects      { dryRun? }
//
// All endpoints require admin auth (requireAdminSession middleware from server.js).

import express from "express";
import { ObjectId } from "mongodb";
import { runForEntity, runBatch } from "../agents/hygiene.js";
import { run as runProjects } from "../agents/projects.js";
import { getRecentRuns } from "../agents/runRecords.js";

export const agentsRouter = express.Router();

// POST /agents/hygiene — run hygiene on a single entity
agentsRouter.post("/hygiene", async (req, res) => {
  const { entityId, dryRun = false } = req.body;

  if (!entityId) {
    return res.status(400).json({ error: "entityId is required" });
  }

  let id;
  try {
    id = new ObjectId(entityId);
  } catch {
    return res.status(400).json({ error: "entityId is not a valid ObjectId" });
  }

  try {
    if (dryRun) {
      const { connectToMongo } = await import("../database.js");
      const { evaluate } = await import("../agents/runner.js");
      const { RULES } = await import("../agents/hygieneRules.js");
      const db = await connectToMongo();
      const entity = await db.collection("entities").findOne({ _id: id });
      if (!entity) return res.status(404).json({ error: "entity not found" });
      const result = await evaluate(entity, RULES);
      return res.json({ dryRun: true, entityKey: entity.key, ...result });
    }

    const result = await runForEntity(id, "http");
    if (!result) return res.status(404).json({ error: "entity not found" });
    return res.json(result);
  } catch (err) {
    console.error("[agents/hygiene] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /agents/hygiene/batch — trigger a batch run manually
agentsRouter.post("/hygiene/batch", async (req, res) => {
  const { lookbackHours = 25 } = req.body;
  try {
    const { summary } = await runBatch("http", lookbackHours);
    return res.json({ summary });
  } catch (err) {
    console.error("[agents/hygiene/batch] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /agents/hygiene/recent — recent runs for dashboard
agentsRouter.get("/hygiene/recent", async (req, res) => {
  const hours = parseInt(req.query.hours ?? "24");
  try {
    const runs = await getRecentRuns("hygiene", hours);
    return res.json({ runs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /agents/projects — run the transit projects monitor
agentsRouter.post("/projects", async (req, res) => {
  const { dryRun = false } = req.body ?? {};
  try {
    const result = await runProjects("http", { dryRun });
    return res.json(result);
  } catch (err) {
    console.error("[agents/projects] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /agents/projects/recent — recent runs for dashboard
agentsRouter.get("/projects/recent", async (req, res) => {
  const hours = parseInt(req.query.hours ?? "24") ;
  try {
    const runs = await getRecentRuns("projects", hours);
    return res.json({ runs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
