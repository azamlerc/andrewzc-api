import cors from "cors";
import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import argon2 from "argon2";

import {
  ensureIndexes,
  getPage, getPages, getPageSummaries, getPageWithEntities,
  getEntity, createEntity, updateEntity,
  getEntitiesByCountry, getEntitiesByCity,
  getEntitiesNearPoint, getEntitiesNearEntity,
  searchByName, queryByProps,
  searchByVector, getSimilarEntities, embedText,
  findAccount, findSession, createSession, touchSession, revokeSession,
} from "./database.js";
import { simplify, cityKeyToDisplayName } from "./utils.js";
import { naturalLanguageSearch } from "./search.js";
import { chat, preload } from "./agent.js";
import { helloBot } from "./agent-hello.js";
import { senzaBot } from "./agent-senza.js";

dotenv.config();

// ---- Config ----

const allowlist = [
  "http://localhost",
  "http://localhost:3000",
  "https://andrewzc.net",
  "https://api.andrewzc.net",
];

const PORT           = process.env.PORT || 3000;
const SESSION_PEPPER = process.env.SESSION_PEPPER;

if (!process.env.MONGODB_URI)        { console.error("Missing MONGODB_URI");        process.exit(1); }
if (!process.env.MONGODB_DB)         { console.error("Missing MONGODB_DB");         process.exit(1); }
if (!SESSION_PEPPER)                 { console.error("Missing SESSION_PEPPER");      process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY)  { console.error("Missing ANTHROPIC_API_KEY");  process.exit(1); }

// ---- App setup ----

const app = express();
app.use(express.json());
app.use(cookieParser());
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowlist.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));

// ---- Presentation helpers ----

function cleanError(err) {
  if (!err) return err;
  if (typeof err === "string") return err;
  return err.message || String(err);
}

// Strip internal fields from all responses.
function strip(doc) {
  if (!doc) return doc;
  const { _id, wikiSummary, wikiEmbedding, enrichedAt, __isNew, ...rest } = doc;
  return rest;
}

// Strip internal fields but keep wikiSummary (for single-entity responses).
function stripKeepSummary(doc) {
  if (!doc) return doc;
  const { _id, wikiEmbedding, enrichedAt, ...rest } = doc;
  return rest;
}

function adminCookieOptions() {
  return {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "none",
    path:     "/",
    maxAge:   1000 * 60 * 60 * 24 * 365 * 10,
  };
}

// ---- Auth helpers ----

function sessionTokenToHash(token) {
  return crypto.createHmac("sha256", SESSION_PEPPER).update(token).digest("hex");
}

function makeSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

