import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  buildMetadataRequest,
  buildPersonaRequest,
  parseMetadata,
  parsePersona,
} from "./prompts.js";

export const BLUE_ROOM_MODELS = Object.freeze({
  claude: "claude-fable-5-1",
  openai: "gpt-6-astra",
});
export const DEVELOPMENT_CLAUDE_MODEL = "claude-sonnet-5";
export const DEFAULT_EFFORT = "low";
export const DIALOGUE_MAX_TOKENS = 2048;

export class BlueRoomProviderError extends Error {
  constructor(code, { provider, reason = null, usage = null } = {}) {
    super(code);
    this.name = "BlueRoomProviderError";
    this.code = code;
    this.provider = provider;
    this.reason = reason;
    this.usage = usage;
  }
}

function requireClient(client, keyName, create) {
  if (client) return client;
  const apiKey = process.env[keyName];
  if (!apiKey) throw new BlueRoomProviderError("missing_api_key", { provider: keyName });
  return create(apiKey);
}

function requireRequest({ system, messages, model, maxTokens }) {
  if (typeof system !== "string" || !system.trim()) throw new TypeError("system is required");
  if (!Array.isArray(messages) || !messages.length) throw new TypeError("messages are required");
  if (typeof model !== "string" || !model.trim()) throw new TypeError("model is required");
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new TypeError("maxTokens must be positive");
}

function result(text, response, elapsedMs, model) {
  const clean = String(text ?? "").trim();
  if (!clean) throw new BlueRoomProviderError("empty_response", {
    provider: model,
    usage: response?.usage ?? null,
  });
  return {
    text: clean,
    provider: {
      model: response?.model || model,
      latencyMs: Math.round(elapsedMs),
      usage: response?.usage ?? null,
    },
  };
}

export async function callClaude({
  system,
  messages,
  model = BLUE_ROOM_MODELS.claude,
  effort = DEFAULT_EFFORT,
  maxTokens = DIALOGUE_MAX_TOKENS,
  client,
  signal,
}) {
  requireRequest({ system, messages, model, maxTokens });
  const sdk = requireClient(client, "ANTHROPIC_API_KEY", apiKey => new Anthropic({ apiKey }));
  const started = performance.now();
  const response = await sdk.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: { effort },
    cache_control: { type: "ephemeral" },
  }, signal ? { signal } : undefined);

  if (response.stop_reason === "refusal") {
    throw new BlueRoomProviderError("refusal", {
      provider: "claude",
      reason: "refusal",
      usage: response.usage ?? null,
    });
  }
  if (response.stop_reason === "max_tokens") {
    throw new BlueRoomProviderError("output_budget", {
      provider: "claude",
      reason: "max_tokens",
      usage: response.usage ?? null,
    });
  }
  if (response.stop_reason !== "end_turn") {
    throw new BlueRoomProviderError("unexpected_stop_reason", {
      provider: "claude",
      reason: response.stop_reason ?? null,
      usage: response.usage ?? null,
    });
  }
  const text = (response.content ?? [])
    .filter(block => block?.type === "text")
    .map(block => block.text)
    .join("");
  return result(text, response, performance.now() - started, model);
}

export async function callOpenAI({
  system,
  messages,
  model = BLUE_ROOM_MODELS.openai,
  effort = DEFAULT_EFFORT,
  maxTokens = DIALOGUE_MAX_TOKENS,
  client,
  signal,
}) {
  requireRequest({ system, messages, model, maxTokens });
  const sdk = requireClient(client, "OPENAI_API_KEY", apiKey => new OpenAI({ apiKey }));
  const started = performance.now();
  const response = await sdk.responses.create({
    model,
    instructions: system,
    input: messages,
    reasoning: { effort },
    max_output_tokens: maxTokens,
    store: false,
    truncation: "disabled",
  }, signal ? { signal } : undefined);

  const incompleteReason = response.incomplete_details?.reason ?? null;
  const refused = (response.output ?? []).some(item =>
    item?.content?.some(content => content?.type === "refusal")
  );
  if (refused || incompleteReason === "content_filter") {
    throw new BlueRoomProviderError("refusal", {
      provider: "openai",
      reason: refused ? "refusal" : incompleteReason,
      usage: response.usage ?? null,
    });
  }
  if (incompleteReason === "max_output_tokens") {
    throw new BlueRoomProviderError("output_budget", {
      provider: "openai",
      reason: incompleteReason,
      usage: response.usage ?? null,
    });
  }
  if (response.status !== "completed") {
    throw new BlueRoomProviderError("provider_incomplete", {
      provider: "openai",
      reason: incompleteReason ?? response.status ?? null,
      usage: response.usage ?? null,
    });
  }
  const fallbackText = (response.output ?? [])
    .flatMap(item => item?.content ?? [])
    .filter(content => content?.type === "output_text")
    .map(content => content.text)
    .join("");
  return result(response.output_text || fallbackText, response, performance.now() - started, model);
}

// Cast each side using its own provider. A failed cast rejects creation;
// neither private brief is placed in the other provider's request.
export async function generatePersonas({
  contextPrompt,
  roles = { claude: 1, openai: 2 },
  models = BLUE_ROOM_MODELS,
  clients = {},
  effort = DEFAULT_EFFORT,
}) {
  // Each side is cast knowing which person it is. Casting without the role
  // and revealing it later would invent a character whose own brief can
  // contradict its assignment — a German speaker told afterwards that
  // person 1 speaks French.
  const claudeRequest = buildPersonaRequest({ contextPrompt, roleIndex: roles.claude });
  const openaiRequest = buildPersonaRequest({ contextPrompt, roleIndex: roles.openai });
  // Fail before starting either paid request if the other side cannot run.
  if (!clients.claude && !process.env.ANTHROPIC_API_KEY) {
    throw new BlueRoomProviderError("missing_api_key", { provider: "claude" });
  }
  if (!clients.openai && !process.env.OPENAI_API_KEY) {
    throw new BlueRoomProviderError("missing_api_key", { provider: "openai" });
  }
  const [claude, openai] = await Promise.all([
    callClaude({ ...claudeRequest, model: models.claude, effort, client: clients.claude }),
    callOpenAI({ ...openaiRequest, model: models.openai, effort, client: clients.openai }),
  ]);
  return {
    claude: { model: claude.provider.model, effort, roleIndex: roles.claude, persona: parsePersona(claude.text) },
    openai: { model: openai.provider.model, effort, roleIndex: roles.openai, persona: parsePersona(openai.text) },
  };
}

// Cosmetic metadata must never prevent a valid session from being created.
export async function generateTitleEmoji({
  contextPrompt,
  model = DEVELOPMENT_CLAUDE_MODEL,
  client,
}) {
  const request = buildMetadataRequest({ contextPrompt });
  try {
    const response = await callClaude({ ...request, model, maxTokens: 512, client });
    return parseMetadata(response.text);
  } catch {
    return { title: String(contextPrompt).trim().slice(0, 60), emoji: "🌀" };
  }
}
