import cors from "cors";
import express from "express";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const allowlist = [
  "http://localhost",
  "https://andrewzc.net",
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
      .sort({ name: 1 })
      .toArray();

    return res.json({
      "--info--": stripMongoId(pageDoc),
      entities: entityDocs.map(stripMongoId)
    });
  } catch (err) {
    console.error("GET /api/pages/:id failed:", err);
    return res.status(500).json({
      error: "internal_error",
      message: err
    });
  }
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});