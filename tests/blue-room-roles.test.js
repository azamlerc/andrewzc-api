// Role assignment, added by Andrew on 2026-09-18 after item 2 was built.
// A scenario may describe two kinds of people ("person 1 speaks French and
// person 2 speaks German") and both sides receive identical scenario text,
// so each side has to be told which one it is. See PLAN.md → "Role
// assignment" and REQUIREMENTS.md → "Roles".

import test from "node:test";
import assert from "node:assert/strict";
import { createSession, participantForPrompt, publicSession } from "../blue-room/database.js";
import { buildDialogueRequest, buildPersonaRequest } from "../blue-room/prompts.js";
import { generatePersonas } from "../blue-room/providers.js";
import { roleAssignment } from "../blue-room/orchestrator.js";

const SCENARIO = "Two travellers share a compartment. Person 1 speaks French and person 2 speaks German.";
const CLAUDE_BRIEF = "I'm Margit and I repair railway signals.\n\nI want a quiet ride tonight.";
const OPENAI_BRIEF = "I'm Tomas, a bookseller heading to Berlin.\n\nI hope to see my sister.";

function participants({ claudeRole = 1, openaiRole = 2 } = {}) {
  return {
    claude: { model: "claude-fable-5-1", effort: "low", roleIndex: claudeRole, persona: { name: "Margit", brief: CLAUDE_BRIEF } },
    openai: { model: "gpt-6-astra", effort: "low", roleIndex: openaiRole, persona: { name: "Tomas", brief: OPENAI_BRIEF } },
  };
}

function sessionFixture(overrides = {}) {
  return { _id: "68c1f0000000000000000001", totalMessages: 20, contextPrompt: SCENARIO, participants: participants(), ...overrides };
}

// Stand-in for the sessions collection, so creation validation is testable
// without Atlas — the local machine cannot reach it under Node 26.
function fakeDb() {
  const inserted = [];
  return {
    inserted,
    collection() {
      return { async insertOne(doc) { inserted.push(doc); return { insertedId: "new-session" }; } };
    },
  };
}

test("each side is told which person it is, and only its own number", () => {
  const first = buildDialogueRequest({ session: sessionFixture(), speaker: "claude", messages: [] });
  const second = buildDialogueRequest({
    session: sessionFixture(),
    speaker: "openai",
    messages: [{ turnIndex: 0, speaker: "claude", text: "Bonsoir." }],
  });

  assert.ok(first.system.includes("you are person 1"));
  assert.ok(!first.system.includes("you are person 2"));
  assert.ok(second.system.includes("you are person 2"));
  assert.ok(!second.system.includes("you are person 1"));
});

// The whole point of the feature: the scenario text stays byte-identical so
// both bots read the same situation, and the role line is what differs.
test("the scenario reaches both sides unchanged; only the role line differs", () => {
  const session = sessionFixture();
  const first = buildDialogueRequest({ session, speaker: "claude", messages: [] });
  const second = buildDialogueRequest({
    session,
    speaker: "openai",
    messages: [{ turnIndex: 0, speaker: "claude", text: "Bonsoir." }],
  });

  assert.ok(first.system.includes(SCENARIO));
  assert.ok(second.system.includes(SCENARIO));

  // Briefs first: once names are masked the brief text no longer matches.
  const strip = text => text
    .replace(CLAUDE_BRIEF, "BRIEF").replace(OPENAI_BRIEF, "BRIEF")
    .replace(/Margit|Tomas/g, "NAME")
    .replace(/person [12]/gi, "person N");
  assert.equal(strip(first.system), strip(second.system));
});

// Casting has to know the role too. A character invented without it can
// contradict its own assignment — a German speaker told afterwards that
// person 1 speaks French.
test("persona casting is told the role, so the invented character matches it", () => {
  const first = buildPersonaRequest({ contextPrompt: SCENARIO, roleIndex: 1 });
  const second = buildPersonaRequest({ contextPrompt: SCENARIO, roleIndex: 2 });

  assert.ok(first.system.includes("you are person 1"));
  assert.ok(second.system.includes("you are person 2"));
});

