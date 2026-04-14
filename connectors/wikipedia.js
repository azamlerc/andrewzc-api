// connectors/wikipedia.js
// Wikipedia API connector — article lookup and GeoSearch.
// All responses are cached in data_source_cache.

import { connectToMongo } from "../database.js";

const BASE = "https://en.wikipedia.org/w/api.php";

// ---- Cache helpers ----

async function getCached(cacheKey) {
  const db = await connectToMongo();
  const doc = await db.collection("data_source_cache").findOne({
    source: "wikipedia",
    cacheKey,
  });
  if (!doc) return null;
  const ageHours = (Date.now() - doc.fetchedAt.getTime()) / 3600000;
  if (ageHours > doc.ttlHours) return null;
  return doc.response;
}

async function setCache(cacheKey, response, ttlHours = 24) {
  const db = await connectToMongo();
  await db.collection("data_source_cache").updateOne(
    { source: "wikipedia", cacheKey },
    {
      $set: {
        source: "wikipedia",
        cacheKey,
        response,
        fetchedAt: new Date(),
        ttlHours,
      },
    },
    { upsert: true }
  );
}

// ---- Article lookup ----
//
// Attempts to find the Wikipedia article for a named entity.
// Returns a full Wikipedia URL string on high-confidence match, or null.
//
// High confidence = exactly one result whose title closely matches the name.
// Falls through to null (hygiene agent flags for review) when:
//   - No results found
//   - First result is a disambiguation page
//   - Title match is ambiguous

export async function findWikipediaArticle(name, country) {
  if (!name) return null;

  const query = country ? `${name} ${country}` : name;
  const cacheKey = `article:${query.toLowerCase().replace(/\s+/g, "_")}`;

  const cached = await getCached(cacheKey);
  if (cached !== null) return cached.url ?? null;

  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: 3,
    format: "json",
    origin: "*",
  });

  let data;
  try {
    const res = await fetch(`${BASE}?${params}`);
    data = await res.json();
  } catch (err) {
    console.error("[wikipedia] search failed:", err.message);
    return null;
  }

  const results = data?.query?.search ?? [];
  if (!results.length) {
    await setCache(cacheKey, { url: null });
    return null;
  }

  const first = results[0];

  // Reject disambiguation pages
  if (first.snippet?.toLowerCase().includes("may refer to")) {
    await setCache(cacheKey, { url: null });
    return null;
  }

  // Confidence check: title should share at least one significant word with the name
  const nameWords = name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const titleWords = first.title.toLowerCase().split(/\s+/);
  const overlap = nameWords.filter((w) => titleWords.some((t) => t.includes(w)));
  if (nameWords.length > 0 && overlap.length === 0) {
    await setCache(cacheKey, { url: null });
    return null;
  }

  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(
    first.title.replace(/ /g, "_")
  )}`;
  await setCache(cacheKey, { url });
  return url;
}

// ---- GeoSearch ----
//
// Returns up to `limit` Wikipedia articles near a coordinate.
// Used by the proposals agent.

export async function geoSearch(lat, lon, radiusMeters = 50000, limit = 50) {
  const latR = Math.round(lat * 100) / 100;
  const lonR = Math.round(lon * 100) / 100;
  const cacheKey = `geosearch:${latR}:${lonR}:${radiusMeters}`;

  const cached = await getCached(cacheKey);
  if (cached !== null) return cached.results ?? [];

  const params = new URLSearchParams({
    action: "query",
    list: "geosearch",
    gscoord: `${lat}|${lon}`,
    gsradius: radiusMeters,
    gslimit: limit,
    format: "json",
    origin: "*",
  });

  let data;
  try {
    const res = await fetch(`${BASE}?${params}`);
    data = await res.json();
  } catch (err) {
    console.error("[wikipedia] geosearch failed:", err.message);
    return [];
  }

  const results = (data?.query?.geosearch ?? []).map((r) => ({
    title: r.title,
    lat: r.lat,
    lon: r.lon,
    distanceMeters: r.dist,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
      r.title.replace(/ /g, "_")
    )}`,
  }));

  await setCache(cacheKey, { results }, 24);
  return results;
}
