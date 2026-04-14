// connectors/slack.js
// Thin wrapper around the Slack Web API.
// Agents call post() and addReaction() — they never import @slack/web-api directly.

import { WebClient } from "@slack/web-api";

let _client = null;

function client() {
  if (!_client) {
    if (!process.env.SLACK_BOT_TOKEN) {
      throw new Error("SLACK_BOT_TOKEN not configured");
    }
    _client = new WebClient(process.env.SLACK_BOT_TOKEN);
  }
  return _client;
}

// Post a plain text or Block Kit message to a channel.
// Returns the message timestamp (ts) which can be stored for reaction handling.
export async function post(channel, text, blocks = null) {
  try {
    const payload = { channel, text };
    if (blocks) payload.blocks = blocks;
    const res = await client().chat.postMessage(payload);
    return res.ts;
  } catch (err) {
    console.error(`[slack] post to ${channel} failed:`, err.message);
    return null;
  }
}

// Add a reaction emoji to a message.
export async function addReaction(channel, ts, emoji) {
  try {
    await client().reactions.add({ channel, timestamp: ts, name: emoji });
  } catch (err) {
    // Ignore "already_reacted" — not an error
    if (!err.message?.includes("already_reacted")) {
      console.error(`[slack] addReaction failed:`, err.message);
    }
  }
}

// Post a flagged entity alert to #hygiene immediately.
export async function postHygieneFlag(entityKey, entityList, flagged) {
  const lines = flagged.map((f) => `• ${f.rule}: ${f.message}`).join("\n");
  const text =
    `⚠️ *${entityKey}* (${entityList}) needs review\n${lines}\n` +
    `→ andrewzc.net/admin/entity/${entityKey}`;
  return post("#hygiene", text);
}

// Post a single transit opening to #projects.
export async function postProjectOpening(entity, isNew) {
  const flag = entity.icons?.[0] ?? "";
  const transport = entity.icons?.[1] ?? "";
  const badge = isNew ? " ✨" : "";
  const text =
    `${flag}${transport} *${entity.name}*${badge}\n` +
    `Opened ${entity.prefix}\n` +
    `andrewzc.net/trains/projects#${entity.key}`;
  const ts = await post("#projects", text);
  if (ts && isNew) await addReaction("#projects", ts, "sparkles");
  return ts;
}

// Post a proposed entity to #ideas.
// Returns the ts so it can be stored on the proposal for reaction handling.
export async function postProposal(proposal) {
  const listLabel = proposal.list ? `[${proposal.list}]` : "";
  const text =
    `📍 *${proposal.suggestedFields?.name ?? proposal.key}* ${listLabel}\n` +
    `${proposal.reason}\n` +
    `👍 to add · 👎 to skip · reply with a reason if skipping`;
  return post("#ideas", text);
}

// Post a daily hygiene digest to #hygiene.
export async function postHygieneDigest(digestText) {
  if (!digestText) return;
  return post("#hygiene", digestText);
}

// Post an error or health summary to #admin.
export async function postAdmin(text) {
  return post("#admin", text);
}
