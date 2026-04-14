// agents/runner.js
// Generic rule engine used by the hygiene agent.
// Evaluates declarative rules against an entity, returning fixes and flags.
// Pure evaluation is separate from application — nothing is written here.

import { getPage } from "./pageCache.js";

// ---- Types (JSDoc for clarity) ----
//
// Rule: {
//   id: string,
//   scope: "auto" | "flag",
//   applies: (entity, page) => boolean,
//   check: (entity, page) => boolean,         // true = problem found
//   fix: (entity, page) => object | null,     // field patches for $set (auto only)
//   message: (entity, page) => string,        // human-readable for logs/UI
// }
//
// Note: fix() may return null to fall through from auto → flag
// (e.g. U4 tries to find a Wikipedia link; if it can't, it flags instead)

export async function evaluate(entity, rules) {
  const page = await getPage(entity.list);
  const fixes = [];
  const flagged = [];

  for (const rule of rules) {
    // Check if rule applies to this entity/page combination
    let applies;
    try {
      applies = await rule.applies(entity, page);
    } catch (err) {
      console.error(`[runner] rule ${rule.id} applies() threw:`, err.message);
      continue;
    }
    if (!applies) continue;

    // Check if there's actually a problem
    let hasProblem;
    try {
      hasProblem = await rule.check(entity, page);
    } catch (err) {
      console.error(`[runner] rule ${rule.id} check() threw:`, err.message);
      continue;
    }
    if (!hasProblem) continue;

    // Problem found — resolve fix or flag
    if (rule.scope === "auto") {
      let patch;
      try {
        patch = await rule.fix(entity, page);
      } catch (err) {
        console.error(`[runner] rule ${rule.id} fix() threw:`, err.message);
        patch = null;
      }

      if (patch) {
        // Skip if the patch would produce no actual change.
        // This prevents the change stream from looping: if applyFixes writes
        // updatedAt, the stream fires again; without this guard the rule would
        // "fix" the same value repeatedly forever.
        const fields = Object.keys(patch);
        const alreadyCorrect = fields.every(
          (f) => JSON.stringify(entity[f]) === JSON.stringify(patch[f])
        );
        if (alreadyCorrect) continue;

        fixes.push({
          rule: rule.id,
          field: fields.join(","),
          from: Object.fromEntries(fields.map((f) => [f, entity[f]])),
          to: patch,
          patch,
        });
      } else {
        // fix() returned null — fall through to flag
        flagged.push({
          rule: rule.id,
          field: "unknown",
          message: rule.message(entity, page),
          value: null,
        });
      }
    } else {
      // flag scope
      let msg;
      try {
        msg = rule.message(entity, page);
      } catch {
        msg = `Rule ${rule.id} triggered`;
      }
      flagged.push({
        rule: rule.id,
        field: rule.flagField ?? "unknown",
        message: msg,
        value: rule.flagValue ? rule.flagValue(entity) : undefined,
      });
    }
  }

  return { fixes, flagged };
}

// Apply a set of fixes to an entity in a single updateOne.
// Returns true if the update was performed, false if nothing to do.
export async function applyFixes(db, entityId, fixes) {
  if (!fixes.length) return false;
  const patch = Object.assign({}, ...fixes.map((f) => f.patch));
  patch.updatedAt = new Date();
  await db.collection("entities").updateOne({ _id: entityId }, { $set: patch });
  return true;
}
