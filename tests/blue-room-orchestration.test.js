// The turn loop: claim, build, generate, commit, and every way that goes
// wrong. No provider is contacted and no database is reached.
//
// The store below reimplements the turn-state semantics of
// blue-room/database.js in memory. Those semantics are themselves covered
// against a fake Mongo in blue-room-database.test.js and
// blue-room-commit-race.test.js; these tests are about what the orchestrator
// does with them.

import test from "node:test";
import assert from "node:assert/strict";
import { speakerForIndex } from "../blue-room/database.js";
import { BlueRoomProviderError } from "../blue-room/providers.js";
import { advanceSession, startSession, retrySession } from "../blue-room/orchestrator.js";

const SCENARIO = "You share a compartment on an overnight train.";
const CLAUDE_BRIEF = "I'm Margit and I repair railway signals.\n\nI want a quiet ride tonight.";
const OPENAI_BRIEF = "I'm Tomas, a bookseller heading to Berlin.\n\nI hope to see my sister.";

function participants() {
  return {
    claude: { model: "claude-fable-5-1", effort: "low", roleIndex: 1, persona: { name: "Margit", brief: CLAUDE_BRIEF } },
    openai: { model: "gpt-6-astra", effort: "low", roleIndex: 2, persona: { name: "Tomas", brief: OPENAI_BRIEF } },
  };
}

function memoryStore({ session: overrides = {}, messages = [] } = {}) {
  const state = {
    session: {
      _id: "sess-1",
      contextPrompt: SCENARIO,
      status: "starting",
      totalMessages: 20,
      completedMessages: 0,
      nextTurnIndex: 0,
      turnState: "pending",
      claimId: null,
      failure: null,
      participants: participants(),
      ...overrides,
    },
    messages: [...messages],
  };
  let claims = 0;

  const store = {
    state,
    async getSession() {
      return { ...state.session };
    },
    async getMessages() {
      return state.messages.map(message => ({ ...message }));
    },
    async getMessage(_sessionId, turnIndex) {
      return state.messages.find(message => message.turnIndex === turnIndex) ?? null;
    },
    async claimTurn() {
      const session = state.session;
      if (session.completedMessages >= session.totalMessages) return { claimed: false, session: { ...session } };
      if (!["starting", "running"].includes(session.status)) return { claimed: false, session: { ...session } };
      // A live claim blocks a second one; lease expiry is exercised in the
      // persistence tests, not here.
      if (session.turnState === "running") return { claimed: false, session: { ...session } };

      const claimId = `claim-${++claims}`;
      Object.assign(session, { status: "running", turnState: "running", claimId });
      return {
        claimed: true,
        claimId,
        turnIndex: session.nextTurnIndex,
        speaker: speakerForIndex(session.nextTurnIndex),
        session: { ...session },
      };
    },
    async commitMessage({ turnIndex, speaker, text, provider, claimId }) {
      const session = state.session;
      if (state.messages.some(message => message.turnIndex === turnIndex)) {
        return { error: "already_committed", session: { ...session } };
      }
      state.messages.push({ sessionId: "sess-1", turnIndex, speaker, text, provider, claimId, createdAt: new Date() });

      const staleWriter = session.claimId !== claimId;
      const done = turnIndex + 1 >= session.totalMessages;
      Object.assign(session, {
        completedMessages: turnIndex + 1,
        nextTurnIndex: turnIndex + 1,
        status: done ? "completed" : "running",
        turnState: done ? "completed" : "pending",
        claimId: null,
      });
      return { session: { ...session }, staleWriter };
    },
    async failTurn({ claimId, code, message, turnIndex }) {
      const session = state.session;
      if (session.claimId !== claimId) return { stale: true, session: { ...session } };
      Object.assign(session, {
        status: "failed",
        turnState: "failed",
        claimId: null,
        failure: { code, message, turnIndex },
      });
      return { session: { ...session } };
    },
    async resetFailedTurn() {
      const session = state.session;
      if (session.status !== "failed") return { error: "not_failed", session: { ...session } };
      if (state.messages.some(message => message.turnIndex === session.nextTurnIndex)) {
        return { session: await store.reconcileSession() };
      }
      Object.assign(session, { status: "running", turnState: "pending", claimId: null, failure: null });
      return { session: { ...session } };
    },
    async reconcileSession() {
      const session = state.session;
      const count = state.messages.length;
      const done = count >= session.totalMessages;
      Object.assign(session, {
        completedMessages: count,
        nextTurnIndex: count,
        status: done ? "completed" : session.status === "failed" ? "failed" : "running",
        turnState: done ? "completed" : session.status === "failed" ? "failed" : "pending",
        claimId: null,
      });
      return { ...session };
    },
  };
  return store;
}