test("a session with no role assignment is refused rather than defaulted", () => {
  const session = sessionFixture({ participants: participants({ claudeRole: null }) });
  assert.throws(
    () => buildDialogueRequest({ session, speaker: "claude", messages: [] }),
    { code: "missing_role_index" }
  );
  assert.throws(() => buildPersonaRequest({ contextPrompt: SCENARIO }), { code: "missing_role_index" });
});

test("createSession rejects a missing or duplicated role index", async () => {
  const base = { contextPrompt: SCENARIO, totalTurns: 10, db: fakeDb() };

  assert.equal(
    (await createSession({ ...base, participants: participants({ openaiRole: 1 }) })).error,
    "duplicate_role_index"
  );
  assert.equal(
    (await createSession({ ...base, participants: participants({ openaiRole: 3 }) })).error,
    "bad_role_index"
  );
  assert.equal(
    (await createSession({ ...base, participants: participants({ openaiRole: null }) })).error,
    "bad_role_index"
  );
});

test("the stored session carries both role indices", async () => {
  const db = fakeDb();
  const result = await createSession({
    contextPrompt: SCENARIO, totalTurns: 10, participants: participants(), db,
  });

  assert.equal(result.error, undefined);
  assert.equal(db.inserted[0].participants.claude.roleIndex, 1);
  assert.equal(db.inserted[0].participants.openai.roleIndex, 2);
});

// The observer needs to see who is who; the brief still must not travel.
test("roles are public to the observer while briefs stay private", () => {
  const view = publicSession({ ...sessionFixture(), participants: participants() });

  assert.equal(view.participants.claude.roleIndex, 1);
  assert.equal(view.participants.openai.roleIndex, 2);
  assert.ok(!JSON.stringify(view).includes(CLAUDE_BRIEF));
  assert.ok(!JSON.stringify(view).includes(OPENAI_BRIEF));
});

test("the prompt accessor carries the role with the persona it belongs to", () => {
  const side = participantForPrompt(sessionFixture(), "openai");
  assert.equal(side.roleIndex, 2);
  assert.equal(side.persona.name, "Tomas");
});

// Role and model are otherwise perfectly confounded: any difference between
// person 1 and person 2 would be indistinguishable from a difference between
// Claude and ChatGPT. Swapping lets one run separate them.
test("person 1 defaults to Claude and can be swapped to OpenAI", () => {
  assert.deepEqual(roleAssignment(), { claude: 1, openai: 2 });
  assert.deepEqual(roleAssignment("claude"), { claude: 1, openai: 2 });
  assert.deepEqual(roleAssignment("openai"), { claude: 2, openai: 1 });
  assert.equal(roleAssignment("nobody"), null);
});

test("generatePersonas casts each provider into its assigned role and records it", async () => {
  const brief = "I'm here for the journey.\n\nI am hoping for a quiet night.";
  let claudeBody;
  let openaiBody;
  const cast = name => JSON.stringify({ name, brief });

  const participants = await generatePersonas({
    contextPrompt: SCENARIO,
    // Swapped: Claude is person 2 here.
    roles: { claude: 2, openai: 1 },
    clients: {
      claude: { messages: { create: async body => {
        claudeBody = body;
        return { model: "claude-fable-5-1", stop_reason: "end_turn", content: [{ type: "text", text: cast("Margit") }] };
      } } },
      openai: { responses: { create: async body => {
        openaiBody = body;
        return { model: "gpt-6-astra", status: "completed", output_text: cast("Tomas"), output: [] };
      } } },
    },
  });

  assert.ok(claudeBody.system.includes("you are person 2"));
  assert.ok(openaiBody.instructions.includes("you are person 1"));
  // The assignment is returned so createSession stores the same mapping the
  // characters were cast under.
  assert.equal(participants.claude.roleIndex, 2);
  assert.equal(participants.openai.roleIndex, 1);
});
