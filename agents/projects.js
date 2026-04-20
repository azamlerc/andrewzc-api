// agents/projects.js
// Transit projects monitor.
// Fetches urbanrail.net daily, diffs against existing projects entities,
// inserts new ones, and posts to Slack.

import { connectToMongo } from "../database.js";
import { fetchOpenings, updateLastInsertedDate } from "../connectors/urbanrail.js";
import { findWikipediaArticle } from "../connectors/wikipedia.js";
import { writeRunRecord } from "./runRecords.js";
import { postProjectOpening, postAdmin } from "../connectors/slack.js";
import { countryToFlag, typeToEmoji, toKebabCase } from "./hygieneHelpers.js";

// Human-readable type labels for name generation
const TYPE_LABELS = {
  metro: "Metro",
  monorail: "Monorail",
  tram: "Tram",
  "light-rail": "Light Rail",
  suburban: "Suburban",
  "people-mover": "People Mover",
};

// ---- Main entry point ----

export async function run(trigger = "cron-daily", { dryRun = false } = {}) {
  console.log(`[projects] starting run (trigger=${trigger}, dryRun=${dryRun})`);

  const db = await connectToMongo();

  // Fetch and parse urbanrail.net (cutoff date is read inside fetchOpenings)
  let openings;
  try {
    openings = await fetchOpenings();
  } catch (err) {
    console.error("[projects] failed to fetch openings:", err.message);
    await writeRunRecord({ agent: "projects", trigger, summary: { error: err.message }, error: err.message });
    await postAdmin(`⚠️ Projects monitor failed to fetch urbanrail.net: ${err.message}`);
    return null;
  }

  // Filter out closures — we track openings only
  const active = openings.filter((o) => !o.isClosure);
  console.log(`[projects] ${active.length} active openings, ${openings.length - active.length} closures skipped`);

  // Load existing projects for duplicate detection
  const existing = await db
    .collection("entities")
    .find({ list: "projects" })
    .project({ key: 1, name: 1, reference: 1, prefix: 1, _id: 1 })
    .toArray();

  const existingKeys = new Set(existing.map((e) => e.key));
  const existingByRef = new Map();
  for (const e of existing) {
    if (!existingByRef.has(e.reference)) existingByRef.set(e.reference, []);
    existingByRef.get(e.reference).push(e);
  }

  const toInsert = [];
  const toUpdate = [];
  const possibleDuplicates = [];
  const skipped = [];

  for (const opening of active) {
    const entity = await buildEntity(opening, existingKeys);
    if (!entity) {
      // buildEntity returns null if the base key already exists — skip silently
      skipped.push({ opening, reason: "key already exists or build failed" });
      continue;
    }

    // Exact key match — already exists (shouldn't reach here given buildEntity change, but safety net)
    if (existingKeys.has(entity.key)) {
      skipped.push({ opening, reason: "already exists (key match)" });
      continue;
    }

    // Fuzzy match against undated entries — update their prefix instead of inserting
    const fuzzyMatch = findFuzzyMatch(entity, existingByRef);
    if (fuzzyMatch) {
      toUpdate.push({ existing: fuzzyMatch, newPrefix: entity.prefix });
      continue;
    }

    // Possible duplicate — similar name against dated entries, warn but still insert
    const possibleMatch = findPossibleDuplicate(entity, existingByRef);
    if (possibleMatch) {
      possibleDuplicates.push({
        newKey: entity.key,
        newName: entity.name,
        newPrefix: entity.prefix,
        existingKey: possibleMatch.key,
        existingName: possibleMatch.name,
        existingPrefix: possibleMatch.prefix,
      });
      // Still insert — let the human decide
    }

    toInsert.push(entity);
  }

  console.log(
    `[projects] ${toInsert.length} new, ${toUpdate.length} date updates, ` +
    `${possibleDuplicates.length} possible duplicates, ${skipped.length} skipped`
  );

  if (dryRun) {
    console.log("[projects] dry run — not inserting");
    return {
      dryRun: true,
      wouldInsert: toInsert,
      wouldUpdate: toUpdate.map((u) => ({
        key: u.existing.key,
        name: u.existing.name,
        currentPrefix: u.existing.prefix,
        newPrefix: u.newPrefix,
      })),
      possibleDuplicates,
      skipped,
    };
  }

  // Insert new entities
  const inserted = [];
  const failed = [];

  for (const entity of toInsert) {
    try {
      await db.collection("entities").insertOne(entity);
      inserted.push(entity);
      existingKeys.add(entity.key);
    } catch (err) {
      console.error(`[projects] failed to insert ${entity.key}:`, err.message);
      failed.push({ key: entity.key, error: err.message });
    }
  }

  // Update prefix on fuzzy-matched undated entities
  const updated = [];
  for (const { existing, newPrefix } of toUpdate) {
    try {
      await db.collection("entities").updateOne(
        { _id: existing._id },
        { $set: { prefix: newPrefix, updatedAt: new Date() } }
      );
      updated.push({ key: existing.key, prefix: newPrefix });
      console.log(`[projects] updated prefix on ${existing.key}: ${existing.prefix} → ${newPrefix}`);
    } catch (err) {
      console.error(`[projects] failed to update ${existing.key}:`, err.message);
      failed.push({ key: existing.key, error: err.message });
    }
  }

  // Post new insertions to Slack
  for (const entity of inserted) {
    try {
      await postProjectOpening(entity, entity.badges?.includes("✨"));
    } catch (err) {
      console.error(`[projects] slack post failed for ${entity.key}:`, err.message);
    }
  }

  // Post possible duplicate warnings to Slack for human review
  if (possibleDuplicates.length) {
    const lines = possibleDuplicates.map(
      (d) => `• *${d.newName}* (${d.newPrefix}) may duplicate *${d.existingName}* (${d.existingKey})`
    );
    await postAdmin(
      `⚠️ Projects monitor inserted ${possibleDuplicates.length} possible duplicate(s) — please review:\n${lines.join("\n")}`
    ).catch(() => {});
  }

  const summary = {
    found: openings.length,
    active: active.length,
    inserted: inserted.length,
    updated: updated.length,
    possibleDuplicates: possibleDuplicates.length,
    skipped: skipped.length,
    failed: failed.length,
  };

  console.log("[projects] run complete:", summary);

  // Advance cutoff to the most recent date processed this run — whether
  // inserted, updated, or skipped. This prevents re-parsing entries we've
  // already handled (including ones we skipped because they were duplicates).
  const allDates = [
    ...inserted.map((e) => e.prefix),
    ...updated.map((u) => u.prefix),
    ...active.map((o) => o.date),
  ].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

  if (allDates.length > 0) {
    const latestDate = allDates.sort().reverse()[0];
    await updateLastInsertedDate(latestDate);
  }

  await writeRunRecord({
    agent: "projects",
    trigger,
    summary,
    insertedKeys: inserted.map((e) => e.key),
    updatedKeys: updated.map((u) => u.key),
    possibleDuplicates,
  });

  return { inserted, updated, skipped, failed, possibleDuplicates, summary };
}

