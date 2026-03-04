// search.js — natural language search router.
// Sends the user's query to OpenAI with function calling, then executes
// whichever function(s) the model selects against the database.

import OpenAI from "openai";
import {
  getPageSummaries,
  getEntitiesByFilter,
  getEntitiesNearPoint,
  getEntitiesNearEntity,
  searchByName,
  searchByVector,
  getSimilarEntities,
  embedText,
} from "./database.js";


// ---- Page summaries cache ----
// Fetched once and reused for the lifetime of the process.

let pageSummariesCache = null;

async function getPageContext() {
  if (!pageSummariesCache) {
    pageSummariesCache = await getPageSummaries();
  }
  return pageSummariesCache.map(p =>
    p.description ? `${p.key}: ${p.name}. ${p.description}` : `${p.key}: ${p.name}`
  ).join("\n");
}

// ---- Tool definitions ----

const TOOLS = [
  {
    type: "function",
    function: {
      name: "filterEntities",
      description: "Find entities matching a MongoDB filter. Use this for queries that combine a list with a country, city, or other field — e.g. 'canals in Belgium', 'airports in Paris', 'trams in Germany'. The filter is a MongoDB query object. Common fields: list (string), country (2-letter code), countries (array of 2-letter codes), city (string).",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            description: "MongoDB filter object, e.g. { \"list\": \"canals\", \"country\": \"BE\" }",
          },
          sortBy: {
            type: "string",
            description: "Field to sort by, e.g. \"name\"",
          },
          sortDir: {
            type: "number",
            enum: [1, -1],
            description: "1 for ascending, -1 for descending",
          },
          limit: { type: "number", description: "Max results, default 50" },
        },
        required: ["filter"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "searchByName",
      description: "Find entities whose name contains a search string. Use for queries like 'stations called Central', 'metro named after a person', or when looking for a specific named thing.",
      parameters: {
        type: "object",
        properties: {
          query:  { type: "string", description: "Name substring to search for" },
          list:   { type: "string", description: "Optional list key to restrict search" },
          limit:  { type: "number", description: "Max results, default 50" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "searchByMeaning",
      description: "Semantic/vector search — find entities conceptually related to a query. Use for open-ended or descriptive queries like 'historic railways', 'underground stations with unusual architecture', 'cities known for canals'. Search across ALL lists unless the user explicitly restricts to one — cross-list results are valuable and expected.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language description to search for" },
          list:  { type: "string", description: "Optional list key to restrict search" },
          limit: { type: "number", description: "Max results, default 50" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "findNearbyEntities",
      description: "Find entities geographically near a lat/lon point. Use when the query mentions a specific location by coordinates.",
      parameters: {
        type: "object",
        properties: {
          lat:      { type: "number", description: "Latitude" },
          lon:      { type: "number", description: "Longitude" },
          radiusKm: { type: "number", description: "Search radius in km, default 50" },
          list:     { type: "string", description: "Optional list key to restrict search" },
          limit:    { type: "number", description: "Max results, default 50" },
        },
        required: ["lat", "lon"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "findEntitiesNearEntity",
      description: "Find entities geographically near a known entity. Use for queries like 'things near Berlin Hauptbahnhof', 'what's near the Eiffel Tower metro station', 'stations close to Amsterdam Centraal'.",
      parameters: {
        type: "object",
        properties: {
          list:     { type: "string", description: "List key of the reference entity" },
          key:      { type: "string", description: "Key of the reference entity" },
          radiusKm: { type: "number", description: "Search radius in km, default 50" },
          limit:    { type: "number", description: "Max results, default 50" },
        },
        required: ["list", "key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "findSimilarEntities",
      description: "Find entities semantically similar to a known entity using its Wikipedia embedding. Use for queries like 'things like the Paris Metro', 'similar to Amsterdam', 'more like this'.",
      parameters: {
        type: "object",
        properties: {
          list:  { type: "string", description: "List key of the reference entity" },
          key:   { type: "string", description: "Key of the reference entity" },
          limit: { type: "number", description: "Max results, default 50" },
        },
        required: ["list", "key"],
      },
    },
  },
];

// ---- Tool execution ----

async function executeTool(name, args) {
  switch (name) {
    case "filterEntities": {
      // The model may return the filter fields flat or nested under "filter".
      const { sortBy, sortDir, limit, filter, ...rest } = args;
      const resolvedFilter = filter ?? rest;
      return getEntitiesByFilter(resolvedFilter, {
        sortBy:  sortBy  ?? null,
        sortDir: sortDir ?? 1,
        limit:   limit   ?? 50,
      });
    }

    case "searchByName":
      return searchByName(args.query, {
        listFilter: args.list  ?? null,
        limit:      args.limit ?? 50,
      });

    case "searchByMeaning": {
      const vector = await embedText(args.query);
      return searchByVector(vector, {
        listFilter: args.list  ?? null,
        limit:      args.limit ?? 50,
      });
    }

    case "findNearbyEntities":
      return getEntitiesNearPoint(args.lon, args.lat, {
        radiusKm:   args.radiusKm ?? 50,
        listFilter: args.list     ?? null,
        limit:      args.limit    ?? 50,
      });

    case "findEntitiesNearEntity": {
      const result = await getEntitiesNearEntity(args.list, args.key, {
        radiusKm: args.radiusKm ?? 50,
        limit:    args.limit    ?? 50,
      });
      if (result.error) return { error: result.error };
      return result.results;
    }

    case "findSimilarEntities": {
      const result = await getSimilarEntities(args.list, args.key, {
        limit: args.limit ?? 50,
      });
      if (result.error) return { error: result.error };
      return result.results;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- Main export ----

export async function naturalLanguageSearch(query) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const pageContext = await getPageContext();

  const systemPrompt = `You are a search assistant for a personal knowledge database.
The database contains lists of things the owner has visited, collected, or catalogued.
When given a query, choose the most appropriate function to call.

Available lists (key: name. description):
${pageContext}

Guidelines:
- Use the list key exactly as shown above — never guess or modify it.
- For country filters use 2-letter ISO codes (BE, FR, DE, GB, US etc).
- For city filters use the city display name as it would appear in the data (e.g. "Paris", "New York", "Den Haag").
- Prefer filterEntities for queries that combine a list + location.
- Prefer searchByMeaning for open-ended descriptive queries. Do NOT add a list filter to searchByMeaning unless the user explicitly names a specific list.
- Prefer searchByName when the user is looking for something by its name.
- If the query is ambiguous, prefer filterEntities or searchByMeaning.`;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.chat.completions.create({
    model:      "gpt-4o-mini",
    messages:   [
      { role: "system",  content: systemPrompt },
      { role: "user",    content: query },
    ],
    tools:       TOOLS,
    tool_choice: "required",
  });

  const message = response.choices[0].message;

  // Execute all tool calls (usually just one, occasionally two)
  const toolCalls = message.tool_calls ?? [];
  if (toolCalls.length === 0) {
    return { query, results: [], tool: null };
  }

  const calls = await Promise.all(
    toolCalls.map(async (tc) => {
      const args    = JSON.parse(tc.function.arguments);
      // Ensure filter is a plain object, not a string
      if (args.filter && typeof args.filter === "string") {
        args.filter = JSON.parse(args.filter);
      }
      const results = await executeTool(tc.function.name, args);
      return { tool: tc.function.name, args, results };
    })
  );

  // Merge results if multiple tools were called, dedupe by list+key
  const seen   = new Set();
  const merged = [];
  for (const { results } of calls) {
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      const id = `${r.list}::${r.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(r);
    }
  }

  return {
    query,
    tool:  calls.length === 1 ? calls[0].tool : calls.map(c => c.tool),
    args:  calls.length === 1 ? calls[0].args : calls.map(c => c.args),
    results: merged,
  };
}
