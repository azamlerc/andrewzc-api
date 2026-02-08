import cors from "cors";
import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import argon2 from "argon2";
import { MongoClient } from "mongodb";

dotenv.config();

const allowlist = [
  "http://localhost",
  "http://localhost:3000",
  "https://andrewzc.net",
  "https://api.andrewzc.net",
];

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB;

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI in env");
  process.exit(1);
}
if (!DB_NAME) {
  console.error("Missing MONGODB_DB in env");
  process.exit(1);
}
const SESSION_PEPPER = process.env.SESSION_PEPPER;
if (!SESSION_PEPPER) {
  console.error("Missing SESSION_PEPPER in env (used to HMAC session tokens)");
  process.exit(1);
}

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
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
}));

let client;
let db;

async function connectToMongo() {
  if (db) return db;
  client = new MongoClient(MONGODB_URI, {maxPoolSize: 10});
  await client.connect();
  db = client.db(DB_NAME);
  return db;
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function sessionTokenToHash(token) {
  // HMAC prevents a DB leak from being used to validate session tokens.
  return crypto.createHmac("sha256", SESSION_PEPPER).update(token).digest("hex");
}

function makeSessionToken() {
  // 32 bytes => 256 bits of entropy.
  return crypto.randomBytes(32).toString("base64url");
}

async function ensureIndexes() {
  const db = await connectToMongo();
  await db.collection("accounts").createIndex({ username: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ sessionTokenHash: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ accountId: 1 });
  await db.collection("entities").createIndex({ list: 1, key: 1 }, { unique: true });
}

function adminCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  // SameSite=Strict is safest; if you ever embed admin UI cross-site you may need Lax.
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "none",
    path: "/",
    // ~10 years
    maxAge: 1000 * 60 * 60 * 24 * 365 * 10,
  };
}

function cleanError(err) {
  if (!err) return err;
  if (typeof err === "string") return err;
  return err.message || String(err);
}

function stripMongoId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
}

function toTitleCaseWord(w) {
  if (!w) return w;
  const lower = w.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function cityKeyToDisplayName(key) {
  // Convert `den-haag` -> `Den Haag`
  // Heuristic: if last token is 2 letters, treat it as a state/province code and format as ", XX"
  const parts = String(key || "").split("-").filter(Boolean);
  if (parts.length === 0) return "";

  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1);

  if (last.length === 2 && rest.length > 0) {
    const left = rest.map(toTitleCaseWord).join(" ");
    return `${left}, ${last.toUpperCase()}`;
  }

  return parts.map(toTitleCaseWord).join(" ");
}

/*
 async function createAdminAccountOnce() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    console.error("Missing ADMIN_USERNAME or ADMIN_PASSWORD in env");
    process.exit(1);
  }

  const db = await connectToMongo();
  const accounts = db.collection("accounts");

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64MB (KiB)
    timeCost: 2,
    parallelism: 1,
  });

  const now = new Date();

  const existing = await accounts.findOne({ username });
  if (existing) {
    console.log(`Admin account '${username}' already exists. Updating password hash.`);
    await accounts.updateOne(
      { _id: existing._id },
      { $set: { passwordHash, updatedAt: now, roles: ["admin"], disabled: false } }
    );
  } else {
    await accounts.insertOne({
      username,
      passwordHash,
      roles: ["admin"],
      disabled: false,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`Created admin account '${username}'.`);
  }

  console.log("Done. You can now unset ADMIN_PASSWORD and disable CREATE_ADMIN.");
}
*/

