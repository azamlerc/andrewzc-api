// chat/runtime.js — generic runtime for all chatbots
// Each chatbot provides: contextUrl, buildTools(context), executeTool(name, input), getExtraContext()

import Anthropic from "@anthropic-ai/sdk";

const MODEL           = "claude-sonnet-4-6";
const MAX_TOKENS      = 1024;
const TTL_MS     = 5 * 60 * 1000; // 5 minutes

// ---- Context cache (per chatbot, keyed by contextUrl) ----

const contextCaches = new Map(); // contextUrl -> { prompt, cachedAt }

async function loadContext(chatbot) {
  // Chatbots can provide their own loadSystemPrompt() for custom assembly logic
  if (chatbot.loadSystemPrompt) return chatbot.loadSystemPrompt();

  const cached = contextCaches.get(chatbot.contextUrl);
  if (cached && Date.now() - cached.cachedAt < TTL_MS) return cached.prompt;

  const files = await Promise.all(
    chatbot.contextFiles.map(url => fetch(url).then(r => r.text()))
  );

  const prompt = chatbot.assemblePrompt(files);
  contextCaches.set(chatbot.contextUrl, { prompt, cachedAt: Date.now() });
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

export async function runChat(chatbot, history, userMessage) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const [systemPrompt, extraContext] = await Promise.all([
    loadContext(chatbot),
    chatbot.getExtraContext ? chatbot.getExtraContext() : Promise.resolve(null),
  ]);

  const tools    = chatbot.buildTools(extraContext);
  const client   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let images    = null;
  let imageList = null;

  while (true) {
    const response = await client.messages.create({
      model:      chatbot.model     ?? MODEL,
      max_tokens: chatbot.maxTokens ?? MAX_TOKENS,
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
      const reply = stripImageMarkdown(raw, chatbot.imageCdnHost);
      return { reply, images, list: imageList };
    }

    if (response.stop_reason === "tool_use") {
      const toolResults = await Promise.all(
        response.content
          .filter(b => b.type === "tool_use")
          .map(async (toolUse) => {
            let result;
            try {
              result = await chatbot.executeTool(toolUse.name, toolUse.input);
            } catch (err) {
              result = { error: String(err.message) };
            }

            console.log(`[${chatbot.name}] tool=${toolUse.name} input=${JSON.stringify(toolUse.input)} images=${result?.images?.length ?? 0}`);

            // Capture images from any tool call that returns them
            if (result?.images?.length) {
              const all = result.images;
              if (all.length <= 3) {
                images = all;
              } else {
                // Pick 3 distinct random images
                const picked = new Set();
                while (picked.size < 3) picked.add(all[Math.floor(Math.random() * all.length)]);
                images = [...picked];
              }
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

// ---- Preload a chatbot's context at startup ----

export async function preloadChat(chatbot) {
  await Promise.all([
    loadContext(chatbot),
    chatbot.getExtraContext ? chatbot.getExtraContext() : Promise.resolve(),
  ]);
  console.log(`[${chatbot.name}] context loaded (${chatbot.name})`);
}
