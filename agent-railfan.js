// agent-railfan.js — Railfan, private field-editing bot for Andrew
// Requires admin session — POST /chat/railfan is protected by requireAdminSession.
// All writes go through the same API functions as the admin UI.

import {
  searchByName,
  getEntity,
  getPage,
  updateEntity,
  createEntity,
  enrichEntity,
  updatePage,
  createPage,
} from "./database.js";

const CONTEXT_RAW = "https://raw.githubusercontent.com/azamlerc/railfan-context/main";

// ---- Tool definitions ----

function buildTools() {
  return [
    {
      name: "searchEntities",
      description: "Search for entities by name across all lists, or within a specific list. Always do this first to find the right list and key before making any write.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name to search for" },
          list:  { type: "string", description: "Optional: restrict to a specific list key" },
        },
        required: ["query"],
      },
    },
    {
      name: "getEntity",
      description: "Fetch the full record for a single entity. Use to read current props before merging in a new one.",
      input_schema: {
        type: "object",
        properties: {
          list: { type: "string" },
          key:  { type: "string" },
        },
        required: ["list", "key"],
      },
    },
    {
      name: "updateEntity",
      description: "Update fields on an entity. Sends only the fields you provide — other fields are untouched. To set a prop without losing others, fetch the entity first and merge.",
      input_schema: {
        type: "object",
        properties: {
          list:   { type: "string", description: "List key, e.g. 'stations'" },
          key:    { type: "string", description: "Entity key, e.g. 'flushing-avenue'" },
          fields: { type: "object", description: "Fields to set, e.g. { been: true } or { section: 'done' } or { props: { curved: true } }" },
        },
        required: ["list", "key", "fields"],
      },
    },
    {
      name: "createEntity",
      description: "Create a new entity in a list. Include name and link (Wikipedia URL) at minimum. Always follow with enrichEntity.",
      input_schema: {
        type: "object",
        properties: {
          list:   { type: "string" },
          fields: { type: "object", description: "Entity fields — must include 'name', should include 'link'" },
        },
        required: ["list", "fields"],
      },
    },
    {
      name: "enrichEntity",
      description: "Run the enrichment cascade on an entity: find Wikipedia link (if missing), extract coords, find nearest city, set reference. Always call after createEntity.",
      input_schema: {
        type: "object",
        properties: {
          list: { type: "string" },
          key:  { type: "string" },
        },
        required: ["list", "key"],
      },
    },
    {
      name: "updatePage",
      description: "Update fields on a page (list metadata). Use for changing size, icon, tags, etc.",
      input_schema: {
        type: "object",
        properties: {
          key:    { type: "string", description: "Page key, e.g. 'hamburgers'" },
          fields: { type: "object", description: "Fields to set, e.g. { size: 'medium' } or { icon: '☕️' }" },
        },
        required: ["key", "fields"],
      },
    },
    {
      name: "createPage",
      description: "Create a new list page.",
      input_schema: {
        type: "object",
        properties: {
          fields: { type: "object", description: "Page fields — must include name, icon, type. Optionally size (default: medium)." },
        },
        required: ["fields"],
      },
    },
  ];
}

// ---- Tool execution ----

function strip(doc) {
  if (!doc) return doc;
  const { _id, wikiEmbedding, enrichedAt, ...rest } = doc;
  return rest;
}

async function executeTool(name, input) {
  switch (name) {
    case "searchEntities": {
      const results = await searchByName(input.query, {
        listFilter: input.list ?? null,
        limit: 20,
      });
      return results.map(r => ({ list: r.list, key: r.key, name: r.name, been: r.been, section: r.section }));
    }

    case "getEntity": {
      const doc = await getEntity(input.list, input.key);
      if (!doc) return { error: "not_found" };
      return strip(doc);
    }

    case "updateEntity": {
      const doc = await updateEntity(input.list, input.key, input.fields);
      if (!doc) return { error: "not_found" };
      return strip(doc);
    }

    case "createEntity": {
      const result = await createEntity(input.list, input.fields);
      if (result.error) return { error: result.error };
      return { key: result.doc.key, ...strip(result.doc) };
    }

    case "enrichEntity": {
      const result = await enrichEntity(input.list, input.key);
      if (result.error) return { error: result.error };
      return { enriched: result.enriched, doc: strip(result.doc) };
    }

    case "updatePage": {
      const doc = await updatePage(input.key, input.fields);
      if (!doc) return { error: "not_found" };
      return doc;
    }

    case "createPage": {
      const result = await createPage(input.fields);
      if (result.error) return { error: result.error };
      return result.doc;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- System prompt ----

let cachedPrompt = null;
let cachedAt     = 0;
const TTL_MS     = 5 * 60 * 1000;

async function loadSystemPrompt() {
  if (cachedPrompt && Date.now() - cachedAt < TTL_MS) return cachedPrompt;

  const [systemPrompt, apiContext, sitemap] = await Promise.all([
    fetch(`${CONTEXT_RAW}/system-prompt.md`).then(r => r.text()),
    fetch(`${CONTEXT_RAW}/api-context.md`).then(r => r.text()),
    fetch(`${CONTEXT_RAW}/sitemap.md`).then(r => r.text()),
  ]);

  cachedPrompt = `${systemPrompt}

---

${apiContext}

---

${sitemap}`;

  cachedAt = Date.now();
  return cachedPrompt;
}

// ---- Bot definition ----

export const railfanBot = {
  name:             "railfan",
  contextUrl:       CONTEXT_RAW,
  imageCdnHost:     null,
  loadSystemPrompt,
  buildTools,
  executeTool,
};
