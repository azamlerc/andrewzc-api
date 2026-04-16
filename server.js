import cors from "cors";
import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";

import { ensureIndexes } from "./database.js";
import { authRouter, requireAdminSession } from "./routes/auth.js";
import { pagesRouter } from "./routes/pages.js";
import { entitiesRouter } from "./routes/entities.js";
import { lookupRouter } from "./routes/lookup.js";
import { chatRouter, preloadChats } from "./routes/chat.js";
import { agentsRouter } from "./routes/agents.js";
import { imagineRouter } from "./routes/imagine.js";
import { animalsRouter } from "./routes/animals.js";
import { initScheduler } from "./agents/scheduler.js";

dotenv.config();

// ---- Env guards ----

if (!process.env.MONGODB_URI)       { console.error("Missing MONGODB_URI");       process.exit(1); }
if (!process.env.MONGODB_DB)        { console.error("Missing MONGODB_DB");        process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.error("Missing ANTHROPIC_API_KEY"); process.exit(1); }
if (!process.env.SESSION_PEPPER)    { console.error("Missing SESSION_PEPPER");    process.exit(1); }

// ---- App ----

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.use(cors({
  origin: (origin, cb) => {
    const allowlist = [
      "http://localhost",
      "http://localhost:3000",
      "https://andrewzc.net",
      "https://api.andrewzc.net",
    ];
    if (!origin || allowlist.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));

// ---- Routes ----

app.use("/admin",    authRouter);
app.use("/pages",    pagesRouter);
app.use("/entities", entitiesRouter);
app.use("/imagine",  imagineRouter);
app.use("/animals",  animalsRouter);
app.use("/",         lookupRouter);   // /flags, /countries, /cities, /trips, /artists, /search, /coords, /wiki
app.use("/chat",     chatRouter);
app.use("/agents",   requireAdminSession, agentsRouter);

// ---- Index ----

app.get("/", (_req, res) => {
  res.type("text/plain").send([
    "andrewzc-api",
    "",
    "GET  /healthz",
    "GET  /pages",
    "GET  /pages/summaries",
    "GET  /pages/:id",
    "GET  /pages/:id/entities",
    "POST /pages                       (admin)",
    "PUT  /pages/:id                   (admin)",
    "POST /admin/login",
    "POST /admin/logout",
    "GET  /admin/me",
    "GET  /flags",
    "GET  /countries/:code",
    "GET  /cities/:key",
    "GET  /trips/:key",
    "GET  /artists/:key",
    "GET  /entities?name=&list=&limit=",
    "GET  /entities?search=&list=&limit=",
    "POST /entities/bingo",
    "GET  /entities/nearby?lat=&lon=&radius=&list=&limit=",
    "GET  /entities/:list/props?filter=&sortBy=&sortDir=&limit=",
    "GET  /entities/:list/:key",
    "GET  /entities/:list/:key/nearby?radius=&limit=",
    "GET  /entities/:list/:key/similar",
    "POST /entities/:list                      (admin)",
    "PUT  /entities/:list/:key                 (admin)",
    "POST /entities/:list/:key/enrich          (admin)",
    "POST /entities/:list/:key/images/presign  (admin)",
    "POST /entities/:list/:key/images/complete (admin)",
    "DELETE /entities/:list/:key               (admin)",
    "POST /chat/hello",
    "POST /chat/senza",
    "POST /chat/railfan               (admin)",
    "POST /search",
    "GET  /coords?url=&list=",
    "GET  /wiki?q=",
    "POST /agents/hygiene              (admin)",
    "POST /agents/hygiene/batch        (admin)",
    "GET  /agents/hygiene/recent       (admin)",
    "POST /agents/projects             (admin)",
    "GET  /agents/projects/recent      (admin)",
    "GET  /imagine/prompts",
    "GET  /imagine/prompts/:id",
    "GET  /imagine/models",
    "GET  /imagine/images?model=&style=",
    "GET  /animals/artists",
    "GET  /animals/images?artist=&style=",
  ].join("\n"));
});

// ---- Start ----

(async () => {
  try {
    await ensureIndexes();
    await preloadChats();
    app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
    await initScheduler();
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
})();
