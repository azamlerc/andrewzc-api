// Database layer — all MongoDB and OpenAI operations.
// No HTTP, no Express. Each function takes plain arguments and returns plain objects.

import { MongoClient } from "mongodb";
import OpenAI from "openai";
import { makeKeyFromPageTags } from "./utils.js";

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
  await db.collection("entities").createIndex({ list: 1, key: 1 }, { unique: true });
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

export async function getPageWithEntities(key) {
  const db       = await connectToMongo();
  const pages    = db.collection("pages");
  const entities = db.collection("entities");

  const page = await pages.findOne({ key });
  if (!page) return null;

  let docs;
  if (page.propertyOf) {
    docs = await entities
      .find({ list: page.propertyOf, [`props.${key}`]: { $exists: true } })
      .sort({ name: 1, key: 1 })
      .toArray();
  } else {
    docs = await entities
      .find({ list: key })
      .sort({ name: 1, key: 1 })
      .toArray();
  }

  return { page, entities: docs };
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
