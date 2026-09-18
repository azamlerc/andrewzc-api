// blue-room/orchestrator.js
// The turn loop for the Blue Room experiment.
//
// One advance call runs exactly one message: claim, build, generate, commit.
// There is no background worker — the client's advance request is the worker
// tick — so every HTTP request is short and resume is free. See PLAN.md →
// "Orchestration".
//
// Nothing here talks to a provider SDK or to Mongo directly. Persistence and
// provider calls arrive as `store` and `providers`, which tests replace.

import {
  SIDES,
  MIN_TURNS,
  MAX_TURNS,
  createSession,
  getSession,
  getMessage,
  getMessages,
  claimTurn,
  commitMessage,
  failTurn,
  resetFailedTurn,
  reconcileSession,
} from "./database.js";
import { buildDialogueRequest, BlueRoomPromptError } from "./prompts.js";
import {
  callClaude,
  callOpenAI,
  generatePersonas,
  generateTitleEmoji,
  BlueRoomProviderError,
} from "./providers.js";

export const DEFAULT_TOTAL_TURNS = 20;
export const DEFAULT_PERSON_1 = "claude";

const defaultStore = {
  createSession,
  getSession,
  getMessage,
  getMessages,
  claimTurn,
  commitMessage,
  failTurn,
  resetFailedTurn,
  reconcileSession,
};

const defaultProviders = { callClaude, callOpenAI, generatePersonas, generateTitleEmoji };

// Which side is told it is person 1. Turn order does not move with it:
// Claude always speaks the even indices, so with person1 = "openai" the
// conversation is opened by person 2. See PLAN.md → "Role assignment".
export function roleAssignment(person1 = DEFAULT_PERSON_1) {
  if (!SIDES.includes(person1)) return null;
  return person1 === "claude" ? { claude: 1, openai: 2 } : { claude: 2, openai: 1 };
}

// Provider and prompt errors already carry normalized codes; anything else is
// an SDK or transport failure. Keep provider prose out of the code field —
// it reaches the session's failure record, and publicSession exposes the code.
function normalizeFailure(err) {
  if (err instanceof BlueRoomProviderError) {
    return { code: err.code, message: [err.provider, err.reason].filter(Boolean).join(": ") };
  }
  if (err instanceof BlueRoomPromptError) {
    return { code: err.code, message: "prompt assembly rejected the session state" };
  }
  return { code: "provider_error", message: String(err?.message ?? "").slice(0, 500) };
}

// ---- Session creation ----

// Personas are three paid calls, so the cheap validation runs first. The
// same checks run again inside createSession, which is the real boundary;
// these only exist to avoid paying for a session that cannot be stored.
function validateCreation({ contextPrompt, totalTurns, person1 }) {
  if (!String(contextPrompt ?? "").trim()) return "missing_prompt";
  if (!Number.isInteger(totalTurns) || totalTurns < MIN_TURNS || totalTurns > MAX_TURNS) {
    return "bad_total_turns";
  }
  if (!SIDES.includes(person1)) return "bad_person1";
  return null;
}

export async function startSession(
  { contextPrompt, totalTurns = DEFAULT_TOTAL_TURNS, person1 = DEFAULT_PERSON_1 },
  { store = defaultStore, providers = defaultProviders } = {}
) {
  const prompt = String(contextPrompt ?? "").trim();
  const turns = Number(totalTurns);
  const problem = validateCreation({ contextPrompt: prompt, totalTurns: turns, person1 });
  if (problem) return { error: problem };

  const roles = roleAssignment(person1);

  // Casting is load-bearing and fails the request; the title and emoji are
  // cosmetic and fall back on their own, so only the personas can reject.
  let participants;
  let metadata;
  try {
    [participants, metadata] = await Promise.all([
      providers.generatePersonas({ contextPrompt: prompt, roles }),
      providers.generateTitleEmoji({ contextPrompt: prompt }),
    ]);
  } catch (err) {
    const failure = normalizeFailure(err);
    return { error: "casting_failed", cause: failure.code };
  }

  return store.createSession({
    contextPrompt: prompt,
    totalTurns: turns,
    participants,
    title: metadata?.title,
    emoji: metadata?.emoji,
  });
}

// ---- One turn ----

// Returns { session, advanced, reason, message? } rather than throwing, so a
// route can report "someone else is mid-turn" and "this run is finished" the
// same way it reports success. Raw session/message documents come back; the
// caller projects them.
export async function advanceSession(
  sessionId,
  { store = defaultStore, providers = defaultProviders } = {}
) {
  const existing = await store.getSession(sessionId);
  if (!existing) return { error: "not_found" };
  if (existing.completedMessages >= existing.totalMessages) {
    return { session: existing, advanced: false, reason: "completed" };
  }
  // A failed session needs an explicit retry. Advancing past a failure on
  // its own would hide it and spend another provider call to do so.
  if (existing.status === "failed") {
    return { session: existing, advanced: false, reason: "failed" };
  }

  const claim = await store.claimTurn(sessionId);
  if (claim.error) return { error: claim.error };
  if (!claim.claimed) {
    // Another request holds a live claim, or the session finished between
    // the read and the claim. Neither is an error.
    return { session: claim.session, advanced: false, reason: "busy" };
  }

  const { claimId, turnIndex, speaker, session } = claim;
  const history = await store.getMessages(sessionId);

  // Counters disagreeing with the stored messages means a previous turn was
  // interrupted between its two writes. Rebuild and let the next advance
  // start from the truth rather than generating against a wrong history.
  if (history.length !== turnIndex) {
    const reconciled = await store.reconcileSession(sessionId);
    return { session: reconciled ?? session, advanced: false, reason: "reconciled" };
  }

  let generated;
  try {
    const request = buildDialogueRequest({ session, speaker, messages: history });
    const call = speaker === "claude" ? providers.callClaude : providers.callOpenAI;
    generated = await call(request);
  } catch (err) {
    const failure = normalizeFailure(err);
    const failed = await store.failTurn({
      sessionId,
      claimId,
      turnIndex,
      code: failure.code,
      message: failure.message,
    });
    return {
      session: failed.session ?? session,
      advanced: false,
      reason: "provider_failed",
      failure: { code: failure.code, turnIndex },
      // A stale claim's failure must not bury a newer success — failTurn
      // refused the write, and the caller should not treat this as the
      // session's current state.
      stale: failed.stale === true,
    };
  }

  const commit = await store.commitMessage({
    sessionId,
    turnIndex,
    speaker,
    text: generated.text,
    provider: generated.provider,
    claimId,
  });

  if (commit.error === "already_committed") {
    // A replacement claim's text landed first. Ours is discarded, already
    // billed, and worth saying out loud.
    console.warn(`blue-room: discarded a duplicate generation for ${sessionId} turn ${turnIndex}`);
  } else if (commit.error) {
    return { error: commit.error, session: commit.session ?? session };
  }
  if (commit.staleWriter) {
    console.warn(`blue-room: lease expired mid-flight on ${sessionId} turn ${turnIndex}; two generations billed`);
  }

  // Read back what actually landed. In the stale-claim race this is not
  // necessarily the text generated above, and the caller must be told what
  // the transcript says rather than what this request produced.
  const stored = await store.getMessage(sessionId, turnIndex);

  return {
    session: commit.session ?? session,
    message: stored,
    advanced: !commit.error,
    reason: commit.error ?? "advanced",
    staleWriter: commit.staleWriter === true,
  };
}

// ---- Retry ----

export async function retrySession(sessionId, { store = defaultStore } = {}) {
  return store.resetFailedTurn(sessionId);
}