// ---- Fuzzy duplicate detection (undated entries only) ----

function findFuzzyMatch(entity, existingByRef) {
  const candidates = existingByRef.get(entity.reference) ?? [];
  const undated = candidates.filter(
    (c) => !c.prefix || c.prefix === "20??" || /^20\d{2}$/.test(c.prefix)
  );
  if (!undated.length) return null;

  const newWords = tokenize(entity.name);

  for (const candidate of undated) {
    const candidateWords = tokenize(candidate.name);
    const overlap = newWords.filter((w) => candidateWords.includes(w));
    const minLen = Math.min(newWords.length, candidateWords.length);
    if (overlap.length >= 2 && overlap.length / minLen >= 0.5) {
      console.log(`[projects] fuzzy match (undated): "${entity.name}" ~ "${candidate.name}" (${entity.reference})`);
      return candidate;
    }
  }

  return null;
}

// ---- Possible duplicate detection (dated entries) ----

function findPossibleDuplicate(entity, existingByRef) {
  const candidates = existingByRef.get(entity.reference) ?? [];
  const dated = candidates.filter(
    (c) => c.prefix && c.prefix !== "20??" && !/^20\d{2}$/.test(c.prefix)
  );
  if (!dated.length) return null;

  const newWords = tokenize(entity.name);
  if (newWords.length === 0) return null;

  for (const candidate of dated) {
    const candidateWords = tokenize(candidate.name);
    if (candidateWords.length === 0) continue;
    const overlap = newWords.filter((w) => candidateWords.includes(w));
    const minLen = Math.min(newWords.length, candidateWords.length);
    if (overlap.length >= 2 && overlap.length / minLen >= 0.6) {
      return candidate;
    }
  }

  return null;
}

