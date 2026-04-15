// chat/senza.js — Sergio, the Senza developer documentation chat
// Answers questions about the Senza cloud TV platform.
// Loads all 15 context files at startup; workflows and tutorials fetched on demand.

const REPO_RAW = "https://raw.githubusercontent.com/synamedia-senza/senza-developer-context/main";

// ---- Fetch a file from the context repo ----

async function fetchDoc(path) {
  const res = await fetch(`${REPO_RAW}/${path}`);
  if (!res.ok) throw new Error(`Doc not found: ${path} (${res.status})`);
  return res.text();
}

// ---- Tool definitions ----

function buildTools() {
  return [
    {
      name: "listDocs",
      description: "List all available documentation files with descriptions. Good starting point for broad questions about what's covered.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "readDoc",
      description: "Read the full contents of a documentation file by path. Use for workflows (e.g. 'workflows/02-remote-player-video.md'), tutorials (e.g. 'tutorials/video/playing-video.md'), or any specific file you know covers the topic.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to repo root" },
        },
        required: ["path"],
      },
    },
    {
      name: "searchDocs",
      description: "Search all documentation files for a keyword or phrase. Returns matching file paths with excerpts. Use when you're not sure which file covers a topic.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword or phrase, e.g. 'DRM', 'lifecycle states', 'device authentication'" },
        },
        required: ["query"],
      },
    },
  ];
}

// ---- Tool execution ----

async function searchDocsImpl(query) {
  // Fetch all index files and search their content
  const indexPaths = [
    "context/INDEX.md",
    "workflows/INDEX.md",
    "tutorials/INDEX.md",
  ];

  const results = [];
  const q = query.toLowerCase();

  await Promise.all(indexPaths.map(async (indexPath) => {
    try {
      const content = await fetchDoc(indexPath);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          const linkMatch = lines[i].match(/\[.*?\]\(\.\/(.*?\.md)\)/);
          const path = linkMatch
            ? indexPath.replace("INDEX.md", linkMatch[1])
            : null;
          results.push({
            path,
            excerpt: lines.slice(Math.max(0, i - 1), i + 3).join("\n").trim(),
          });
        }
      }
    } catch { /* skip */ }
  }));

  if (results.length === 0) {
    return { message: `No matches for "${query}" in index files. Try readDoc on a specific context file.` };
  }

  return { query, matches: results.slice(0, 10) };
}

async function executeTool(name, input) {
  switch (name) {
    case "listDocs": {
      const content = await fetchDoc("INDEX.md");
      return { content };
    }
    case "readDoc": {
      const content = await fetchDoc(input.path);
      return { path: input.path, content };
    }
    case "searchDocs": {
      return await searchDocsImpl(input.query);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- System prompt assembly ----
// All 15 context files are loaded at startup and embedded in the system prompt.
// Workflows and tutorials (~150 files) are fetched on demand via tools.

let cachedPrompt    = null;
let cachedAt        = 0;
const TTL_MS        = 5 * 60 * 1000;

async function loadSystemPrompt() {
  if (cachedPrompt && Date.now() - cachedAt < TTL_MS) return cachedPrompt;

  const [contextIndex, workflowsIndex, ...contextFiles] = await Promise.all([
    fetchDoc("context/INDEX.md"),
    fetchDoc("workflows/INDEX.md"),
    fetchDoc("context/01-platform-architecture.md"),
    fetchDoc("context/02-sdk-client-library.md"),
    fetchDoc("context/03-lifecycle-states.md"),
    fetchDoc("context/04-video-playback.md"),
    fetchDoc("context/05-remote-control-input.md"),
    fetchDoc("context/06-state-preservation.md"),
    fetchDoc("context/07-authentication.md"),
    fetchDoc("context/08-video-format-cdn.md"),
    fetchDoc("context/09-developer-tools.md"),
    fetchDoc("context/10-messaging-and-alarms.md"),
    fetchDoc("context/11-management-api.md"),
    fetchDoc("context/12-techniques.md"),
    fetchDoc("context/13-analytics.md"),
    fetchDoc("context/14-network-cdn-protected-content.md"),
    fetchDoc("context/15-reference.md"),
  ]);

  cachedPrompt = `You are Sergio, a friendly and knowledgeable assistant for developers building on the Senza cloud TV platform.

When a user first says hello or introduces themselves, greet them warmly and let them know you're here to help. A good opening looks like:

"Hi! I'm Sergio, and I can answer any questions you have about developing apps on Senza! Whether you're just getting started, working through a specific integration, or trying to debug something — I've got the full docs and I'm happy to help. What are you working on?"

Keep that tone throughout: enthusiastic, helpful, and practical. Senza is genuinely a cool platform — web apps running in a cloud browser, with only the video stream sent to the device. It makes a lot of hard TV problems surprisingly easy.

## How to answer

The full platform context (all 15 reference files) is embedded below — use it to answer conceptual questions directly.

The workflows index is also embedded. When a user asks how to do something step-by-step, identify the right workflow from the index and use readDoc to fetch the full file before answering.

For tutorial questions (specific sample apps, code walkthroughs), use searchDocs or readDoc to find the right file — don't try to answer from memory.

If you're not sure which file covers something, use searchDocs first.

## Style

- Be direct and practical. Include working code examples when relevant.
- Call out Senza-specific gotchas clearly — there are real differences from standard web or smart TV dev.
- If something isn't in the docs, say so honestly rather than guessing.
- For simple questions, answer concisely. For complex ones, structure the answer clearly.

---

## Platform context index

${contextIndex}

---

## Workflows index

${workflowsIndex}

---

${contextFiles.join("\n\n---\n\n")}
`;

  cachedAt = Date.now();
  return cachedPrompt;
}

// ---- Chat definition ----

export const senzaChat = {
  name:             "senza",
  contextUrl:       REPO_RAW,    // used as cache key
  imageCdnHost:     null,
  loadSystemPrompt,              // overrides generic TTL loader in chat/runtime.js
  buildTools,
  executeTool,
};
