// Database layer — all MongoDB and OpenAI operations.
// No HTTP, no Express. Each function takes plain arguments and returns plain objects.

import { MongoClient } from "mongodb";
import OpenAI from "openai";
import { makeKeyFromPageTags, simplify } from "./utils.js";

let client;
let db;

export async function connectToMongo() {
  if (db) return db;
  client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(process.env.MONGODB_DB);
  return db;
}

export async function ensureIndexes() {
  const db = await connectToMongo();
  await db.collection("accounts").createIndex({ username: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ sessionTokenHash: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ accountId: 1 });
  await db.collection("pages").createIndex({ key: 1 }, { unique: true });
  await db.collection("entities").createIndex({ list: 1, key: 1 }, { unique: true });
  await db.collection("entities").createIndex({ list: 1, country: 1 });
  await db.collection("entities").createIndex({ list: 1, countries: 1 });
  await db.collection("entities").createIndex({ list: 1, state: 1 });
  await db.collection("entities").createIndex({ list: 1, states: 1 });

	// Agent collections
	await db.collection("agent_runs").createIndex({ agent: 1, ts: -1 });
	await db.collection("agent_runs").createIndex({ entityKey: 1, agent: 1 });
	await db.collection("proposed").createIndex({ status: 1, proposedAt: -1 });
	await db.collection("proposed").createIndex({ list: 1, status: 1 });
	await db.collection("agent_context").createIndex({ agent: 1, topic: 1 }, { unique: true });
	await db.collection("data_source_cache").createIndex({ source: 1, cacheKey: 1 }, { unique: true });
	await db.collection("feedback").createIndex({ entityKey: 1 });
	await db.collection("feedback").createIndex({ list: 1, decidedAt: -1 });
}

// ---- Pages ----

export async function getPage(key) {
  const db = await connectToMongo();
  return db.collection("pages").findOne({ key });
}

export async function getPages() {
  const db = await connectToMongo();
  return db.collection("pages").find({}).sort({ name: 1, key: 1 }).toArray();
}

export async function createPage(payload) {
  const db   = await connectToMongo();
  const name = String(payload.name || "").trim();
  if (!name) return { error: "missing_name" };

  const key = simplify(name);
  if (!key) return { error: "bad_key" };

  const now = new Date();
  const doc = { ...payload, key, createdAt: payload.createdAt ?? now, updatedAt: now };
  await db.collection("pages").insertOne(doc);
  return { doc };
}

export async function updatePage(key, patch) {
  const db  = await connectToMongo();
  const now = new Date();
  const result = await db.collection("pages").findOneAndUpdate(
    { key },
    { $set: { ...patch, updatedAt: now } },
    { returnDocument: "after" }
  );
  return result?.value ?? result ?? null;
}

// Returns a compact list of pages for use as AI context.
// Each entry has key, name, and an optional one-line description.
export async function getPageSummaries() {
  const db   = await connectToMongo();
  const docs = await db.collection("pages")
    .find({ propertyOf: { $exists: false } })
    .sort({ name: 1 })
    .project({ key: 1, name: 1, header: 1, notes: 1 })
    .toArray();

  return docs.map(({ key, name, header, notes }) => {
    const description = header || (Array.isArray(notes) && notes[0]) || null;
    return description ? { key, name, description } : { key, name };
  });
}

// Hoist props relevant to a specific page context into top-level entity fields.
// Called when serving a propertyOf page — the prop key matches the page key.
//
// Handles all four prop value shapes from the props workflow:
//   true / false     → boolean membership, nothing to hoist
//   number / string  → hoisted as `prefix` (scalar value)
//   object           → hoist strike, badges, icons; value becomes prefix/reference
//   array            → left as-is (e.g. metro-widths), no hoisting
//
// prefixProp    — if set (e.g. "year"), extract obj[prefixProp] as prefix instead of obj.value
// referenceProp — if set (e.g. "country"), extract obj[referenceProp] as reference
//
// props are stripped from the returned entity (not for client consumption on page endpoints).
function hoistPropForPage(entity, propKey, { prefixProp, referenceProp } = {}) {
  const prop = entity?.props?.[propKey];
  const { props: _props, ...rest } = entity;

  // Boolean, null, or array (metro-widths style) — nothing to hoist beyond stripping props
  if (prop == null || prop === true || prop === false || Array.isArray(prop)) {
    return rest;
  }

  if (typeof prop === "object") {
    if (prop.strike)        rest.strike = true;
    if (prop.badges?.length) rest.badges = [...(entity.badges || []), ...prop.badges];
    if (prop.icons?.length)  rest.icons  = [...(entity.icons  || []), ...prop.icons];
    if (prop.flags?.length)  rest.flags  = [...(entity.flags  || []), ...prop.flags];
    if (prefixProp    && prop[prefixProp]    != null) rest.prefix    = prop[prefixProp];
    if (referenceProp && prop[referenceProp] != null) rest.reference = prop[referenceProp];
  } else {
    // scalar number or string — use directly as prefix
    rest.prefix = prop;
  }

  return rest;
}

