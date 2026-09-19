// blue-room/database.js
// Persistence for the Blue Room two-bot conversation experiment.
//
// Two collections. `blue_room_messages` is the authority: its unique
// (sessionId, turnIndex) index is what makes a turn commit exactly once, even
// across retries, duplicate requests, and process restarts. The counters on
// the session document are a cache of that authority and can always be
// rebuilt by reconcileSession().

import { ObjectId } from "mongodb";
import { connectToMongo } from "../database.js";

const SESSIONS = "blue_room_sessions";
const MESSAGES = "blue_room_messages";

export const SIDES = ["claude", "openai"];

export const MIN_TURNS = 2;
export const MAX_TURNS = 100;

export const MAX_PROMPT_CHARS = 4000;
const MAX_NAME_CHARS   = 60;
const MAX_BRIEF_CHARS  = 4000;
const MAX_TEXT_CHARS   = 20000;

// A claim is abandoned only after this long. Fable-class models can spend
// minutes on a single response, and reclaiming an in-flight turn would bill a
// second one, so this is deliberately generous.
const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export function speakerForIndex(turnIndex) {
  return turnIndex % 2 === 0 ? "claude" : "openai";
}

// Tests inject a stand-in collection source; production passes nothing.
async function resolveDb(override) {
  return override ?? connectToMongo();
}

