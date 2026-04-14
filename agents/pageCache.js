// agents/pageCache.js
// In-memory cache of page documents, keyed by list name.
// Agents call getPage(listKey) to look up tags, dataset, notes etc.
// Refreshed from MongoDB every hour — pages change rarely.

import { connectToMongo } from "../database.js";

const TTL_MS = 60 * 60 * 1000; // 1 hour

let cache = {};
let lastRefreshed = null;

async function maybeRefresh() {
  if (lastRefreshed && Date.now() - lastRefreshed < TTL_MS) return;
  const db = await connectToMongo();
  const pages = await db.collection("pages").find({}).toArray();
  cache = Object.fromEntries(pages.map((p) => [p.key, p]));
  lastRefreshed = Date.now();
  console.log(`[pageCache] refreshed — ${pages.length} pages loaded`);
}

export async function getPage(listKey) {
  await maybeRefresh();
  return cache[listKey] ?? null;
}

export async function refreshNow() {
  lastRefreshed = null;
  await maybeRefresh();
}

// Convenience: does a page have a specific tag?
export async function pageHasTag(listKey, tag) {
  const page = await getPage(listKey);
  return page?.tags?.includes(tag) ?? false;
}