export async function getPageWithEntities(key) {
  const db       = await connectToMongo();
  const pages    = db.collection("pages");
  const entities = db.collection("entities");

  const page = await pages.findOne({ key });
  if (!page) return null;

  let docs;
  const hoistOptions = { prefixProp: page.prefixProp, referenceProp: page.referenceProp };

  if (page.propertyOf) {
    docs = await entities
      .find({ list: page.propertyOf, [`props.${key}`]: { $exists: true } })
      .sort({ name: 1, key: 1 })
      .toArray();
    docs = docs.map(entity => hoistPropForPage(entity, key, hoistOptions));
  } else {
    docs = await entities
      .find({ list: key })
      .sort({ name: 1, key: 1 })
      .toArray();
  }

  return { page, entities: docs };
}

function collectMatchedPlaces(entity, scope, codes) {
  const matched = new Set();

  if (scope === "countries") {
    const single = entity?.country ? String(entity.country).toUpperCase() : null;
    if (single && codes.has(single)) matched.add(single);

    if (Array.isArray(entity?.countries)) {
      for (const code of entity.countries) {
        const upper = String(code || "").toUpperCase();
        if (codes.has(upper)) matched.add(upper);
      }
    }
  } else if (scope === "states") {
    const single = entity?.state ? String(entity.state).toUpperCase() : null;
    if (single && codes.has(single)) matched.add(single);

    if (Array.isArray(entity?.states)) {
      for (const code of entity.states) {
        const upper = String(code || "").toUpperCase();
        if (codes.has(upper)) matched.add(upper);
      }
    }
  }

  return [...matched];
}

export async function getBingoEntities({ pageKeys = [], countries = null, states = null } = {}) {
  const db             = await connectToMongo();
  const pagesCol       = db.collection("pages");
  const entitiesCol    = db.collection("entities");
  const normalizedKeys = Array.from(new Set(
    (pageKeys || [])
      .map((key) => String(key || "").trim())
      .filter(Boolean)
  ));

  const placeCodes = Array.isArray(countries) && countries.length > 0
    ? countries
    : Array.isArray(states) ? states : [];
  const scope = Array.isArray(countries) && countries.length > 0 ? "countries" : "states";
  const codes = new Set(
    placeCodes
      .map((code) => String(code || "").trim().toUpperCase())
      .filter(Boolean)
  );

  const pageDocs = await pagesCol.find({ key: { $in: normalizedKeys } }).toArray();
  const pagesByKey = new Map(pageDocs.map((page) => [page.key, page]));
  const orderedPages = normalizedKeys.map((key) => pagesByKey.get(key)).filter(Boolean);

  if (orderedPages.length !== normalizedKeys.length) {
    const missingPages = normalizedKeys.filter((key) => !pagesByKey.has(key));
    return { error: "pages_not_found", missingPages };
  }

  const scopeMatch = scope === "countries"
    ? { $or: [{ country: { $in: [...codes] } }, { countries: { $in: [...codes] } }] }
    : { $or: [{ state: { $in: [...codes] } }, { states: { $in: [...codes] } }] };

  const directPages = orderedPages.filter((page) => !page.propertyOf);
  const propPages   = orderedPages.filter((page) => page.propertyOf);
  const results     = [];

  if (directPages.length > 0) {
    const directKeys = directPages.map((page) => page.key);
    const directDocs = await entitiesCol
      .find({ list: { $in: directKeys }, ...scopeMatch })
      .sort({ list: 1, name: 1, key: 1 })
      .toArray();

    const docsByList = new Map();
    for (const doc of directDocs) {
      if (!docsByList.has(doc.list)) docsByList.set(doc.list, []);
      docsByList.get(doc.list).push(doc);
    }

    for (const page of directPages) {
      const docs = docsByList.get(page.key) || [];
      for (const doc of docs) {
        results.push({
          ...doc,
          matchedPlaces: collectMatchedPlaces(doc, scope, codes),
        });
      }
    }
  }

  for (const page of propPages) {
    const docs = await entitiesCol
      .find({
        list: page.propertyOf,
        [`props.${page.key}`]: { $exists: true },
        ...scopeMatch,
      })
      .sort({ name: 1, key: 1 })
      .toArray();

    const hoistOptions = { prefixProp: page.prefixProp, referenceProp: page.referenceProp };
    for (const doc of docs) {
      results.push({
        ...hoistPropForPage(doc, page.key, hoistOptions),
        list: page.key,
        sourceList: doc.list,
        matchedPlaces: collectMatchedPlaces(doc, scope, codes),
      });
    }
  }

  return { pages: orderedPages, entities: results };
}

