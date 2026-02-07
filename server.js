import cors from "cors";
import express from "express";
import dotenv from "dotenv";
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

const app = express();

app.use(express.json());
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowlist.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
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
    ].join("\n")
  );
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
