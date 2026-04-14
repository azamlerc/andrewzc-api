// agents/hygiene.js
// Data hygiene agent.
// Evaluates hygiene rules against entities and applies auto-fixes.
// Entry points: runForEntity (reactive) and runBatch (cron).

import { connectToMongo } from "../database.js";
import { evaluate, applyFixes } from "./runner.js";
import { RULES } from "./hygieneRules.js";
import { writeRunRecord, getRecentRuns } from "./runRecords.js";

// ---- Core: run hygiene on a single entity by _id ----

export async function runForEntity(entityId, trigger = "change-stream") {
  const db = await connectToMongo();

  // Always fetch fresh — never trust the change event payload
  const entity = await db.collection("entities").findOne({ _id: entityId });
  if (!entity) {
    console.warn(`[hygiene] entity ${entityId} not found`);
    return null;
  }

  let fixes = [];
  let flagged = [];
  let error = null;

  try {
    ({ fixes, flagged } = await evaluate(entity, RULES));
    await applyFixes(db, entityId, fixes);
  } catch (err) {
    error = err.message;
    console.error(`[hygiene] error on ${entity.key}:`, err.message);
  }

  const record = await writeRunRecord({
    agent: "hygiene",
    trigger,
    entityKey: entity.key,
    entityList: entity.list,
    fixes,
    flagged,
    error,
  });

  if (fixes.length || flagged.length) {
    console.log(
      `[hygiene] ${entity.key}: ${fixes.length} fix(es), ${flagged.length} flag(s)`
    );
  }

  return record;
}

// ---- Batch: run hygiene on entities updated in the past N hours ----

export async function runBatch(trigger = "cron-hourly", lookbackHours = 25) {
  const db = await connectToMongo();
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const entities = await db
    .collection("entities")
    .find({ updatedAt: { $gte: since } })
    .project({ _id: 1 })
    .toArray();

  console.log(`[hygiene] batch: ${entities.length} entities to check`);

  const results = [];
  for (const { _id } of entities) {
    const result = await runForEntity(_id, trigger);
    if (result) results.push(result);
  }

  const summary = summarizeBatch(results);
  console.log(`[hygiene] batch complete:`, summary);
  return { results, summary };
}

// ---- Summarize a batch run for Slack digest ----

function summarizeBatch(results) {
  const summary = {
    total: results.length,
    fixed: 0,
    flagged: 0,
    byRule: {},
    flaggedEntities: [],
  };

  for (const r of results) {
    if (!r) continue;

    if (r.fixes?.length) {
      summary.fixed++;
      for (const fix of r.fixes) {
        summary.byRule[fix.rule] = (summary.byRule[fix.rule] ?? 0) + 1;
      }
    }

    if (r.flagged?.length) {
      summary.flagged++;
      summary.flaggedEntities.push({
        key: r.entityKey,
        list: r.entityList,
        flags: r.flagged.map((f) => f.rule),
      });
    }
  }

  return summary;
}

// ---- Format a daily digest message for Slack ----

export async function buildDailyDigest() {
  const runs = await getRecentRuns("hygiene", 24);
  if (!runs.length) return null;

  const summary = summarizeBatch(runs);
  if (!summary.fixed && !summary.flagged) return null;

  const ruleLines = Object.entries(summary.byRule)
    .sort((a, b) => b[1] - a[1])
    .map(([rule, count]) => `• ${count} ${ruleLabel(rule)}`)
    .join("\n");

  let text = `✅ *Hygiene — ${summary.fixed} fix${summary.fixed !== 1 ? "es" : ""} today*`;
  if (ruleLines) text += `\n${ruleLines}`;

  if (summary.flagged) {
    text += `\n\n⚠️ ${summary.flagged} flagged for review → andrewzc.net/admin/hygiene`;
  }

  return text;
}

function ruleLabel(ruleId) {
  const labels = {
    U1: "country normalization",
    U2: "been: null → false",
    U3: "key format issue",
    U4: "Wikipedia link added",
    U6: "missing country field",
    U7: "flag emoji added",
    U8: "dateAdded added",
    U9: "GeoJSON location derived",
    U10: "coords format normalized",
    C1: "confluence prefix derived",
    C3: "confluence link fixed",
    P1: "projects date normalized",
    P3: "projects transport emoji added",
    P4: "projects been set to false",
    T3: "transit transport emoji added",
    N2: "UNESCO link replaced with Wikipedia",
    TR2: "tripoint flags set from countries",
  };
  return labels[ruleId] ?? ruleId;
}