// ---- Tokenize name for fuzzy comparison ----

function tokenize(name) {
  const STOP = new Set(["to", "the", "a", "an", "and", "of", "in", "at", "line", "metro", "tram"]);
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

// ---- Build a full entity document from a parsed opening ----
// Returns null if the base key already exists in existingKeys — this means
// the entry was already handled (inserted, or exists from a previous run/manual
// entry). The -N suffix loop is only for genuine same-name collisions within
// a single run (e.g. two different Delhi Metro extensions with the same name).

async function buildEntity(opening, existingKeys) {
  if (!opening.city || !opening.date) return null;

  const type = normalizeType(opening.type);
  const country = opening.country?.toUpperCase() ?? null;

  let name;
  if (opening.isNewSystem) {
    name = TYPE_LABELS[type] ?? "Metro";
  } else if (opening.isNewLine) {
    name = opening.lineName ?? TYPE_LABELS[type] ?? "New Line";
  } else {
    const dest = opening.toStation ?? opening.fromStation ?? null;
    if (dest) {
      name = opening.lineName ? `${opening.lineName} to ${dest}` : `to ${dest}`;
    } else {
      name = opening.lineName ?? TYPE_LABELS[type] ?? "Extension";
    }
  }

  const baseKey = toKebabCase(`${opening.city} ${name}`);
  if (!baseKey) return null;

  // If the base key already exists, this entry has already been handled —
  // return null so the caller skips it rather than creating a -2 variant.
  if (existingKeys.has(baseKey)) return null;

  // Handle genuine within-run key collisions (e.g. two entries with same
  // generated name in a single parse) by appending -2, -3, etc.
  let key = baseKey;
  let i = 2;
  while (existingKeys.has(key)) {
    key = `${baseKey}-${i++}`;
    if (i > 10) return null;
  }

  const badges = [];
  if (opening.isNewSystem) badges.push("✨");

  const icons = [];
  if (country) {
    const flag = countryToFlag(country);
    if (flag) icons.push(flag);
  }
  const transportEmoji = typeToEmoji(type);
  if (transportEmoji) icons.push(transportEmoji);

  let link = null;
  try {
    const query = opening.lineName
      ? `${opening.city} ${opening.lineName} ${type}`
      : `${opening.city} ${type}`;
    link = await findWikipediaArticle(query, country);
  } catch (err) {
    console.warn(`[projects] Wikipedia lookup failed for ${key}:`, err.message);
  }

  return {
    key,
    name,
    list: "projects",
    reference: opening.city,
    prefix: opening.date,
    type,
    country,
    icons,
    badges,
    link,
    been: false,
    dateAdded: new Date().toISOString().slice(0, 10),
    source: "agent",
    updatedAt: new Date(),
  };
}

// ---- Normalize type to our controlled vocabulary ----

function normalizeType(raw) {
  if (!raw) return "metro";
  const s = raw.toLowerCase();
  if (s.includes("monorail")) return "monorail";
  if (s.includes("light-rail") || s.includes("light rail") || s.includes("lrt")) return "light-rail";
  if (s.includes("tram") || s.includes("streetcar")) return "tram";
  if (s.includes("suburban") || s.includes("commuter") || s.includes("s-bahn") || s.includes("rer")) return "suburban";
  if (s.includes("people") || s.includes("automated") || s.includes("apm")) return "people-mover";
  if (s.includes("cable")) return "people-mover";
  return "metro";
}
