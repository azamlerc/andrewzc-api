import test from "node:test";
import assert from "node:assert/strict";
import {
  BlueRoomProviderError,
  callClaude,
  callOpenAI,
  generatePersonas,
  generateTitleEmoji,
} from "../blue-room/providers.js";

const request = {
  system: "Talk naturally.",
  messages: [{ role: "user", content: "Hello" }],
  model: "test-model",
};

function claudeClient(response, capture = () => {}) {
  return { messages: { create: async body => { capture(body); return response; } } };
}

function openaiClient(response, capture = () => {}) {
  return { responses: { create: async body => { capture(body); return response; } } };
}

test("Claude adapter sends low effort and cache control, filters thinking, and returns commit shape", async () => {
  let sent;
  const response = {
    model: "test-model",
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Hello there." }],
    usage: { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 7 },
  };
  const value = await callClaude({ ...request, client: claudeClient(response, body => { sent = body; }) });
  assert.equal(value.text, "Hello there.");
  assert.equal(value.provider.model, "test-model");
  assert.equal(value.provider.usage.cache_read_input_tokens, 7);
  assert.ok(value.provider.latencyMs >= 0);
  assert.equal(sent.output_config.effort, "low");
  assert.deepEqual(sent.cache_control, { type: "ephemeral" });
  assert.equal(sent.tools, undefined);
  assert.ok(!JSON.stringify(value).includes("private"));
});

test("Claude refusal and exhausted output budget are distinct failures", async () => {
  await assert.rejects(
    callClaude({ ...request, client: claudeClient({ stop_reason: "refusal", content: [], usage: { output_tokens: 4 } }) }),
    error => error instanceof BlueRoomProviderError && error.code === "refusal" && error.usage.output_tokens === 4
  );
  await assert.rejects(
    callClaude({ ...request, client: claudeClient({ stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] }) }),
    { code: "output_budget" }
  );
});

test("OpenAI adapter uses stateless full-history Responses parameters", async () => {
  let sent;
  const response = {
    model: "gpt-6-astra",
    status: "completed",
    output_text: "Hello from the train.",
    output: [],
    usage: { input_tokens: 80, output_tokens: 20, input_tokens_details: { cached_tokens: 16 }, output_tokens_details: { reasoning_tokens: 5 } },
  };
  const value = await callOpenAI({ ...request, model: "gpt-6-astra", client: openaiClient(response, body => { sent = body; }) });
  assert.equal(value.text, "Hello from the train.");
  assert.equal(value.provider.usage.input_tokens_details.cached_tokens, 16);
  assert.equal(sent.instructions, request.system);
  assert.deepEqual(sent.input, request.messages);
  assert.deepEqual(sent.reasoning, { effort: "low" });
  assert.equal(sent.store, false);
  assert.equal(sent.truncation, "disabled");
  assert.equal(sent.max_output_tokens, 2048);
  assert.equal(sent.previous_response_id, undefined);
  assert.equal(sent.context_management, undefined);
  assert.equal(sent.tools, undefined);
});

test("OpenAI refusal item, content filter, and output budget never become transcript text", async () => {
  await assert.rejects(
    callOpenAI({ ...request, client: openaiClient({ status: "completed", output_text: "", output: [{ content: [{ type: "refusal", refusal: "No" }] }] }) }),
    { code: "refusal" }
  );
  await assert.rejects(
    callOpenAI({ ...request, client: openaiClient({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] }) }),
    { code: "refusal" }
  );
  await assert.rejects(
    callOpenAI({ ...request, client: openaiClient({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: "partial", output: [] }) }),
    { code: "output_budget" }
  );
});

test("OpenAI extracts output_text blocks if the SDK convenience field is absent", async () => {
  const value = await callOpenAI({ ...request, client: openaiClient({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "Good evening." }] }],
  }) });
  assert.equal(value.text, "Good evening.");
});

test("each persona is cast by its own provider and returned for createSession", async () => {
  const claudeBrief = "I'm Margit, the conductor.\n\nI need to find a missing suitcase.";
  const openaiBrief = "I'm Tomas, a bookshop owner.\n\nI want to get home before dawn.";
  let claudeBody;
  let openaiBody;
  const participants = await generatePersonas({
    contextPrompt: "On a sleeper train",
    models: { claude: "claude-sonnet-5", openai: "gpt-6-astra" },
    clients: {
      claude: claudeClient({ model: "claude-sonnet-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ name: "Margit", brief: claudeBrief }) }] }, body => { claudeBody = body; }),
      openai: openaiClient({ model: "gpt-6-astra", status: "completed", output_text: JSON.stringify({ name: "Tomas", brief: openaiBrief }), output: [] }, body => { openaiBody = body; }),
    },
  });
  assert.equal(participants.claude.persona.name, "Margit");
  assert.equal(participants.openai.persona.name, "Tomas");
  assert.ok(!JSON.stringify(claudeBody).includes(openaiBrief));
  assert.ok(!JSON.stringify(openaiBody).includes(claudeBrief));
});

test("invalid persona rejects creation; cosmetic title failure falls back", async () => {
  await assert.rejects(generatePersonas({
    contextPrompt: "On a train",
    clients: {
      claude: claudeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] }),
      openai: openaiClient({ status: "completed", output_text: '{"name":"Tomas","brief":"I am here.\\n\\nI want tea."}', output: [] }),
    },
  }), { code: "invalid_persona_json" });

  const fallback = await generateTitleEmoji({
    contextPrompt: "A long journey by train",
    client: claudeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "oops" }] }),
  });
  assert.deepEqual(fallback, { title: "A long journey by train", emoji: "🌀" });
});
