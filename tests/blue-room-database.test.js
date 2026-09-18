import test from "node:test";
import assert from "node:assert/strict";
import {
  speakerForIndex,
  publicSession,
  publicMessage,
  personaBrief,
  participantForPrompt,
  SIDES,
  MIN_TURNS,
  MAX_TURNS,
} from "../blue-room/database.js";

const CLAUDE_BRIEF = "I am Margit Halvorsen and I repair signalling gear for the railway.";
const OPENAI_BRIEF = "I am Tomas Weill and I am travelling to see my sister for the first time in years.";

function sessionFixture(overrides = {}) {
  return {
    _id: "68c1f0000000000000000001",
    title: "Sleeper train to Berlin",
    emoji: "🚃",
    contextPrompt: "You are on an overnight sleeper train from Paris to Berlin.",
    status: "running",
    totalMessages: 20,
    completedMessages: 4,
    nextTurnIndex: 4,
    turnState: "pending",
    turnLeaseAt: new Date("2026-09-18T10:00:00Z"),
    claimId: "secret-claim-token",
    participants: {
      claude: { model: "claude-fable-5-1", effort: "low", persona: { name: "Margit", brief: CLAUDE_BRIEF } },
      openai: { model: "gpt-6-astra", effort: "low", persona: { name: "Tomas", brief: OPENAI_BRIEF } },
    },
    createdAt: new Date("2026-09-18T09:00:00Z"),
    updatedAt: new Date("2026-09-18T09:30:00Z"),
    completedAt: null,
    failure: null,
    version: 1,
    ...overrides,
  };
}

test("claude speaks on even indices and openai on odd, so sides alternate exactly", () => {
  assert.equal(speakerForIndex(0), "claude");
  assert.equal(speakerForIndex(1), "openai");

  const twentyMessages = Array.from({ length: 20 }, (_, i) => speakerForIndex(i));
  assert.equal(twentyMessages.filter(s => s === "claude").length, 10);
  assert.equal(twentyMessages.filter(s => s === "openai").length, 10);
  assert.deepEqual(twentyMessages.slice(0, 4), ["claude", "openai", "claude", "openai"]);
});

// The whole private-persona design rests on this: a brief must never reach
// the browser through an ordinary session read, and never reach the other
// side's model at all.
test("the public session projection exposes character names but never briefs", () => {
  const view = publicSession(sessionFixture());
  const serialized = JSON.stringify(view);

  assert.equal(view.participants.claude.name, "Margit");
  assert.equal(view.participants.openai.name, "Tomas");

  assert.ok(!serialized.includes(CLAUDE_BRIEF), "claude brief leaked into session projection");
  assert.ok(!serialized.includes(OPENAI_BRIEF), "openai brief leaked into session projection");
  assert.ok(!serialized.includes("signalling"), "claude brief leaked into session projection");
  assert.ok(!serialized.includes("sister"), "openai brief leaked into session projection");
});

test("the public session projection never leaks the claim token or lease", () => {
  const serialized = JSON.stringify(publicSession(sessionFixture()));
  assert.ok(!serialized.includes("secret-claim-token"), "claimId leaked to the browser");
  assert.ok(!serialized.includes("turnLeaseAt"), "lease leaked to the browser");
});

test("a failure is reported by code and turn only, without the provider's message", () => {
  const view = publicSession(sessionFixture({
    status: "failed",
    failure: { code: "refusal", message: "raw provider detail that should stay server-side", turnIndex: 7 },
  }));

  assert.deepEqual(view.failure, { code: "refusal", turnIndex: 7 });
  assert.ok(!JSON.stringify(view).includes("raw provider detail"));
});

test("participantForPrompt returns one side's own persona and nothing about the other", () => {
  const session = sessionFixture();

  const claude = participantForPrompt(session, "claude");
  assert.equal(claude.persona.brief, CLAUDE_BRIEF);
  assert.ok(!JSON.stringify(claude).includes(OPENAI_BRIEF), "the other side's brief crossed over");
  assert.ok(!JSON.stringify(claude).includes("Tomas"), "the other side's name crossed over");

  const openai = participantForPrompt(session, "openai");
  assert.equal(openai.persona.brief, OPENAI_BRIEF);
  assert.ok(!JSON.stringify(openai).includes(CLAUDE_BRIEF), "the other side's brief crossed over");
  assert.ok(!JSON.stringify(openai).includes("Margit"), "the other side's name crossed over");
});

test("persona accessors reject an unknown speaker rather than guessing a side", () => {
  const session = sessionFixture();
  for (const bad of ["gemini", "", null, undefined, "Claude"]) {
    assert.equal(participantForPrompt(session, bad), null);
    assert.equal(personaBrief(session, bad), null);
  }
  assert.deepEqual(SIDES, ["claude", "openai"]);
});

test("personaBrief returns one brief on explicit request, for the reveal panel", () => {
  const session = sessionFixture();
  assert.deepEqual(personaBrief(session, "claude"), {
    speaker: "claude",
    name: "Margit",
    brief: CLAUDE_BRIEF,
  });
});

test("the message projection carries the transcript but not token usage", () => {
  const view = publicMessage({
    sessionId: "x",
    turnIndex: 3,
    speaker: "openai",
    text: "I hadn't thought of it that way.",
    createdAt: new Date("2026-09-18T09:31:00Z"),
    provider: { model: "gpt-6-astra", latencyMs: 8123, usage: { inputTokens: 900, outputTokens: 210 } },
  });

  assert.equal(view.text, "I hadn't thought of it that way.");
  assert.equal(view.speaker, "openai");
  assert.equal(view.model, "gpt-6-astra");
  assert.equal(view.usage, undefined);
  assert.equal(view.latencyMs, undefined);
});

test("turn bounds are exported so routes and UI validate against one source", () => {
  assert.equal(MIN_TURNS, 2);
  assert.equal(MAX_TURNS, 100);
  assert.ok(MAX_TURNS >= 30, "the 30-turn experiment must be expressible");
});
