// chat.js — conversational agent for hello.andrewzc.net
// Uses the Anthropic API with tool use, calling database.js directly.
// OpenAI is used only for embeddings (to match existing vector index).

import Anthropic from "@anthropic-ai/sdk";
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

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;
const CONTEXT_RAW = "https://raw.githubusercontent.com/azamlerc/hello-context/main";

// ---- Context loading ----
// Fetched once at startup and cached for the lifetime of the process.

let contextCache = null;

async function loadContext() {
  if (contextCache) return contextCache;

  const [systemPromptRaw, websiteIntro, apiContext] = await Promise.all([
    fetch(`${CONTEXT_RAW}/system-prompt.md`).then(r => r.text()),
    fetch(`${CONTEXT_RAW}/website-intro.md`).then(r => r.text()),
    fetch(`${CONTEXT_RAW}/api-context.md`).then(r => r.text()),
  ]);

  // Inject the context files into the system prompt
  const systemPrompt = `${systemPromptRaw}

---

## Your travel philosophy (read carefully — this is your voice)

${websiteIntro}

---

## How to query your database

${apiContext}`;

  contextCache = systemPrompt;
  return contextCache;
}

// ---- Page summaries cache ----
// Used in tool descriptions so Claude knows what lists exist.

let pageSummariesCache = null;

async function getPageContext() {
  if (!pageSummariesCache) {
    pageSummariesCache = await getPageSummaries();
  }
  return pageSummariesCache
    .map(p => p.description ? `${p.key}: ${p.name}. ${p.description}` : `${p.key}: ${p.name}`)
    .join("\n");
}

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

// ---- Tool definitions ----