// Records every request so a test can assert on what the models were sent.
function scriptedProviders({ claude, openai } = {}) {
  const calls = { claude: 0, openai: 0, requests: [] };
  const answer = (side, custom) => async request => {
    calls[side] += 1;
    calls.requests.push({ side, request });
    if (custom) return custom({ request, n: calls[side] });
    return {
      text: `${side} message ${calls[side]}`,
      provider: { model: `${side}-model`, latencyMs: 5, usage: { input_tokens: 10, output_tokens: 5 } },
    };
  };
  return { calls, callClaude: answer("claude", claude), callOpenAI: answer("openai", openai) };
}

async function runToCompletion(store, providers, limit = 40) {
  let last;
  for (let i = 0; i < limit; i += 1) {
    last = await advanceSession("sess-1", { store, providers });
    if (!last.advanced) break;
  }
  return last;
}

test("ten turns produce exactly twenty alternating messages and then stop", async () => {
  const store = memoryStore();
  const providers = scriptedProviders();

  await runToCompletion(store, providers);

  assert.equal(store.state.messages.length, 20);
  assert.equal(store.state.session.status, "completed");
  assert.equal(providers.calls.claude, 10);
  assert.equal(providers.calls.openai, 10);
  store.state.messages.forEach((message, index) => {
    assert.equal(message.turnIndex, index);
    assert.equal(message.speaker, speakerForIndex(index));
  });
});

test("advancing a finished session is idempotent and costs nothing", async () => {
  const store = memoryStore();
  const providers = scriptedProviders();
  await runToCompletion(store, providers);
  const before = providers.calls.claude + providers.calls.openai;

  const result = await advanceSession("sess-1", { store, providers });

  assert.equal(result.advanced, false);
  assert.equal(result.reason, "completed");
  assert.equal(store.state.messages.length, 20);
  assert.equal(providers.calls.claude + providers.calls.openai, before, "no extra provider call");
});

// Two tabs, or a double-click: the second request must not buy a second
// generation of the same turn.
test("a second advance during a live claim is refused without generating", async () => {
  const store = memoryStore();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const providers = scriptedProviders({
    claude: async () => {
      await held;
      return { text: "Slow answer.", provider: { model: "claude-model", latencyMs: 900, usage: null } };
    },
  });

  const first = advanceSession("sess-1", { store, providers });
  const second = await advanceSession("sess-1", { store, providers });

  assert.equal(second.advanced, false);
  assert.equal(second.reason, "busy");
  assert.equal(providers.calls.claude, 1);

  release();
  const settled = await first;
  assert.equal(settled.advanced, true);
  assert.equal(store.state.messages.length, 1);
});

test("a refusal fails the turn, keeps the transcript, and stores no text", async () => {
  const store = memoryStore();
  const providers = scriptedProviders({
    claude: ({ n }) => {
      if (n === 2) throw new BlueRoomProviderError("refusal", { provider: "claude", reason: "refusal" });
      return { text: `claude message ${n}`, provider: { model: "claude-model", latencyMs: 5, usage: null } };
    },
  });

  const result = await runToCompletion(store, providers);

  assert.equal(result.advanced, false);
  assert.equal(result.reason, "provider_failed");
  assert.deepEqual(result.failure, { code: "refusal", turnIndex: 2 });
  assert.equal(store.state.session.status, "failed");
  // Turns 0 and 1 survive; the refused turn left nothing behind.
  assert.equal(store.state.messages.length, 2);
  assert.ok(!store.state.messages.some(message => message.turnIndex === 2));
});

test("a failed session will not advance until it is explicitly retried", async () => {
  const store = memoryStore({ session: { status: "failed", turnState: "failed", completedMessages: 2, nextTurnIndex: 2, failure: { code: "refusal", turnIndex: 2 } },
    messages: [
      { sessionId: "sess-1", turnIndex: 0, speaker: "claude", text: "one" },
      { sessionId: "sess-1", turnIndex: 1, speaker: "openai", text: "two" },
    ] });
  const providers = scriptedProviders();

  const blocked = await advanceSession("sess-1", { store, providers });
  assert.equal(blocked.advanced, false);
  assert.equal(blocked.reason, "failed");
  assert.equal(providers.calls.claude, 0, "a failed session must not spend on a silent retry");

  await retrySession("sess-1", { store });
  const resumed = await advanceSession("sess-1", { store, providers });

  assert.equal(resumed.advanced, true);
  assert.equal(store.state.session.failure, null);
  assert.equal(store.state.messages.length, 3);
  assert.equal(store.state.messages[2].turnIndex, 2);
});

test("a resumed session continues at the stored index, not from the start", async () => {
  const store = memoryStore({
    session: { status: "running", completedMessages: 3, nextTurnIndex: 3 },
    messages: [0, 1, 2].map(turnIndex => ({
      sessionId: "sess-1", turnIndex, speaker: speakerForIndex(turnIndex), text: `earlier ${turnIndex}`,
    })),
  });
  const providers = scriptedProviders();

  const result = await advanceSession("sess-1", { store, providers });

  assert.equal(result.advanced, true);
  assert.equal(result.message.turnIndex, 3);
  assert.equal(result.message.speaker, "openai");
  assert.equal(providers.calls.claude, 0);
  assert.equal(providers.calls.openai, 1);
});