async function requireAdminSession(req, res, next) {
  try {
    const raw = req.cookies?.admin_session;
    if (!raw) {
      return res.status(401).json({ error: "unauthorized", message: "Missing admin session" });
    }

    const sessionTokenHash = sessionTokenToHash(raw);

    const db = await connectToMongo();
    const sessions = db.collection("sessions");
    const session = await sessions.findOne({ sessionTokenHash, revokedAt: null });

    if (!session) {
      return res.status(401).json({ error: "unauthorized", message: "Invalid or revoked session" });
    }

    // Optional: touch lastSeenAt (keep it light)
    sessions.updateOne(
      { _id: session._id },
      { $set: { lastSeenAt: new Date() } }
    ).catch(() => {});

    req.admin = { accountId: session.accountId, sessionId: session._id };
    return next();
  } catch (err) {
    console.error("Auth failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
}

// --- Admin auth ---
app.post("/admin/login", async (req, res) => {
  try {
    const { username, password, label } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "bad_request", message: "Missing username or password" });
    }

    const db = await connectToMongo();
    const accounts = db.collection("accounts");
    const sessions = db.collection("sessions");

    const account = await accounts.findOne({ username, disabled: false });
    if (!account) {
      return res.status(401).json({ error: "unauthorized", message: "Invalid credentials" });
    }

    const ok = await argon2.verify(account.passwordHash, password);
    if (!ok) {
      return res.status(401).json({ error: "unauthorized", message: "Invalid credentials" });
    }

    const sessionToken = makeSessionToken();
    const sessionTokenHash = sessionTokenToHash(sessionToken);

    const now = new Date();
    await sessions.insertOne({
      accountId: account._id,
      sessionTokenHash,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
      label: label || null,
      ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
      userAgent: req.headers["user-agent"] || null,
    });

    res.cookie("admin_session", sessionToken, adminCookieOptions());
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /admin/login failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.post("/admin/logout", requireAdminSession, async (req, res) => {
  try {
    const raw = req.cookies?.admin_session;
    const sessionTokenHash = sessionTokenToHash(raw);

    const db = await connectToMongo();
    await db.collection("sessions").updateOne(
      { sessionTokenHash },
      { $set: { revokedAt: new Date() } }
    );

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

    const sessionTokenHash = sessionTokenToHash(raw);
    const db = await connectToMongo();
    const session = await db.collection("sessions").findOne({ sessionTokenHash, revokedAt: null });
    return res.json({ authenticated: !!session });
  } catch (_err) {
    return res.json({ authenticated: false });
  }
});

app.get("/pages/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const db = await connectToMongo();
    const pages = db.collection("pages");
    const entities = db.collection("entities");

    const pageDoc = await pages.findOne({ key: id });

    if (!pageDoc) {
      return res.status(404).json({
        error: "page_not_found",
        message: `No page found for key='${id}'`
      });
    }

    const entityDocs = await entities
      .find({ list: id })
      .sort({ name: 1, key: 1 })
      .toArray();

    return res.json({
      "--info--": stripMongoId(pageDoc),
      entities: entityDocs.map(stripMongoId)
    });
  } catch (err) {
    console.error("GET /pages/:id failed:", err);
    return res.status(500).json({
      error: "internal_error",
      message: err
    });
  }
});