function buildTools(pageContext) {
  return [
    {
      name: "getEntity",
      description: "Fetch the full record for a single known entity including wikiSummary, caption, images, notes, and props. Use when you need full detail about a specific place — to check been status, read a travel caption, or show photos.",
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
      description: `Find entities matching a filter. Use for queries combining a list with country, city, been status, or section. Common fields: list (string), country (ISO 2-letter), city (string), been (boolean), section (done/taken/visited/want).

Available lists:\n${pageContext}`,
      input_schema: {
        type: "object",
        properties: {
          filter:  { type: "object", description: "MongoDB-style filter, e.g. { list: 'metros', section: 'done', country: 'FR' }" },
          sortBy:  { type: "string", description: "Field to sort by, e.g. 'name'" },
          sortDir: { type: "number", enum: [1, -1], description: "1 ascending, -1 descending" },
          limit:   { type: "number", description: "Max results (default 50)" },
        },
        required: ["filter"],
      },
    },
    {
      name: "searchByName",
      description: "Find entities whose name contains a string. Use when looking for a specific named place.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name substring to search for" },
          list:  { type: "string", description: "Optional list key to restrict search" },
          limit: { type: "number", description: "Max results (default 50)" },
        },
        required: ["query"],
      },
    },
    {
      name: "searchByMeaning",
      description: "Semantic search — find entities conceptually related to a query. Use for open-ended or descriptive questions. Search across all lists unless a specific one is requested.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language description" },
          list:  { type: "string", description: "Optional list key to restrict search" },
          limit: { type: "number", description: "Max results (default 50)" },
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
          lat:      { type: "number", description: "Latitude" },
          lon:      { type: "number", description: "Longitude" },
          radiusKm: { type: "number", description: "Search radius in km (default 50)" },
          list:     { type: "string", description: "Optional list key to restrict search" },
          limit:    { type: "number", description: "Max results (default 50)" },
        },
        required: ["lat", "lon"],
      },
    },
    {
      name: "findSimilarEntities",
      description: "Find entities semantically similar to a known entity using its Wikipedia embedding.",
      input_schema: {
        type: "object",
        properties: {
          list:  { type: "string", description: "List key of the reference entity" },
          key:   { type: "string", description: "Key of the reference entity" },
          limit: { type: "number", description: "Max results (default 50)" },
        },
        required: ["list", "key"],
      },
    },
    {
      name: "queryByProps",
      description: "Filter entities in a list by their props fields. Use for structured queries like 'metros with 100+ stations' or 'countries in the Schengen area'.",
      input_schema: {
        type: "object",
        properties: {
          list:    { type: "string", description: "List key, e.g. 'metros', 'countries'" },
          filter:  { type: "object", description: "Props filter using dotted paths, e.g. { 'props.stations': { '$gte': 50 } }" },
          sortBy:  { type: "string", description: "Field to sort by, e.g. 'props.stations'" },
          sortDir: { type: "number", enum: [1, -1], description: "1 ascending, -1 descending" },
          limit:   { type: "number", description: "Max results (default 50)" },
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
      const resolvedFilter = filter ?? rest;
      const results = await getEntitiesByFilter(resolvedFilter, {
        sortBy:  sortBy  ?? null,
        sortDir: sortDir ?? 1,
        limit:   limit   ?? 50,
      });
      return results.map(strip);
    }

    case "searchByName": {
      const results = await searchByName(input.query, {
        listFilter: input.list  ?? null,
        limit:      input.limit ?? 50,
      });
      return results.map(strip);
    }

    case "searchByMeaning": {
      const vector  = await embedText(input.query);
      const results = await searchByVector(vector, {
        listFilter: input.list  ?? null,
        limit:      input.limit ?? 50,
      });
      return results.map(strip);
    }

    case "findNearbyEntities": {
      const results = await getEntitiesNearPoint(input.lon, input.lat, {
        radiusKm:   input.radiusKm ?? 50,
        listFilter: input.list     ?? null,
        limit:      input.limit    ?? 50,
      });
      return results.map(strip);
    }

    case "findSimilarEntities": {
      const result = await getSimilarEntities(input.list, input.key, {
        limit: input.limit ?? 50,
      });
      if (result.error) return { error: result.error };
      return result.results.map(strip);
    }

    case "queryByProps": {
      const result = await queryByProps(input.list, input.filter, {
        sortBy:  input.sortBy  ?? null,
        sortDir: input.sortDir ?? -1,
        limit:   input.limit   ?? 50,
      });
      if (result.error) return { error: result.error };
      return result.results.map(strip);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- Main chat function ----
// Takes a conversation history (array of {role, content} messages) and
// returns the assistant's response as a string.
//
// The caller is responsible for maintaining history between turns:
//   history = []
//   response1 = await chat(history, "Hi!")
//   history.push({ role: "user", content: "Hi!" }, { role: "assistant", content: response1 })
//   response2 = await chat(history, "What metros have you completed?")
//   ...

export async function chat(history, userMessage) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const [systemPrompt, pageContext] = await Promise.all([
    loadContext(),
    getPageContext(),
  ]);

  const tools   = buildTools(pageContext);
  const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages = [
    ...history,
    { role: "user", content: userMessage },
  ];

  // Agentic loop — keep going until Claude stops calling tools
  while (true) {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      tools,
      messages,
    });

    // Accumulate this response into the message history
    messages.push({ role: "assistant", content: response.content });

    // If Claude is done (no tool calls), return the text response
    if (response.stop_reason === "end_turn") {
      return response.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");
    }

    // Execute all tool calls and feed results back
    if (response.stop_reason === "tool_use") {
      const toolResults = await Promise.all(
        response.content
          .filter(b => b.type === "tool_use")
          .map(async (toolUse) => {
            let result;
            try {
              result = await executeTool(toolUse.name, toolUse.input);
            } catch (err) {
              result = { error: String(err.message) };
            }
            return {
              type:        "tool_result",
              tool_use_id: toolUse.id,
              content:     JSON.stringify(result),
            };
          })
      );

      messages.push({ role: "user", content: toolResults });
      // Loop continues — Claude will process the tool results
    }
  }
}

// ---- Context preload ----
// Call this at server startup so the first request isn't slow.

export async function preloadContext() {
  await Promise.all([loadContext(), getPageContext()]);
  console.log("Chat context loaded");
}