async function requireAdminSession(req, res, next) {
  try {
    const raw = req.cookies?.admin_session;
    if (!raw) return res.status(401).json({ error: "unauthorized", message: "Missing admin session" });

    const hash    = sessionTokenToHash(raw);
    const session = await findSession(hash);
    if (!session) return res.status(401).json({ error: "unauthorized", message: "Invalid or revoked session" });

    touchSession(hash);
    req.admin = { accountId: session.accountId, sessionId: session._id };
    return next();
  } catch (err) {
    console.error("Auth failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
}

// ---- Admin auth ----

app.post("/admin/login", async (req, res) => {
  try {
    const { username, password, label } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "bad_request", message: "Missing username or password" });
    }

    const account = await findAccount(username);
    if (!account) return res.status(401).json({ error: "unauthorized", message: "Invalid credentials" });

    const ok = await argon2.verify(account.passwordHash, password);
    if (!ok)  return res.status(401).json({ error: "unauthorized", message: "Invalid credentials" });

    const token = makeSessionToken();
    const hash  = sessionTokenToHash(token);

    await createSession({
      accountId:        account._id,
      sessionTokenHash: hash,
      label,
      ip:        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
      userAgent: req.headers["user-agent"] || null,
    });

    res.cookie("admin_session", token, adminCookieOptions());
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /admin/login failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.post("/admin/logout", requireAdminSession, async (req, res) => {
  try {
    const hash = sessionTokenToHash(req.cookies.admin_session);
    await revokeSession(hash);
    res.clearCookie("admin_session", { path: "/" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /admin/logout failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.get("/admin/me", async (req, res) => {
  try {
    const raw = req.cookies?.admin_session;
    if (!raw) return res.json({ authenticated: false });
    const session = await findSession(sessionTokenToHash(raw));
    return res.json({ authenticated: !!session });
  } catch {
    return res.json({ authenticated: false });
  }
});

// ---- Pages ----

app.get("/pages", async (_req, res) => {
  try {
    const pages = await getPages();
    return res.json({ pages: pages.map(strip) });
  } catch (err) {
    console.error("GET /pages failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.get("/pages/summaries", async (_req, res) => {
  try {
    const summaries = await getPageSummaries();
    return res.json({ pages: summaries });
  } catch (err) {
    console.error("GET /pages/summaries failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.get("/pages/:id", async (req, res) => {
  try {
    const result = await getPageWithEntities(req.params.id);
    if (!result) {
      return res.status(404).json({ error: "page_not_found", message: `No page found for key='${req.params.id}'` });
    }
    return res.json({
      "--info--": strip(result.page),
      entities:  result.entities.map(strip),
    });
  } catch (err) {
    console.error("GET /pages/:id failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Entities ----

app.get("/entities", async (req, res) => {
  const nameQuery  = req.query.name   ? String(req.query.name).trim()   : null;
  const searchQuery = req.query.search ? String(req.query.search).trim() : null;
  const listFilter = req.query.list   ? String(req.query.list)          : null;
  const limit      = Math.min(parseInt(req.query.limit) || 50, 50);

  if (nameQuery) {
    try {
      const results = await searchByName(nameQuery, { listFilter, limit });
      return res.json({ name: nameQuery, results: results.map(strip) });
    } catch (err) {
      console.error("GET /entities?name= failed:", err);
      return res.status(500).json({ error: "internal_error", message: cleanError(err) });
    }
  }

  if (searchQuery) {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: "unavailable", message: "Semantic search not configured" });
    }
    try {
      const vector  = await embedText(searchQuery);
      const results = await searchByVector(vector, { listFilter, limit });
      return res.json({ query: searchQuery, results: results.map(strip) });
    } catch (err) {
      console.error("GET /entities?search= failed:", err);
      return res.status(500).json({ error: "internal_error", message: cleanError(err) });
    }
  }

  return res.status(400).json({ error: "bad_request", message: "Missing ?name= or ?search=" });
});

// GET /entities/:list/props?filter=<json>&sortBy=<prop>&sortDir=asc|desc&limit=<n>
app.get("/entities/:list/props", async (req, res) => {
  const { list }   = req.params;
  const limit      = Math.min(parseInt(req.query.limit) || 50, 50);
  const sortBy     = req.query.sortBy  ? String(req.query.sortBy)  : null;
  const sortDir    = req.query.sortDir === "asc" ? 1 : -1;

  let filter = {};
  if (req.query.filter) {
    try { filter = JSON.parse(req.query.filter); }
    catch { return res.status(400).json({ error: "bad_request", message: "Invalid ?filter= JSON" }); }
  }

  try {
    const result = await queryByProps(list, filter, { limit, sortBy, sortDir });
    if (result.error === "page_not_found") {
      return res.status(404).json({ error: "page_not_found", message: `No page found for key='${list}'` });
    }
    return res.json({ list, filter, results: result.results.map(strip) });
  } catch (err) {
    console.error("GET /entities/:list/props failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.get("/entities/:list/:key/similar", async (req, res) => {
  const { list, key } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 50);

  try {
    const result = await getSimilarEntities(list, key, { limit });
    if (result.error === "not_found")    return res.status(404).json({ error: "not_found",    message: "Entity not found" });
    if (result.error === "no_embedding") return res.status(404).json({ error: "not_found",    message: "Entity has no embedding" });
    return res.json({ list, key, results: result.results.map(strip) });
  } catch (err) {
    console.error("GET /entities/:list/:key/similar failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.get("/entities/:list/:key", async (req, res) => {
  const { list, key } = req.params;
  try {
    const doc = await getEntity(list, key);
    if (!doc) return res.status(404).json({ error: "not_found", message: "Entity not found" });
    return res.json(stripKeepSummary(doc));
  } catch (err) {
    console.error("GET /entities/:list/:key failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.post("/entities/:list", requireAdminSession, async (req, res) => {
  const { list } = req.params;
  const payload  = { ...(req.body || {}) };
  delete payload._id;
  delete payload.list;
  delete payload.key;

  try {
    const result = await createEntity(list, payload);
    if (result.error === "page_not_found") return res.status(404).json({ error: "page_not_found", message: `No page found for key='${list}'` });
    if (result.error === "missing_name")   return res.status(400).json({ error: "bad_request",    message: "Missing name" });
    if (result.error === "bad_key")        return res.status(400).json({ error: "bad_request",    message: "Could not derive key" });
    return res.status(201).json(strip(result.doc));
  } catch (err) {
    if (err?.code === 11000 || String(err).includes("E11000")) {
      return res.status(409).json({ error: "conflict", message: "Entity already exists" });
    }
    console.error("POST /entities/:list failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.put("/entities/:list/:key", requireAdminSession, async (req, res) => {
  const { list, key } = req.params;
  const patch = { ...(req.body || {}) };
  delete patch._id;
  delete patch.list;
  delete patch.key;

  try {
    const doc = await updateEntity(list, key, patch);
    if (!doc) return res.status(404).json({ error: "not_found", message: "Entity not found" });
    return res.json(strip(doc));
  } catch (err) {
    console.error("PUT /entities/:list/:key failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Geo search ----

app.get("/entities/nearby", async (req, res) => {
  const lat      = parseFloat(req.query.lat);
  const lon      = parseFloat(req.query.lon);
  const radiusKm = parseFloat(req.query.radius) || 50;
  const listFilter = req.query.list ? String(req.query.list) : null;
  const limit    = Math.min(parseInt(req.query.limit) || 50, 50);

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: "bad_request", message: "Missing or invalid ?lat= and ?lon=" });
  }

  try {
    const results = await getEntitiesNearPoint(lon, lat, { radiusKm, listFilter, limit });
    return res.json({ lat, lon, radiusKm, results: results.map(strip) });
  } catch (err) {
    console.error("GET /entities/nearby failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.get("/entities/:list/:key/nearby", async (req, res) => {
  const { list, key } = req.params;
  const radiusKm = parseFloat(req.query.radius) || 50;
  const limit    = Math.min(parseInt(req.query.limit) || 50, 50);

  try {
    const result = await getEntitiesNearEntity(list, key, { radiusKm, limit });
    if (result.error === "not_found")   return res.status(404).json({ error: "not_found",   message: "Entity not found" });
    if (result.error === "no_location") return res.status(404).json({ error: "not_found",   message: "Entity has no location" });
    return res.json({ list, key, radiusKm, ...result.source, results: result.results.map(strip) });
  } catch (err) {
    console.error("GET /entities/:list/:key/nearby failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Countries / cities ----

app.get("/countries/:code", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  try {
    const result = await getEntitiesByCountry(code);
    return res.json({ country: strip(result.country), entities: result.entities.map(strip) });
  } catch (err) {
    console.error("GET /countries/:code failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.get("/cities/:key", async (req, res) => {
  const city = cityKeyToDisplayName(req.params.key);
  if (!city) return res.status(400).json({ error: "bad_request", message: "Missing city key" });

  try {
    const result = await getEntitiesByCity(city);
    return res.json({ city: strip(result.city), entities: result.entities.map(strip) });
  } catch (err) {
    console.error("GET /cities/:key failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Chat ----

function makeChatHandler(bot) {
  return async (req, res) => {
    const { history, message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "bad_request", message: "Missing message" });
    }
    try {
      const result = await chat(bot, Array.isArray(history) ? history : [], message.trim());
      return res.json(result);
    } catch (err) {
      console.error(`POST /chat/${bot.name} failed:`, err);
      return res.status(500).json({ error: "internal_error", message: cleanError(err) });
    }
  };
}

app.post("/chat/hello",     makeChatHandler(helloBot));
app.post("/chat/senza",     makeChatHandler(senzaBot));
// app.post("/chat/interview", makeChatHandler(interviewBot)); // coming soon

// ---- Natural language search ----

app.post("/search", async (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (!query) return res.status(400).json({ error: "bad_request", message: "Missing query" });

  try {
    const result = await naturalLanguageSearch(query);
    return res.json({ ...result, results: result.results.map(strip) });
  } catch (err) {
    console.error("POST /search failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Wiki search ----

app.get("/wiki", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "bad_request", message: "Missing ?q=" });

  try {
    const params = new URLSearchParams({
      action: "query", list: "search", srsearch: q, format: "json", srlimit: "1",
    });
    const response = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
      headers: { "User-Agent": "andrewzc/1.0 (personal project)" },
    });
    if (!response.ok) return res.status(502).json({ error: "wiki_error", message: "Wikipedia request failed" });

    const json  = await response.json();
    const title = json?.query?.search?.[0]?.title;
    if (!title)  return res.json({ link: null });

    const link = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    return res.json({ link });
  } catch (err) {
    console.error("GET /wiki failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// ---- Index ----

app.get("/", (_req, res) => {
  res.type("text/plain").send([
    "andrewzc-api",
    "",
    "GET  /healthz",
    "GET  /pages",
    "GET  /pages/summaries",
    "GET  /pages/:id",
    "GET  /countries/:code",
    "GET  /cities/:key",
    "POST /admin/login",
    "POST /admin/logout",
    "GET  /admin/me",
    "GET  /entities?search=<query>",
    "GET  /entities/nearby?lat=&lon=&radius=&list=&limit=",
    "GET  /entities/:list/props?filter=<json>&sortBy=&sortDir=&limit=",
    "GET  /entities/:list/:key",
      "GET  /entities/:list/:key/nearby?radius=&limit=",
      "GET  /entities/:list/:key/similar",
    "POST /entities/:list          (admin)",
    "PUT  /entities/:list/:key     (admin)",
    "POST /chat/hello",
    "POST /chat/senza",
    "POST /search",
    "GET  /wiki",
  ].join("\n"));
});

// ---- Start ----

(async () => {
  try {
    await ensureIndexes();
    await Promise.all([
      preload(helloBot),
      preload(senzaBot),
    ]);
    app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
})();
