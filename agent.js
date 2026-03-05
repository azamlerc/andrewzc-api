// agent.js — generic agentic loop for all bots
// Each bot provides: contextUrl, buildTools(context), executeTool(name, input), getExtraContext()

import Anthropic from "@anthropic-ai/sdk";

const MODEL      = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;
const TTL_MS     = 5 * 60 * 1000; // 5 minutes

// ---- Context cache (per bot, keyed by contextUrl) ----

const contextCaches = new Map(); // contextUrl -> { prompt, cachedAt }

async function loadContext(bot) {
  const cached = contextCaches.get(bot.contextUrl);
  if (cached && Date.now() - cached.cachedAt < TTL_MS) return cached.prompt;

  const files = await Promise.all(
    bot.contextFiles.map(url => fetch(url).then(r => r.text()))
  );

  const prompt = bot.assemblePrompt(files);
  contextCaches.set(bot.contextUrl, { prompt, cachedAt: Date.now() });
  return prompt;
}

// ---- Strip image CDN markdown from reply text ----

function stripImageMarkdown(text, cdnHost) {
  if (!cdnHost) return text;
  return text
    .replace(new RegExp(`\\[?!?\\[[^\\]]*\\]\\([^)]*${cdnHost}[^)]*\\)\\]?(?:\\([^)]*\\))?`, "g"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---- Main chat function ----

export async function chat(bot, history, userMessage) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const [systemPrompt, extraContext] = await Promise.all([
    loadContext(bot),
    bot.getExtraContext ? bot.getExtraContext() : Promise.resolve(null),
  ]);

  const tools    = bot.buildTools(extraContext);
  const client   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let images    = null;
  let imageList = null;

  while (true) {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const raw = response.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");
      const reply = stripImageMarkdown(raw, bot.imageCdnHost);
      return { reply, images, list: imageList };
    }

    if (response.stop_reason === "tool_use") {
      const toolResults = await Promise.all(
        response.content
          .filter(b => b.type === "tool_use")
          .map(async (toolUse) => {
            let result;
            try {
              result = await bot.executeTool(toolUse.name, toolUse.input);
            } catch (err) {
              result = { error: String(err.message) };
            }

            console.log(`[${bot.name}] tool=${toolUse.name} input=${JSON.stringify(toolUse.input)} images=${result?.images?.length ?? 0}`);

            // Capture images from any tool call that returns them
            if (result?.images?.length) {
              images    = result.images;
              imageList = result.list;
            }

            return {
              type:        "tool_result",
              tool_use_id: toolUse.id,
              content:     JSON.stringify(result),
            };
          })
      );

      messages.push({ role: "user", content: toolResults });
    }
  }
}

// ---- Preload a bot's context at startup ----

export async function preload(bot) {
  await Promise.all([
    loadContext(bot),
    bot.getExtraContext ? bot.getExtraContext() : Promise.resolve(),
  ]);
  console.log(`[${bot.name}] context loaded`);
}