// --- Entities CRUD (single entity by list+key) ---
app.get("/entities/:list/:key", async (req, res) => {
  const list = String(req.params.list || "");
  const key = String(req.params.key || "");
  if (!list || !key) {
    return res.status(400).json({ error: "bad_request", message: "Missing list or key" });
  }

  try {
    const db = await connectToMongo();
    const entities = db.collection("entities");
    const doc = await entities.findOne({ list, key });
    if (!doc) {
      return res.status(404).json({ error: "not_found", message: "Entity not found" });
    }
    return res.json(stripMongoId(doc));
  } catch (err) {
    console.error("GET /entities/:list/:key failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.post("/entities/:list/:key", requireAdminSession, async (req, res) => {
  const list = String(req.params.list || "");
  const key = String(req.params.key || "");
  if (!list || !key) {
    return res.status(400).json({ error: "bad_request", message: "Missing list or key" });
  }

  try {
    const db = await connectToMongo();
    const entities = db.collection("entities");

    const now = new Date();
    const payload = { ...(req.body || {}) };
    // Enforce canonical identifiers
    payload.list = list;
    payload.key = key;
    payload.updatedAt = now;
    if (!payload.createdAt) payload.createdAt = now;

    const existing = await entities.findOne({ list, key });
    if (existing) {
      return res.status(409).json({ error: "conflict", message: "Entity already exists" });
    }

    await entities.insertOne(payload);
    return res.status(201).json(stripMongoId(payload));
  } catch (err) {
    // Duplicate key protection if index exists
    if (err && (err.code === 11000 || String(err).includes("E11000"))) {
      return res.status(409).json({ error: "conflict", message: "Entity already exists" });
    }
    console.error("POST /entities/:list/:key failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

app.put("/entities/:list/:key", requireAdminSession, async (req, res) => {
  const list = String(req.params.list || "");
  const key = String(req.params.key || "");
  if (!list || !key) {
    return res.status(400).json({ error: "bad_request", message: "Missing list or key" });
  }

  try {
    const db = await connectToMongo();
    const entities = db.collection("entities");

    const now = new Date();
    const patch = { ...(req.body || {}) };
    // Prevent changing identifiers
    delete patch._id;
    delete patch.list;
    delete patch.key;

    const result = await entities.findOneAndUpdate(
      { list, key },
      { $set: { ...patch, updatedAt: now } },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({ error: "not_found", message: "Entity not found" });
    }

    return res.json(stripMongoId(result.value));
  } catch (err) {
    console.error("PUT /entities/:list/:key failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// List all pages (thin wrapper around the `pages` collection)
app.get("/pages", async (_req, res) => {
  try {
    const db = await connectToMongo();
    const pages = db.collection("pages");

    const pageDocs = await pages
      .find({})
      .sort({ name: 1, key: 1 })
      .toArray();

    return res.json({
      pages: pageDocs.map(stripMongoId)
    });
  } catch (err) {
    console.error("GET /pages failed:", err);
    return res.status(500).json({
      error: "internal_error",
      message: err
    });
  }
});

// Entities by country code (supports `country: "BE"` and `countries: ["BE", ...]`)
app.get("/countries/:code", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  if (!code) {
    return res.status(400).json({ error: "bad_request", message: "Missing country code" });
  }

  try {
    const db = await connectToMongo();
    const entities = db.collection("entities");

    const query = { $or: [{ country: code }, { countries: code }] };

    const entityDocs = await entities
      .find(query)
      .sort({ name: 1, key: 1 })
      .toArray();

    const all = entityDocs.map(stripMongoId);

    // Hoist the canonical country entity (list === "countries")
    const countryEntityIndex = all.findIndex(e => e.list === "countries");
    const countryEntity = countryEntityIndex >= 0 ? all[countryEntityIndex] : null;

    const rest = countryEntityIndex >= 0
      ? all.filter((_, i) => i !== countryEntityIndex)
      : all;

    return res.json({
      country: countryEntity,
      entities: rest
    });
  } catch (err) {
    console.error("GET /countries/:code failed:", err);
    return res.status(500).json({
      error: "internal_error",
      message: err
    });
  }
});

// Entities by city (key is dashed; data is stored under display name)
app.get("/cities/:key", async (req, res) => {
  const key = String(req.params.key || "");
  const city = cityKeyToDisplayName(key);
  if (!city) {
    return res.status(400).json({ error: "bad_request", message: "Missing city key" });
  }

  try {
    const db = await connectToMongo();
    const entities = db.collection("entities");

    const query = { city };

    const entityDocs = await entities
      .find(query)
      .sort({ name: 1, key: 1 })
      .toArray();

    const all = entityDocs.map(stripMongoId);

    // Hoist the canonical city entity (list === "cities")
    const cityEntityIndex = all.findIndex(e => e.list === "cities");
    const cityEntity = cityEntityIndex >= 0 ? all[cityEntityIndex] : null;

    const rest = cityEntityIndex >= 0
      ? all.filter((_, i) => i !== cityEntityIndex)
      : all;

    return res.json({
      city: cityEntity,
      entities: rest
    });
  } catch (err) {
    console.error("GET /cities/:key failed:", err);
    return res.status(500).json({
      error: "internal_error",
      message: err
    });
  }
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    [
      "andrewzc-api",
      "",
      "GET /healthz",
      "GET /pages",
      "GET /pages/:id",
      "GET /countries/:code",
      "GET /cities/:key",
      "POST /admin/login",
      "POST /admin/logout",
      "GET /admin/me",
      "GET /entities/:list/:key",
      "POST /entities/:list/:key (admin)",
      "PUT /entities/:list/:key (admin)",
    ].join("\n")
  );
});

(async () => {
  try {
    await ensureIndexes();

//    if (process.env.CREATE_ADMIN === "1") {
//      await createAdminAccountOnce();
//      process.exit(0);
//    }

    app.listen(PORT, () => {
      console.log(`API listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
})();
