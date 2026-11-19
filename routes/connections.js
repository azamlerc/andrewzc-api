import express from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { models, promptVersion } from "../connections/agents.js";
import { advance, control, rulesVersion } from "../connections/coordinator.js";
import { gameSummary, publicGame } from "../connections/projections.js";
import { controlsGame, createStore, digest, newGame } from "../connections/store.js";

const creationSchema = z.object({ author: z.enum(["openai", "claude"]), creation: z.string().uuid() }).strict();
const advanceSchema = z.object({ revision: z.number().int().nonnegative().safe() }).strict();
const controlSchema = advanceSchema.extend({ command: z.enum(["pause", "resume", "end"]) }).strict();
const gameId = /^[a-f0-9]{24}$/;
const credential = /^Bearer ([a-f0-9]{64})$/i;
const token = (req) => req.get("Authorization")?.match(credential)?.[1];

function clientKey(req) {
  // Render is the last trusted hop in production. Ignore any earlier forwarded
  // values supplied by the caller. Direct local traffic uses the socket address.
  const forwarded = process.env.RENDER ? req.get("x-forwarded-for")?.split(",").at(-1)?.trim() : null;
  return digest(forwarded || req.socket.remoteAddress || "unknown");
}

function encodeCursor(game) {
  return `${game.createdAt.getTime()}.${game._id}`;
}

function decodeCursor(value) {
  if (typeof value !== "string" || !/^\d{13}\.[a-f0-9]{24}$/.test(value)) return null;
  const [time, id] = value.split(".");
  return { createdAt: new Date(Number(time)), _id: new ObjectId(id) };
}

export function createConnectionsRouter(store = createStore(), options = {}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  function handle(fn) {
    return (req, res) => Promise.resolve().then(() => fn(req, res)).catch(() => {
      console.error("connections: request failed");
      res.status(500).json({ error: "internal_error" });
    });
  }

  router.get("/games", handle(async (req, res) => {
    const cursor = decodeCursor(req.query.before);
    if (req.query.before !== undefined && !cursor) return res.status(400).json({ error: "bad_cursor" });
    const rows = await store.list(cursor, 26);
    return res.json({ games: rows.slice(0, 25).map(gameSummary), next: rows.length > 25 ? encodeCursor(rows[24]) : null });
  }));

  router.post("/games", handle(async (req, res) => {
    const result = creationSchema.safeParse(req.body);
    if (!result.success || !token(req)) return res.status(400).json({ error: "bad_request" });
    const { creation, author } = result.data;
    const existing = await store.byCreation(creation);
    if (existing) {
      if (!controlsGame(existing, token(req)) || existing.author.provider !== author) return res.status(409).json({ error: "creation_conflict" });
      return res.json({ game: publicGame(existing) });
    }
    if (!await store.creationAllowed(clientKey(req))) return res.status(429).json({ error: "rate_limited" });
    const player = author === "openai" ? "claude" : "openai";
    const game = await store.insert(newGame({
      author: { provider: author, model: models[author] }, player: { provider: player, model: models[player] },
      creation, controller: digest(token(req)), rulesVersion,
      promptVersions: { author: promptVersion("author"), player: promptVersion("player") },
    }));
    if (!controlsGame(game, token(req)) || game.author.provider !== author) return res.status(409).json({ error: "creation_conflict" });
    return res.status(201).json({ game: publicGame(game) });
  }));

  router.param("id", (req, res, next, id) => {
    if (!gameId.test(id)) return res.status(404).json({ error: "not_found" });
    return store.get(new ObjectId(id)).then((game) => {
      if (!game) return res.status(404).json({ error: "not_found" });
      req.game = game;
      return next();
    }).catch(next);
  });

  router.get("/games/:id", (req, res) => res.json({ game: publicGame(req.game) }));

  function mutation(schema, run) {
    return handle(async (req, res) => {
      const { game } = req;
      if (!controlsGame(game, token(req))) return res.status(403).json({ error: "controller_required" });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "bad_request" });
      if (game.revision !== parsed.data.revision) return res.json({ game: publicGame(game), reason: "stale" });
      const result = await run(req, parsed.data);
      return res.json({ game: publicGame(result.game), reason: result.reason });
    });
  }

  router.post("/games/:id/advance", mutation(advanceSchema, (req) =>
    advance(req.game, { store, client: clientKey(req), ...options })));

  router.post("/games/:id/control", mutation(controlSchema, async (req, { command }) => {
    const game = await control(req.game, command, store);
    return { game: game ?? await store.get(req.game._id), reason: game ? "controlled" : "stale" };
  }));

  router.use((error, _req, res, _next) => {
    console.error("connections: request failed");
    res.status(500).json({ error: "internal_error" });
  });
  return router;
}

export const connectionsRouter = createConnectionsRouter();
