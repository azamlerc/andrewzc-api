// routes/blue-room.js
// Blue Room: two bots hold a conversation, each believing its partner is a
// person. Mounted at /blue-room in server.js. Public, like /chat.
//
// Every response goes through the projections in blue-room/database.js.
// Persona briefs, claim ids, leases, system prompts and raw provider
// payloads never leave this process except through /personas/:speaker,
// which the observer asks for explicitly and no model ever reads.

import express from "express";
import {
  SIDES,
  getSession,
  getMessages,
  listSessions,
  publicSession,
  publicMessage,
  personaBrief,
} from "../blue-room/database.js";
import {
  startSession,
  advanceSession,
  retrySession,
  DEFAULT_TOTAL_TURNS,
} from "../blue-room/orchestrator.js";
import { cleanError } from "./middleware.js";

export const blueRoomRouter = express.Router();

// Input problems, not server faults: the client can fix these and retry.
const BAD_REQUEST = new Set([
  "missing_prompt",
  "prompt_too_long",
  "bad_total_turns",
  "bad_person1",
  "bad_role_index",
  "duplicate_role_index",
]);

function sessionError(res, error) {
  if (error === "not_found") return res.status(404).json({ error });
  if (BAD_REQUEST.has(error)) return res.status(400).json({ error });
  // A persona that failed validation means a provider returned something
  // unusable, which is upstream of us rather than a client mistake.
  if (error?.startsWith?.("missing_persona") || error?.startsWith?.("bad_persona")) {
    return res.status(502).json({ error });
  }
  return res.status(500).json({ error: error ?? "internal_error" });
}

// POST /blue-room/sessions
// Casts both characters and creates the session. Does not run turn 0 — the
// client's first advance does, so there is one uniform advance path.
blueRoomRouter.post("/sessions", async (req, res) => {
  const { contextPrompt, totalTurns = DEFAULT_TOTAL_TURNS, person1 } = req.body ?? {};
  try {
    const result = await startSession({ contextPrompt, totalTurns, person1 });
    if (result.error === "casting_failed") {
      return res.status(502).json({ error: result.error, cause: result.cause ?? null });
    }
    if (result.error) return sessionError(res, result.error);
    return res.status(201).json({ session: publicSession(result.session), messages: [] });
  } catch (err) {
    console.error("POST /blue-room/sessions failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// GET /blue-room/sessions?limit=
blueRoomRouter.get("/sessions", async (req, res) => {
  try {
    const sessions = await listSessions({ limit: req.query.limit });
    return res.json({ sessions: sessions.map(publicSession) });
  } catch (err) {
    console.error("GET /blue-room/sessions failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// GET /blue-room/sessions/:id
// The session plus its full transcript, for opening or resuming a run.
blueRoomRouter.get("/sessions/:id", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not_found" });
    const messages = await getMessages(req.params.id);
    return res.json({ session: publicSession(session), messages: messages.map(publicMessage) });
  } catch (err) {
    console.error("GET /blue-room/sessions/:id failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// GET /blue-room/sessions/:id/messages?after=<turnIndex>
// Incremental fetch, so a resuming client doesn't re-download the transcript.
blueRoomRouter.get("/sessions/:id/messages", async (req, res) => {
  const after = req.query.after === undefined ? null : Number(req.query.after);
  if (after !== null && !Number.isInteger(after)) {
    return res.status(400).json({ error: "bad_after" });
  }
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not_found" });
    const messages = await getMessages(req.params.id, { after });
    return res.json({ messages: messages.map(publicMessage) });
  } catch (err) {
    console.error("GET /blue-room/sessions/:id/messages failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// GET /blue-room/sessions/:id/personas/:speaker
// Observer-only reveal, shown when a character's name is clicked. This is
// never called by a provider adapter and its response never enters either
// model's history.
blueRoomRouter.get("/sessions/:id/personas/:speaker", async (req, res) => {
  const { speaker } = req.params;
  if (!SIDES.includes(speaker)) return res.status(400).json({ error: "bad_speaker" });
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not_found" });
    const persona = personaBrief(session, speaker);
    if (!persona) return res.status(404).json({ error: "no_persona" });
    return res.json({
      persona: { ...persona, roleIndex: session.participants?.[speaker]?.roleIndex ?? null },
    });
  } catch (err) {
    console.error("GET /blue-room/sessions/:id/personas/:speaker failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// POST /blue-room/sessions/:id/turn
// Advance exactly one message. Idempotent at the limit and safe to
// double-click: a second concurrent call is told the turn is busy rather
// than generating a second billable message.
blueRoomRouter.post("/sessions/:id/turn", async (req, res) => {
  try {
    const result = await advanceSession(req.params.id);
    if (result.error) return sessionError(res, result.error);
    return res.json({
      session: publicSession(result.session),
      message: result.message ? publicMessage(result.message) : null,
      advanced: result.advanced,
      reason: result.reason,
      failure: result.failure ?? null,
    });
  } catch (err) {
    console.error("POST /blue-room/sessions/:id/turn failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});

// POST /blue-room/sessions/:id/retry
// Clear a failed turn back to pending. Refuses when a message already
// exists at that index — that turn succeeded and the failure was recorded
// by a stale request, so the session is reconciled instead of re-run.
blueRoomRouter.post("/sessions/:id/retry", async (req, res) => {
  try {
    const result = await retrySession(req.params.id);
    if (result.error === "not_failed") {
      return res.status(409).json({ error: result.error, session: publicSession(result.session) });
    }
    if (result.error) return sessionError(res, result.error);
    return res.json({ session: publicSession(result.session) });
  } catch (err) {
    console.error("POST /blue-room/sessions/:id/retry failed:", err);
    return res.status(500).json({ error: "internal_error", message: cleanError(err) });
  }
});
