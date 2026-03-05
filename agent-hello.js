// agent-hello.js — bot definition for hello.andrewzc.net
// Personal travel/geography bot backed by the andrewzc MongoDB database.

import {
  getEntity,
  getPageSummaries,
  getEntitiesByFilter,
  getEntitiesNearPoint,
  getEntitiesNearEntity,
  searchByName,
  searchByVector,
  getSimilarEntities,
  queryByProps,
  embedText,
} from "./database.js";

const CONTEXT_RAW = "https://raw.githubusercontent.com/azamlerc/hello-context/main";

// ---- Strip internal fields from results ----

function strip(doc) {
  if (!doc) return doc;
  const { _id, wikiEmbedding, enrichedAt, __isNew, ...rest } = doc;
  return rest;
}

function stripKeepSummary(doc) {
  if (!doc) return doc;
  const { _id, wikiEmbedding, enrichedAt, ...rest } = doc;
  return rest;
}

// ---- Page summaries cache (injected into tool descriptions) ----

let pageSummariesCache = null;

async function getPageContext() {
  if (!pageSummariesCache) {
    pageSummariesCache = await getPageSummaries();
  }
  return pageSummariesCache
    .map(p => p.description ? `${p.key}: ${p.name}. ${p.description}` : `${p.key}: ${p.name}`)
    .join("\n");
}

// ---- Tool definitions ----

function buildTools(pageContext) {
  return [
    {
      name: "getEntity",
      description: "Fetch the full record for a single known entity including wikiSummary, caption, images, notes, and props. Use when you need full detail about a specific place.",
      input_schema: {
        type: "object",
        properties: {
          list: { type: "string", description: "The list key, e.g. 'confluence', 'metros', 'tripoints'" },
          key:  { type: "string", description: "The entity key, e.g. 'paris-metro', 'alizava'" },
        },
        required: ["list", "key"],
      },
    },
    {
      name: "filterEntities",
      description: `Find entities matching a filter. Common fields: list (string), country (ISO 2-letter), city (string), been (boolean), section (done/taken/visited/want).

Available lists:\n${pageContext}`,
      input_schema: {
        type: "object",
        properties: {
          filter:  { type: "object", description: "MongoDB-style filter, e.g. { list: 'metros', section: 'done', country: 'FR' }" },
          sortBy:  { type: "string" },
          sortDir: { type: "number", enum: [1, -1] },
          limit:   { type: "number" },
        },
        required: ["filter"],
      },
    },
    {
      name: "searchByName",
      description: "Find entities whose name contains a string.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          list:  { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
    {
      name: "searchByMeaning",
      description: "Semantic search — find entities conceptually related to a query. Use for open-ended or descriptive questions.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          list:  { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
    {
      name: "findNearbyEntities",
      description: "Find entities near a location. Use your own knowledge to supply lat/lon for named places.",
      input_schema: {
        type: "object",
        properties: {
          lat:      { type: "number" },
          lon:      { type: "number" },
          radiusKm: { type: "number" },
          list:     { type: "string" },
          limit:    { type: "number" },
        },
        required: ["lat", "lon"],
      },
    },
    {
      name: "findSimilarEntities",
      description: "Find entities semantically similar to a known entity.",
      input_schema: {
        type: "object",
        properties: {
          list:  { type: "string" },
          key:   { type: "string" },
          limit: { type: "number" },
        },
        required: ["list", "key"],
      },
    },
    {
      name: "queryByProps",
      description: "Filter entities in a list by their props fields. Use for structured queries like 'metros with 100+ stations'.",
      input_schema: {
        type: "object",
        properties: {
          list:    { type: "string" },
          filter:  { type: "object" },
          sortBy:  { type: "string" },
          sortDir: { type: "number", enum: [1, -1] },
          limit:   { type: "number" },
        },
        required: ["list", "filter"],
      },
    },
  ];
}

// ---- Tool execution ----

async function executeTool(name, input) {
  switch (name) {
    case "getEntity": {
      const doc = await getEntity(input.list, input.key);
      if (!doc) return { error: "not_found" };
      return stripKeepSummary(doc);
    }
    case "filterEntities": {
      const { filter, sortBy, sortDir, limit, ...rest } = input;
      const results = await getEntitiesByFilter(filter ?? rest, {
        sortBy: sortBy ?? null, sortDir: sortDir ?? 1, limit: limit ?? 50,
      });
      return results.map(strip);
    }
    case "searchByName": {
      const results = await searchByName(input.query, {
        listFilter: input.list ?? null, limit: input.limit ?? 50,
      });
      return results.map(strip);
    }
    case "searchByMeaning": {
      const vector  = await embedText(input.query);
      const results = await searchByVector(vector, {
        listFilter: input.list ?? null, limit: input.limit ?? 50,
      });
      return results.map(strip);
    }
    case "findNearbyEntities": {
      const results = await getEntitiesNearPoint(input.lon, input.lat, {
        radiusKm: input.radiusKm ?? 50, listFilter: input.list ?? null, limit: input.limit ?? 50,
      });
      return results.map(strip);
    }
    case "findSimilarEntities": {
      const result = await getSimilarEntities(input.list, input.key, { limit: input.limit ?? 50 });
      if (result.error) return { error: result.error };
      return result.results.map(strip);
    }
    case "queryByProps": {
      const result = await queryByProps(input.list, input.filter, {
        sortBy: input.sortBy ?? null, sortDir: input.sortDir ?? -1, limit: input.limit ?? 50,
      });
      if (result.error) return { error: result.error };
      return result.results.map(strip);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- Bot definition ----

export const helloBot = {
  name:        "hello",
  contextUrl:  CONTEXT_RAW,
  contextFiles: [
    `${CONTEXT_RAW}/system-prompt.md`,
    `${CONTEXT_RAW}/website-intro.md`,
    `${CONTEXT_RAW}/api-context.md`,
  ],
  assemblePrompt([systemPromptRaw, websiteIntro, apiContext]) {
    return `${systemPromptRaw}

---

## Your travel philosophy (read carefully — this is your voice)

${websiteIntro}

---

## How to query your database

${apiContext}`;
  },
  imageCdnHost:   "images.andrewzc.net",
  getExtraContext: getPageContext,
  buildTools,
  executeTool,
};