// ---- Entities ----

export async function getEntity(list, key) {
  const db = await connectToMongo();
  return db.collection("entities").findOne({ list, key });
}

export async function createEntity(list, payload) {
  const db       = await connectToMongo();
  const pages    = db.collection("pages");
  const entities = db.collection("entities");

  const page = await pages.findOne({ key: list });
  if (!page) return { error: "page_not_found" };

  const name = String(payload.name || "").trim();
  if (!name) return { error: "missing_name" };

  const reference  = payload.reference != null ? String(payload.reference).trim() : null;
  let countryCode  = null;
  if (payload.country) {
    countryCode = String(payload.country).toUpperCase();
  } else if (Array.isArray(payload.countries) && payload.countries.length > 0) {
    countryCode = String(payload.countries[0]).toUpperCase();
  }

  const baseKey = makeKeyFromPageTags({ tags: page.tags, name, reference, countryCode });
  if (!baseKey) return { error: "bad_key" };

  // Ensure uniqueness within the list by suffixing -2, -3, ... if needed.
  let key = baseKey;
  let i   = 2;
  while (true) {
    if (!await entities.findOne({ list, key })) break;
    key = `${baseKey}-${i++}`;
  }

  const now = new Date();
  const doc = { ...payload, list, key, createdAt: payload.createdAt ?? now, updatedAt: now };
  await entities.insertOne(doc);
  return { doc };
}

export async function updateEntity(list, key, patch) {
  const db  = await connectToMongo();
  const now = new Date();
  const result = await db.collection("entities").findOneAndUpdate(
    { list, key },
    { $set: { ...patch, updatedAt: now } },
    { returnDocument: "after" }
  );
  return result?.value ?? result ?? null;
}

export async function appendEntityImages(list, key, filenames = []) {
  const db = await connectToMongo();
  const clean = Array.from(new Set(
    filenames
      .map(name => String(name || "").trim())
      .filter(Boolean)
  ));

  if (clean.length === 0) {
    return db.collection("entities").findOne({ list, key });
  }

  const now = new Date();
  const result = await db.collection("entities").findOneAndUpdate(
    { list, key },
    {
      $addToSet: { images: { $each: clean } },
      $set: { updatedAt: now },
    },
    { returnDocument: "after" }
  );
  return result?.value ?? result ?? null;
}

// ---- Enrich ----