// A crash between the insert and the counter update leaves the counters
// behind the messages. Generating against that history would produce a
// message for a turn that already exists.
test("counters behind the transcript reconcile instead of calling a provider", async () => {
  const store = memoryStore({
    session: { status: "running", completedMessages: 1, nextTurnIndex: 1 },
    messages: [0, 1].map(turnIndex => ({
      sessionId: "sess-1", turnIndex, speaker: speakerForIndex(turnIndex), text: `earlier ${turnIndex}`,
    })),
  });
  const providers = scriptedProviders();

  const result = await advanceSession("sess-1", { store, providers });

  assert.equal(result.advanced, false);
  assert.equal(result.reason, "reconciled");
  assert.equal(providers.calls.claude + providers.calls.openai, 0);
  assert.equal(store.state.session.nextTurnIndex, 2);
});

// The privacy invariant has to hold through the whole loop, not just in the
// prompt builder: what each provider is actually sent, every turn.
test("neither provider is ever sent the other side's private brief", async () => {
  const store = memoryStore();
  const providers = scriptedProviders();

  await runToCompletion(store, providers);

  for (const { side, request } of providers.calls.requests) {
    const body = JSON.stringify(request);
    const foreign = side === "claude" ? OPENAI_BRIEF : CLAUDE_BRIEF;
    const own = side === "claude" ? CLAUDE_BRIEF : OPENAI_BRIEF;
    assert.ok(request.system.includes(own), `${side} lost its own brief`);
    assert.ok(!body.includes(foreign), `${side} was sent the other brief`);
    assert.ok(!body.includes("claim-"), `${side} was sent a claim id`);
  }
});

// A lost fence means two generations were billed for one turn. The message
// that landed is authoritative, and the caller is told which one it is.
test("a stale writer reports the text that actually landed, not its own", async () => {
  const store = memoryStore();
  const providers = scriptedProviders();
  // Drop the claim the orchestrator is holding, as an expired lease would.
  const realClaim = store.claimTurn;
  store.claimTurn = async (...args) => {
    const claim = await realClaim.call(store, ...args);
    store.state.session.claimId = "claim-replacement";
    return claim;
  };

  const result = await advanceSession("sess-1", { store, providers });

  assert.equal(result.staleWriter, true);
  assert.equal(result.advanced, true);
  assert.equal(result.message.text, store.state.messages[0].text);
});

test("startSession casts both characters before creating, and fails if casting does", async () => {
  const created = [];
  const store = {
    async createSession(input) {
      created.push(input);
      return { session: { _id: "sess-new", ...input } };
    },
  };

  const ok = await startSession(
    { contextPrompt: SCENARIO, totalTurns: 10 },
    {
      store,
      providers: {
        generatePersonas: async ({ roles }) => ({ roles, ...participants() }),
        generateTitleEmoji: async () => ({ title: "Night train", emoji: "🚃" }),
      },
    }
  );

  assert.equal(ok.session._id, "sess-new");
  assert.equal(created[0].title, "Night train");
  assert.deepEqual(created[0].participants.roles, { claude: 1, openai: 2 });

  const refused = await startSession(
    { contextPrompt: SCENARIO, totalTurns: 10 },
    {
      store,
      providers: {
        generatePersonas: async () => { throw new BlueRoomProviderError("refusal", { provider: "claude" }); },
        generateTitleEmoji: async () => ({ title: "Night train", emoji: "🚃" }),
      },
    }
  );

  assert.equal(refused.error, "casting_failed");
  assert.equal(refused.cause, "refusal");
  assert.equal(created.length, 1, "a session was created despite failed casting");
});

test("creation validates turn bounds before paying for personas", async () => {
  let cast = 0;
  const providers = {
    generatePersonas: async () => { cast += 1; return participants(); },
    generateTitleEmoji: async () => ({ title: "x", emoji: "🌀" }),
  };
  const store = { async createSession() { return { session: {} }; } };

  assert.equal((await startSession({ contextPrompt: SCENARIO, totalTurns: 999 }, { store, providers })).error, "bad_total_turns");
  assert.equal((await startSession({ contextPrompt: "  " }, { store, providers })).error, "missing_prompt");
  assert.equal((await startSession({ contextPrompt: "x".repeat(4001) }, { store, providers })).error, "prompt_too_long");
  assert.equal((await startSession({ contextPrompt: SCENARIO, person1: "nobody" }, { store, providers })).error, "bad_person1");
  assert.equal(cast, 0, "no provider call for an input we would reject anyway");
});