function toId(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === "string" && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

function isDuplicateKey(err) {
  return err?.code === 11000;
}

function newClaimId() {
  return new ObjectId().toHexString();
}

export async function ensureBlueRoomIndexes() {
  const db = await connectToMongo();
  await db.collection(SESSIONS).createIndex({ updatedAt: -1 });
  await db.collection(SESSIONS).createIndex({ status: 1, updatedAt: -1 });
  await db.collection(MESSAGES).createIndex({ sessionId: 1, turnIndex: 1 }, { unique: true });
  await db.collection(MESSAGES).createIndex({ sessionId: 1, createdAt: 1 });
}

// ---- Validation ----

function validatePersona(persona, side) {
  if (!persona || typeof persona !== "object") return `missing_persona_${side}`;
  const name  = String(persona.name  || "").trim();
  const brief = String(persona.brief || "").trim();
  if (!name  || name.length  > MAX_NAME_CHARS)  return `bad_persona_name_${side}`;
  if (!brief || brief.length > MAX_BRIEF_CHARS) return `bad_persona_brief_${side}`;
  return null;
}

// A scenario may describe two kinds of people ("person 1 speaks French,
// person 2 speaks German") and both sides receive identical scenario text,
// so each side is told which one it is. The two indices must differ or the
// distinction the scenario draws is lost.
function validateRoles(participants) {
  const indices = SIDES.map(side => participants?.[side]?.roleIndex);
  if (!indices.every(index => index === 1 || index === 2)) return "bad_role_index";
  if (indices[0] === indices[1]) return "duplicate_role_index";
  return null;
}

// ---- Create / read ----

export async function createSession({ contextPrompt, totalTurns, participants, title, emoji, db: dbOverride }) {
  const db     = await resolveDb(dbOverride);
  const prompt = String(contextPrompt || "").trim();

  if (!prompt) return { error: "missing_prompt" };
  if (prompt.length > MAX_PROMPT_CHARS) return { error: "prompt_too_long" };

  const turns = Number(totalTurns);
  if (!Number.isInteger(turns) || turns < MIN_TURNS || turns > MAX_TURNS) {
    return { error: "bad_total_turns" };
  }

  // Personas are load-bearing: a session without them is a different
  // experiment, so this fails rather than degrading. Title and emoji are
  // cosmetic and are allowed to be absent.
  for (const side of SIDES) {
    const problem = validatePersona(participants?.[side]?.persona, side);
    if (problem) return { error: problem };
  }

  const roleProblem = validateRoles(participants);
  if (roleProblem) return { error: roleProblem };

  const now = new Date();
  const doc = {
    title:  String(title || "").trim() || prompt.slice(0, 60),
    emoji:  String(emoji || "").trim() || "🌀",
    contextPrompt: prompt,
    status:            "starting",
    totalMessages:     turns,
    completedMessages: 0,
    nextTurnIndex:     0,
    turnState:         "pending",
    turnLeaseAt:       null,
    claimId:           null,
    participants: {
      claude: {
        model:     String(participants.claude.model || ""),
        effort:    String(participants.claude.effort || ""),
        roleIndex: participants.claude.roleIndex,
        persona: {
          name:  String(participants.claude.persona.name).trim(),
          brief: String(participants.claude.persona.brief).trim(),
        },
      },
      openai: {
        model:     String(participants.openai.model || ""),
        effort:    String(participants.openai.effort || ""),
        roleIndex: participants.openai.roleIndex,
        persona: {
          name:  String(participants.openai.persona.name).trim(),
          brief: String(participants.openai.persona.brief).trim(),
        },
      },
    },
    createdAt:   now,
    updatedAt:   now,
    completedAt: null,
    failure:     null,
    version:     1,
  };

  const result = await db.collection(SESSIONS).insertOne(doc);
  return { session: { ...doc, _id: result.insertedId } };
}

export async function getSession(sessionId) {
  const _id = toId(sessionId);
  if (!_id) return null;
  const db = await connectToMongo();
  return db.collection(SESSIONS).findOne({ _id });
}

export async function listSessions({ limit = 25 } = {}) {
  const db = await connectToMongo();
  const capped = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return db.collection(SESSIONS)
    .find({})
    .sort({ updatedAt: -1 })
    .limit(capped)
    .toArray();
}

export async function getMessages(sessionId, { after = null } = {}) {
  const _id = toId(sessionId);
  if (!_id) return [];
  const db = await connectToMongo();
  const filter = { sessionId: _id };
  if (after !== null && after !== undefined && Number.isInteger(Number(after))) {
    filter.turnIndex = { $gt: Number(after) };
  }
  return db.collection(MESSAGES).find(filter).sort({ turnIndex: 1 }).toArray();
}

// Read one committed message. The orchestrator uses this after a commit to
// report what actually landed at that index, which is not necessarily the
// text it just generated — see "Stale claims win the insert" in PLAN.md.
export async function getMessage(sessionId, turnIndex, { db: dbOverride } = {}) {
  const _id = toId(sessionId);
  if (!_id) return null;
  const db = await resolveDb(dbOverride);
  return db.collection(MESSAGES).findOne({ sessionId: _id, turnIndex });
}

// ---- Turn state machine ----

// Atomically take ownership of the next message. Returns a claimId that must
// be presented to commitMessage/failTurn; a claim whose lease expired can be
// taken over, and the old holder is then fenced out at commit time.
export async function claimTurn(sessionId, { leaseMs = DEFAULT_LEASE_MS } = {}) {
  const _id = toId(sessionId);
  if (!_id) return { error: "not_found" };

  const db      = await connectToMongo();
  const now     = new Date();
  const claimId = newClaimId();

  const result = await db.collection(SESSIONS).findOneAndUpdate(
    {
      _id,
      status: { $in: ["starting", "running"] },
      $expr:  { $lt: ["$completedMessages", "$totalMessages"] },
      $or: [
        { turnState: "pending" },
        { turnState: "running", turnLeaseAt: { $lt: now } },
      ],
    },
    {
      $set: {
        status:      "running",
        turnState:   "running",
        turnLeaseAt: new Date(now.getTime() + leaseMs),
        claimId,
        updatedAt:   now,
      },
    },
    { returnDocument: "after" }
  );

  const session = result?.value ?? result ?? null;
  if (!session) {
    // Either the session is finished, failed, or another request holds a live
    // claim. None of these is an error — the caller just doesn't get the turn.
    const current = await db.collection(SESSIONS).findOne({ _id });
    if (!current) return { error: "not_found" };
    return { claimed: false, session: current };
  }

  return {
    claimed:   true,
    claimId,
    turnIndex: session.nextTurnIndex,
    speaker:   speakerForIndex(session.nextTurnIndex),
    session,
  };
}

// Insert the generated message and advance the cached counters.
//
// The insert happens first and the unique index is the real guard: if this
// index was already committed by a newer claim, the insert fails and nothing
// is double-written. The counter update is fenced on claimId, and if that
// fence is lost — or the process dies between the two writes — the counters
// are simply rebuilt from the messages.
export async function commitMessage({ sessionId, turnIndex, speaker, text, provider = {}, claimId, db: dbOverride }) {
  const _id = toId(sessionId);
  if (!_id) return { error: "not_found" };

  const body = String(text || "").trim();
  if (!body) return { error: "empty_text" };
  if (body.length > MAX_TEXT_CHARS) return { error: "text_too_long" };
  if (!SIDES.includes(speaker)) return { error: "bad_speaker" };
  if (speaker !== speakerForIndex(turnIndex)) return { error: "speaker_out_of_order" };

  const db      = await resolveDb(dbOverride);
  const session = await db.collection(SESSIONS).findOne({ _id });
  if (!session) return { error: "not_found" };

  const now = new Date();

  try {
    await db.collection(MESSAGES).insertOne({
      sessionId: _id,
      turnIndex,
      speaker,
      text: body,
      createdAt: now,
      // Which claim produced this text. Kept so an expired-lease double
      // generation is visible in the data instead of silently absorbed.
      claimId: claimId ?? null,
      provider: {
        model:     provider.model     ?? null,
        latencyMs: provider.latencyMs ?? null,
        usage:     provider.usage     ?? null,
      },
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      return { error: "already_committed", session: await reconcileSession(_id, { db }) };
    }
    throw err;
  }

  const done      = turnIndex + 1 >= session.totalMessages;
  const committed = await db.collection(SESSIONS).findOneAndUpdate(
    { _id, claimId, nextTurnIndex: turnIndex },
    {
      $set: {
        completedMessages: turnIndex + 1,
        nextTurnIndex:     turnIndex + 1,
        status:            done ? "completed" : "running",
        turnState:         done ? "completed" : "pending",
        turnLeaseAt:       null,
        claimId:           null,
        completedAt:       done ? now : null,
        updatedAt:         now,
      },
    },
    { returnDocument: "after" }
  );

  const updated = committed?.value ?? committed ?? null;
  if (!updated) {
    // The fence was lost: this claim's lease expired, a replacement claim
    // took over, and we still won the insert. The message stands — see
    // "Stale claims win the insert, deliberately" in PLAN.md — but the
    // caller is told so it can log that we paid for two generations of one
    // turn, which is the actual cost of a lease expiring mid-flight.
    // The same branch covers a crash between the two writes, where the
    // message is durable and only the counters need rebuilding.
    return { session: await reconcileSession(_id, { db }), staleWriter: true };
  }

  return { session: updated, staleWriter: false };
}

export async function failTurn({ sessionId, claimId, code, message, turnIndex }) {
  const _id = toId(sessionId);
  if (!_id) return { error: "not_found" };

  const db  = await connectToMongo();
  const now = new Date();

  const result = await db.collection(SESSIONS).findOneAndUpdate(
    { _id, claimId },
    {
      $set: {
        status:      "failed",
        turnState:   "failed",
        turnLeaseAt: null,
        failure: {
          code:      String(code || "provider_error"),
          message:   String(message || "").slice(0, 500),
          turnIndex: turnIndex ?? null,
        },
        updatedAt: now,
      },
    },
    { returnDocument: "after" }
  );

  const updated = result?.value ?? result ?? null;
  // A stale claim must never overwrite a newer success or failure.
  if (!updated) return { stale: true, session: await getSession(_id) };
  return { session: updated };
}

// Clear a failed turn so the next advance retries it. Refuses when a message
// already exists at that index — that turn succeeded and the failure was
// recorded by a stale request, so reconcile instead of re-running a provider.
export async function resetFailedTurn(sessionId) {
  const _id = toId(sessionId);
  if (!_id) return { error: "not_found" };

  const db      = await connectToMongo();
  const session = await db.collection(SESSIONS).findOne({ _id });
  if (!session) return { error: "not_found" };
  if (session.status !== "failed") return { error: "not_failed", session };

  const existing = await db.collection(MESSAGES).findOne({
    sessionId: _id,
    turnIndex: session.nextTurnIndex,
  });
  if (existing) return { session: await reconcileSession(_id) };

  const result = await db.collection(SESSIONS).findOneAndUpdate(
    { _id, status: "failed" },
    {
      $set: {
        status:      "running",
        turnState:   "pending",
        turnLeaseAt: null,
        claimId:     null,
        failure:     null,
        updatedAt:   new Date(),
      },
    },
    { returnDocument: "after" }
  );

  return { session: result?.value ?? result ?? null };
}

// Rebuild the session's cached counters from the messages, which are the
// authority. Safe to call at any time; it never invents or removes messages.
export async function reconcileSession(sessionId, { db: dbOverride } = {}) {
  const _id = toId(sessionId);
  if (!_id) return null;

  const db      = await resolveDb(dbOverride);
  const session = await db.collection(SESSIONS).findOne({ _id });
  if (!session) return null;

  // Indices are dense: a turn is only ever claimed at nextTurnIndex, so the
  // message count is also the next index to fill.
  const count = await db.collection(MESSAGES).countDocuments({ sessionId: _id });
  const done  = count >= session.totalMessages;

  if (
    session.completedMessages === count &&
    session.nextTurnIndex === count &&
    (!done || session.status === "completed")
  ) {
    return session;
  }

  const now    = new Date();
  const result = await db.collection(SESSIONS).findOneAndUpdate(
    { _id },
    {
      $set: {
        completedMessages: count,
        nextTurnIndex:     count,
        status:            done ? "completed" : (session.status === "failed" ? "failed" : "running"),
        turnState:         done ? "completed" : (session.status === "failed" ? "failed" : "pending"),
        turnLeaseAt:       null,
        claimId:           null,
        completedAt:       done ? (session.completedAt ?? now) : null,
        updatedAt:         now,
      },
    },
    { returnDocument: "after" }
  );

  return result?.value ?? result ?? null;
}

// ---- Projections ----
//
// Nothing here may leak a persona brief, a claimId, or a lease. Briefs reach
// the browser only through personaBrief(), on an explicit observer request.

export function publicSession(session) {
  if (!session) return null;
  return {
    id:                String(session._id),
    title:             session.title,
    emoji:             session.emoji,
    contextPrompt:     session.contextPrompt,
    status:            session.status,
    totalMessages:     session.totalMessages,
    completedMessages: session.completedMessages,
    totalTurns:        session.totalMessages,
    participants: {
      claude: {
        model:     session.participants?.claude?.model ?? null,
        name:      session.participants?.claude?.persona?.name ?? null,
        roleIndex: session.participants?.claude?.roleIndex ?? null,
      },
      openai: {
        model:     session.participants?.openai?.model ?? null,
        name:      session.participants?.openai?.persona?.name ?? null,
        roleIndex: session.participants?.openai?.roleIndex ?? null,
      },
    },
    createdAt:   session.createdAt,
    updatedAt:   session.updatedAt,
    completedAt: session.completedAt ?? null,
    failure: session.failure
      ? { code: session.failure.code, turnIndex: session.failure.turnIndex ?? null }
      : null,
  };
}

export function publicMessage(message) {
  if (!message) return null;
  return {
    turnIndex: message.turnIndex,
    speaker:   message.speaker,
    text:      message.text,
    createdAt: message.createdAt,
    model:     message.provider?.model ?? null,
  };
}

export function personaBrief(session, speaker) {
  if (!session || !SIDES.includes(speaker)) return null;
  const persona = session.participants?.[speaker]?.persona;
  if (!persona) return null;
  return { speaker, name: persona.name, brief: persona.brief };
}

// The private half of a participant, for prompt assembly only. Never send the
// result of this to a browser or to the other side's model.
export function participantForPrompt(session, speaker) {
  if (!session || !SIDES.includes(speaker)) return null;
  const side = session.participants?.[speaker];
  if (!side) return null;
  return {
    speaker,
    model:     side.model,
    effort:    side.effort,
    roleIndex: side.roleIndex ?? null,
    persona:   { name: side.persona?.name ?? "", brief: side.persona?.brief ?? "" },
  };
}