async function searchWikipediaLink(name) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&format=json&origin=*`;
  const res = await fetch(url);
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { rateLimited: true });
  if (!res.ok) return null;
  const json = await res.json();
  const title = json?.query?.search?.[0]?.title;
  if (!title) return null;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

async function findNearestCity(location, db, radiusKm = 30) {
  const geoPoint = { type: "Point", coordinates: [location.coordinates[0], location.coordinates[1]] };
  const results = await db.collection("entities")
    .find(
      { list: "cities", location: { $nearSphere: { $geometry: geoPoint, $maxDistance: radiusKm * 1000 } } },
      { projection: { name: 1, _id: 0 } }
    )
    .limit(1)
    .toArray();
  return results[0]?.name ?? null;
}

export async function enrichEntity(list, key) {
  const database = await connectToMongo();
  const pages    = database.collection("pages");
  const entities = database.collection("entities");

  const [page, entity] = await Promise.all([
    pages.findOne({ key: list }, { projection: { tags: 1 } }),
    entities.findOne({ list, key }),
  ]);

  if (!entity) return { error: "not_found" };

  const tags           = page?.tags ?? [];
  const skipCoords     = tags.includes("no-coords") || tags.includes("people");
  const needsReference = tags.includes("reference") || tags.includes("reference-optional");

  const update = {};
  let wikiBlocked = false;

  // 1. Link — search Wikipedia by name if missing
  if (!entity.link) {
    try {
      const found = await searchWikipediaLink(entity.name);
      if (found) update.link = found;
    } catch (err) {
      if (err.rateLimited) wikiBlocked = true;
      else throw err;
    }
  }

  const link = update.link ?? entity.link;

  // 2. Coords — extract from Wikipedia page
  if (!wikiBlocked && !skipCoords && !entity.coords && link && /wikipedia\.org/.test(link)) {
    try {
      const { getCoordsFromUrl } = await import("./wiki.js");
      const result = await getCoordsFromUrl(link, { list });
      if (result) {
        update.coords   = result.coords;
        update.location = result.location;
      }
    } catch (err) {
      if (err.rateLimited) wikiBlocked = true;
      else throw err;
    }
  }

  // 3. City — nearest city from coords
  const location = update.location ?? entity.location;
  if (!skipCoords && location && !entity.city) {
    const city = await findNearestCity(location, database);
    if (city) update.city = city;
  }

  // 4. Reference — copy from city if page needs it
  const city = update.city ?? entity.city;
  if (needsReference && !entity.reference && city) {
    update.reference = city;
  }

  if (Object.keys(update).length === 0) {
    return { doc: entity, enriched: [] };
  }

  update.updatedAt = new Date();
  const result = await entities.findOneAndUpdate(
    { list, key },
    { $set: update },
    { returnDocument: "after" }
  );
  const doc = result?.value ?? result;
  return { doc, enriched: Object.keys(update).filter(k => k !== "updatedAt") };
}

export async function deleteEntity(list, key) {
  const db     = await connectToMongo();
  const result = await db.collection("entities").findOneAndDelete({ list, key });
  return result?.value ?? result ?? null;
}

// ---- General entity filter ----

// Query entities by any MongoDB filter. The router constructs the filter
// directly, e.g. { list: "canals", country: "BE" } or { list: "metros", city: "Paris" }.
// Results include page info for each entity.
export async function getEntitiesByFilter(filter = {}, { limit = 50, sortBy = null, sortDir = 1 } = {}) {
  const db = await connectToMongo();
  const sort = sortBy ? { [sortBy]: sortDir } : { name: 1 };

  const pipeline = [
    { $match: filter },
    { $sort: sort },
    { $limit: limit },
    { $lookup: { from: "pages", localField: "list", foreignField: "key", as: "pageInfo" } },
    { $unwind: { path: "$pageInfo", preserveNullAndEmptyArrays: true } },
    { $project: {
      name: 1, list: 1, key: 1, icons: 1, link: 1, reference: 1, been: 1,
      page: { name: "$pageInfo.name", icon: "$pageInfo.icon", key: "$pageInfo.key" },
    }},
  ];

  return db.collection("entities").aggregate(pipeline).toArray();
}

// ---- Country / city grouping ----

export async function getEntitiesByCountry(code) {
  const db   = await connectToMongo();
  const docs = await db.collection("entities")
    .find({ $or: [{ country: code }, { countries: code }] })
    .sort({ name: 1, key: 1 })
    .toArray();

  const countryIndex = docs.findIndex(e => e.list === "countries");
  const country      = countryIndex >= 0 ? docs[countryIndex] : null;
  const entities     = docs.filter((_, i) => i !== countryIndex);
  return { country, entities };
}

export async function getEntitiesByCity(city) {
  const db   = await connectToMongo();
  const docs = await db.collection("entities")
    .find({ city })
    .sort({ name: 1, key: 1 })
    .toArray();

  const cityIndex = docs.findIndex(e => e.list === "cities");
  const cityDoc   = cityIndex >= 0 ? docs[cityIndex] : null;
  const entities  = docs.filter((_, i) => i !== cityIndex);
  return { city: cityDoc, entities };
}

export async function getEntitiesByTrip(key) {
  const db = await connectToMongo();
  const [page, entities] = await Promise.all([
    db.collection("pages").findOne({ key }),
    db.collection("entities")
      .find({ trips: key })
      .sort({ name: 1, key: 1 })
      .toArray(),
  ]);

  return { page, entities };
}

export async function getEntitiesByArtist(key) {
  const db = await connectToMongo();
  const artist = await db.collection("entities").findOne({ list: "artists", key });
  if (!artist?.name) return { artist: artist || null, entities: [] };

  const docs = await db.collection("entities")
    .find({ $or: [{ name: artist.name }, { reference: artist.name }] })
    .sort({ name: 1, key: 1 })
    .toArray();

  const entities = docs.filter((doc) => !(doc.list === "artists" && doc.key === key));
  return { artist, entities };
}

// ---- Geo search ----

const GEO_PROJECTION = {
  name: 1, list: 1, key: 1, icons: 1, link: 1, reference: 1, coords: 1, been: 1,
  distanceKm: { $round: [{ $divide: ["$dist.calculated", 1000] }, 1] },
};

const GEO_PAGE_LOOKUP = [
  { $lookup: { from: "pages", localField: "list", foreignField: "key", as: "pageInfo" } },
  { $unwind: { path: "$pageInfo", preserveNullAndEmptyArrays: true } },
  { $project: {
    ...GEO_PROJECTION,
    page: { name: "$pageInfo.name", icon: "$pageInfo.icon", key: "$pageInfo.key" },
  }},
];

// radius in km, returns entities sorted by distance ascending.
export async function getEntitiesNearPoint(lon, lat, { radiusKm = 50, listFilter = null, limit = 50 } = {}) {
  const db = await connectToMongo();

  const pipeline = [
    { $geoNear: {
      near:          { type: "Point", coordinates: [lon, lat] },
      distanceField: "dist.calculated",
      maxDistance:   radiusKm * 1000,
      spherical:     true,
      query:         listFilter ? { list: listFilter } : {},
    }},
    { $limit: limit },
    ...GEO_PAGE_LOOKUP,
  ];

  return db.collection("entities").aggregate(pipeline).toArray();
}

// Find entities near a given entity's location.
export async function getEntitiesNearEntity(list, key, { radiusKm = 50, limit = 50 } = {}) {
  const db     = await connectToMongo();
  const source = await db.collection("entities").findOne(
    { list, key },
    { projection: { location: 1, name: 1 } }
  );

  if (!source)           return { error: "not_found" };
  if (!source.location)  return { error: "no_location" };

  const [lon, lat] = source.location.coordinates;
  const results    = await getEntitiesNearPoint(lon, lat, { radiusKm, limit: limit + 1 });

  // Filter out the source entity itself
  const filtered = results.filter(r => !(r.list === list && r.key === key)).slice(0, limit);
  return { results: filtered, source: { lon, lat } };
}

// ---- Name search ----

export async function searchByName(name, { listFilter = null, limit = 50 } = {}) {
  const db    = await connectToMongo();
  const match = { name: { $regex: name, $options: "i" } };
  if (listFilter) match.list = listFilter;

  const pipeline = [
    { $match: match },
    { $limit: limit },
    { $lookup: { from: "pages", localField: "list", foreignField: "key", as: "pageInfo" } },
    { $unwind: { path: "$pageInfo", preserveNullAndEmptyArrays: true } },
    { $project: {
      name: 1, list: 1, key: 1, icons: 1, link: 1, reference: 1, been: 1,
      page: { name: "$pageInfo.name", icon: "$pageInfo.icon", key: "$pageInfo.key" },
    }},
  ];

  return db.collection("entities").aggregate(pipeline).toArray();
}

// ---- Props search ----

// Query entities in a list by their props using MongoDB filter syntax.
// The filter object uses dotted paths, e.g.:
//   { "props.stations": { $gte: 50 } }
//   { "props.european-union": true }
//   { "props.opened": { $gte: 1970, $lte: 1990 } }
//
// sortBy is a dotted prop path (e.g. "props.stations"); sortDir is 1 or -1.
// Results include the page info for each entity.
export async function queryByProps(list, filter = {}, { limit = 50, sortBy = null, sortDir = -1 } = {}) {
  const db   = await connectToMongo();
  const page = await db.collection("pages").findOne({ key: list });
  if (!page) return { error: "page_not_found" };

  const match = { list, ...filter };

  const pipeline = [
    { $match: match },
    ...(sortBy ? [{ $sort: { [sortBy]: sortDir } }] : [{ $sort: { name: 1 } }]),
    { $limit: limit },
    { $lookup: { from: "pages", localField: "list", foreignField: "key", as: "pageInfo" } },
    { $unwind: { path: "$pageInfo", preserveNullAndEmptyArrays: true } },
    { $project: {
      name: 1, list: 1, key: 1, icons: 1, link: 1, reference: 1, props: 1, been: 1,
      page: { name: "$pageInfo.name", icon: "$pageInfo.icon", key: "$pageInfo.key" },
    }},
  ];

  const results = await db.collection("entities").aggregate(pipeline).toArray();
  return { page, results };
}

// ---- Semantic search ----

const SEARCH_PROJECTION = {
  name: 1, list: 1, key: 1, icons: 1, link: 1, reference: 1, been: 1,
  score: { $meta: "vectorSearchScore" },
};

const PAGE_LOOKUP = [
  { $lookup: { from: "pages", localField: "list", foreignField: "key", as: "pageInfo" } },
  { $unwind: { path: "$pageInfo", preserveNullAndEmptyArrays: true } },
  { $project: {
    ...SEARCH_PROJECTION,
    score: 1,
    page: { name: "$pageInfo.name", icon: "$pageInfo.icon", key: "$pageInfo.key" },
  }},
];

function vectorSearchStage(queryVector, limit) {
  return {
    $vectorSearch: {
      index:         "wikiEmbeddings",
      path:          "wikiEmbedding",
      queryVector,
      numCandidates: limit * 5,
      limit,
    },
  };
}

export async function searchByVector(queryVector, { listFilter = null, limit = 50 } = {}) {
  const db       = await connectToMongo();
  const pipeline = [vectorSearchStage(queryVector, limit)];
  if (listFilter) pipeline.push({ $match: { list: listFilter } });
  pipeline.push({ $project: SEARCH_PROJECTION }, ...PAGE_LOOKUP);
  return db.collection("entities").aggregate(pipeline).toArray();
}

export async function getSimilarEntities(list, key, { limit = 50 } = {}) {
  const db     = await connectToMongo();
  const source = await db.collection("entities").findOne(
    { list, key },
    { projection: { wikiEmbedding: 1, name: 1 } }
  );

  if (!source)              return { error: "not_found" };
  if (!source.wikiEmbedding) return { error: "no_embedding" };

  const pipeline = [
    vectorSearchStage(source.wikiEmbedding, limit + 1),
    { $project: SEARCH_PROJECTION },
    ...PAGE_LOOKUP,
  ];

  const results  = await db.collection("entities").aggregate(pipeline).toArray();
  const filtered = results.filter(r => r.score < 0.9999).slice(0, limit);
  return { results: filtered };
}

export async function embedText(text) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { data } = await openai.embeddings.create({
    model:      "text-embedding-3-small",
    input:      text,
    dimensions: 512,
  });
  return data[0].embedding;
}

// ---- Flags ----

function compressArray(arr) {
  const compressed = [];
  let zeros = 0;
  for (const v of arr) {
    if (v === 0) {
      zeros++;
    } else {
      if (zeros > 0) { compressed.push(0, zeros); zeros = 0; }
      compressed.push(v);
    }
  }
  if (zeros > 0) compressed.push(0, zeros);
  return compressed;
}

export async function getFlagsData() {
  const t0       = Date.now();
  const db       = await connectToMongo();
  const entities = db.collection("entities");
  const pages    = db.collection("pages");

  // Fire all queries in parallel
  const [countryEntities, pagesDocs, pageStatsRaw, cellsRaw] = await Promise.all([

    // Country entities: key, name, flag icon, 2-letter code
    entities
      .find({ list: "countries" }, { projection: { key: 1, name: 1, icons: 1, country: 1 } })
      .toArray(),

    // All page metadata, excluding roadtrip pages (they tag entities from other
    // pages and have no entities of their own)
    pages
      .find({ tags: { $ne: "roadtrip" } }, { projection: { key: 1, name: 1, icon: 1, group: 1 } })
      .toArray(),

    // Per-page stats: total count + been count
    entities.aggregate([
      { $match: { list: { $exists: true } } },
      { $group: {
        _id:   "$list",
        total: { $sum: 1 },
        been:  { $sum: { $cond: [{ $eq: ["$been", true] }, 1, 0] } },
      }},
    ]).toArray(),

    // Per-(page, country) cell counts + been counts in a single pass
    entities.aggregate([
      { $match: { list: { $exists: true } } },
      { $project: {
        list: 1,
        been: 1,
        codes: { $ifNull: ["$countries", ["$country"]] },
      }},
      { $match: { codes: { $ne: null }, "codes.0": { $exists: true } } },
      { $unwind: "$codes" },
      { $match: { codes: { $ne: null, $ne: "" } } },
      { $group: {
        _id:   { list: "$list", code: "$codes" },
        count: { $sum: 1 },
        been:  { $sum: { $cond: [{ $eq: ["$been", true] }, 1, 0] } },
      }},
    ]).toArray(),
  ]);

  // Build lookup maps
  const codeToCountry = new Map();
  for (const c of countryEntities) {
    if (c.country) codeToCountry.set(c.country, c);
  }

  const pageStats = new Map(pageStatsRaw.map(r => [r._id, r]));

  const cellMap = new Map();
  for (const r of cellsRaw) {
    const { list, code } = r._id;
    if (!cellMap.has(list)) cellMap.set(list, new Map());
    cellMap.get(list).set(code, { count: r.count, been: r.been });
  }

  // Compute per-country totals across all pages
  const countryTotals = new Map();
  const countryBeen   = new Map();
  for (const [, codeCounts] of cellMap) {
    for (const [code, { count, been }] of codeCounts) {
      const entity = codeToCountry.get(code);
      if (!entity) continue;
      countryTotals.set(entity.key, (countryTotals.get(entity.key) || 0) + count);
      countryBeen.set(entity.key,   (countryBeen.get(entity.key)   || 0) + been);
    }
  }

  // Sorted countries: descending total count
  const sortedCountries = countryEntities
    .filter(c => c.country && codeToCountry.has(c.country))
    .sort((a, b) => (countryTotals.get(b.key) || 0) - (countryTotals.get(a.key) || 0));

  const countryIndex = new Map(sortedCountries.map((c, i) => [c.country, i]));
  const numCountries = sortedCountries.length;

  // Sorted pages: descending entity count
  const sortedPages = pagesDocs
    .map(p => {
      const stats = pageStats.get(p.key) || { total: 0, been: 0 };
      return {
        key:   p.key,
        name:  p.name,
        icon:  p.icon || "",
        group: p.group,
        count: stats.total,
        been:  stats.total > 0 ? +(stats.been / stats.total).toFixed(3) : 0,
      };
    })
    .sort((a, b) => b.count - a.count);

  // Compressed data matrix
  const data = {};
  for (const page of sortedPages) {
    const codeCounts = cellMap.get(page.key) || new Map();
    const row = new Array(numCountries).fill(0);
    for (const [code, { count }] of codeCounts) {
      const idx = countryIndex.get(code);
      if (idx !== undefined) row[idx] = count;
    }
    data[page.key] = compressArray(row).join(",");
  }

  // Grand total
  let totalCount = 0;
  for (const [, stats] of pageStats) totalCount += stats.total;

  return {
    queryTimeMs: Date.now() - t0,
    countries: sortedCountries.map(c => {
      const total = countryTotals.get(c.key) || 0;
      const been  = countryBeen.get(c.key)   || 0;
      return {
        been:    total > 0 ? +(been / total).toFixed(3) : 0,
        count:   total,
        country: c.country,
        icon:    c.icons?.[0] || "",
        key:     c.key,
        name:    c.name,
      };
    }),
    data,
    pages: sortedPages.map(({ group, ...p }) => group ? { ...p, group } : p),
    totalCount,
  };
}

// ---- Auth ----

export async function findAccount(username) {
  const db = await connectToMongo();
  return db.collection("accounts").findOne({ username, disabled: false });
}

export async function findSession(sessionTokenHash) {
  const db = await connectToMongo();
  return db.collection("sessions").findOne({ sessionTokenHash, revokedAt: null });
}

export async function createSession({ accountId, sessionTokenHash, label, ip, userAgent }) {
  const db  = await connectToMongo();
  const now = new Date();
  await db.collection("sessions").insertOne({
    accountId,
    sessionTokenHash,
    createdAt:   now,
    lastSeenAt:  now,
    revokedAt:   null,
    label:       label || null,
    ip:          ip || null,
    userAgent:   userAgent || null,
  });
}

export async function touchSession(sessionTokenHash) {
  const db = await connectToMongo();
  db.collection("sessions")
    .updateOne({ sessionTokenHash }, { $set: { lastSeenAt: new Date() } })
    .catch(() => {});
}

export async function revokeSession(sessionTokenHash) {
  const db = await connectToMongo();
  await db.collection("sessions").updateOne(
    { sessionTokenHash },
    { $set: { revokedAt: new Date() } }
  );
}

// ---- Imagine ----

// Returns all prompts, optionally filtered by category.
// category="new" returns the 80 prompts with the most recently created images.
export async function getPrompts({ category } = {}) {
  const db = await connectToMongo();

  if (category === "new") {
    // Collect most-recently-imaged prompt IDs (deduped, ordered by latest createdAt)
    const recentImages = await db.collection("images")
      .find({ project: "imagine" })
      .project({ _id: 0, promptId: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();

    const seen = new Set();
    const recentIds = [];
    for (const img of recentImages) {
      if (!seen.has(img.promptId)) {
        seen.add(img.promptId);
        recentIds.push(img.promptId);
        if (recentIds.length === 80) break;
      }
    }

    if (recentIds.length === 0) return [];

    const prompts = await db.collection("prompts")
      .find({ id: { $in: recentIds } })
      .project({ _id: 0, id: 1, name: 1, emoji: 1, categories: 1, prompt: 1, outtakes: 1 })
      .toArray();

    const promptMap = Object.fromEntries(prompts.map(p => [p.id, p]));
    return recentIds.map(id => promptMap[id]).filter(Boolean);
  }

  const filter = category ? { categories: category } : {};
  return db.collection("prompts")
    .find(filter)
    .project({ _id: 0, id: 1, name: 1, emoji: 1, categories: 1, prompt: 1, outtakes: 1 })
    .sort({ id: 1 })
    .toArray();
}

// Returns a single prompt with its image records and prev/next IDs within a category.
export async function getPrompt(id, { category } = {}) {
  const db = await connectToMongo();

  const [prompt, images] = await Promise.all([
    db.collection("prompts").findOne({ id }, { projection: { _id: 0 } }),
    db.collection("images")
      .find({ project: "imagine", promptId: id })
      .project({ _id: 0, model: 1, style: 1, createdAt: 1, rating: 1 })
      .sort({ createdAt: 1 })
      .toArray(),
  ]);

  if (!prompt) return null;

  const { prevId, nextId } = await getImagineNeighbors(id, category, db);
  return { prompt, images, prevId, nextId };
}

async function getImagineNeighbors(id, category, db) {
  if (!category) return { prevId: null, nextId: null };

  let ids;

  if (category === "new") {
    const recentImages = await db.collection("images")
      .find({ project: "imagine" })
      .project({ _id: 0, promptId: 1 })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();

    const seen = new Set();
    ids = [];
    for (const img of recentImages) {
      if (!seen.has(img.promptId)) {
        seen.add(img.promptId);
        ids.push(img.promptId);
        if (ids.length === 80) break;
      }
    }
  } else {
    const prompts = await db.collection("prompts")
      .find({ categories: category })
      .project({ _id: 0, id: 1 })
      .sort({ id: 1 })
      .toArray();
    ids = prompts.map(p => p.id);
  }

  const idx = ids.indexOf(id);
  if (idx === -1) return { prevId: null, nextId: null };

  return {
    prevId: ids[(idx - 1 + ids.length) % ids.length],
    nextId: ids[(idx + 1) % ids.length],
  };
}

// Returns distinct model slugs present in the imagine images collection.
export async function getImagineModels() {
  const db = await connectToMongo();
  const models = await db.collection("images").distinct("model", { project: "imagine" });
  return models.sort();
}

// Returns image records for imagine, optionally filtered by model and/or style.
export async function getImagineImages({ model, style } = {}) {
  const db = await connectToMongo();
  const filter = { project: "imagine" };
  if (model) filter.model = model;
  if (style) filter.style = style;

  return db.collection("images")
    .find(filter)
    .project({ _id: 0, model: 1, promptId: 1, style: 1, createdAt: 1, rating: 1 })
    .sort({ promptId: 1, model: 1, style: 1 })
    .toArray();
}

// Sets or clears the rating (1–5) on a single imagine image record.
// Pass rating=null or rating=0 to clear.
export async function rateImagineImage(promptId, model, style, rating) {
  const db = await connectToMongo();
  const update = (rating && rating >= 1 && rating <= 5)
    ? { $set: { rating: Number(rating), updatedAt: new Date() } }
    : { $unset: { rating: "" }, $set: { updatedAt: new Date() } };

  const result = await db.collection("images").findOneAndUpdate(
    { project: "imagine", promptId, model, style },
    update,
    { returnDocument: "after" }
  );
  return result?.value ?? result ?? null;
}

// Removes a single imagine image record so it will be regenerated on the next run.
export async function deleteImagineImage(promptId, model, style) {
  const db = await connectToMongo();
  const result = await db.collection("images").findOneAndDelete(
    { project: "imagine", promptId, model, style }
  );
  return result?.value ?? result ?? null;
}

// ---- Animals ----

// Returns image records for animals, optionally filtered by artistId and/or style.
export async function getAnimalsImages({ artistId, style } = {}) {
  const db = await connectToMongo();
  const filter = { project: "animals" };
  if (artistId) filter.artistId = artistId;
  if (style) filter.style = style;

  return db.collection("images")
    .find(filter)
    .project({ _id: 0, artistId: 1, animal: 1, style: 1, createdAt: 1 })
    .sort({ artistId: 1, animal: 1, style: 1 })
    .toArray();
}
