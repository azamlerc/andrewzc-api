import { randomUUID, randomInt } from "node:crypto";
import { z } from "zod";

const colors = ["yellow", "green", "blue", "purple"];
const ref = z.string().trim().min(1).max(40);
const quartet = z.array(ref).length(4);
const text = (limit) => z.string().trim().min(1).max(limit);
const group = z.object({
  color: z.enum(colors),
  title: text(90),
  rule: text(360),
  members: z.array(z.object({ ref, explanation: text(330) }).strict()).length(4),
}).strict();
const candidateSchema = z.object({
  title: text(60),
  tiles: z.array(z.object({ ref, text: text(28) }).strict()).length(16),
  groups: z.array(group).length(4),
  decoy: z.object({ title: text(90), refs: quartet, explanation: text(440) }).strict(),
}).strict();

export const hintLevel = z.enum(["direction", "mechanism"]);
export const turnSchema = z.object({
  say: text(440).optional(),
  privateStateUpdate: text(800).optional(),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("submit_guess"), tileIds: z.array(z.string().uuid()).length(4) }).strict(),
    z.object({ type: z.literal("request_hint"), level: hintLevel, topic: text(90).optional() }).strict(),
    z.object({ type: z.literal("give_hint"), level: hintLevel, message: text(280) }).strict(),
  ]).optional(),
}).strict();

export const terminal = (status) => ["won", "lost", "ended"].includes(status);
export const named = (status) => status === "won" || status === "lost";
export const normalize = (value) => value.normalize("NFKC").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function prepareCandidate(input) {
  const value = candidateSchema.parse(input);
  const terms = value.tiles.map((tile) => tile.text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase());
  const ids = new Map(value.tiles.map(({ ref }) => [ref, randomUUID()]));
  const members = value.groups.flatMap((row) => row.members.map((member) => member.ref));
  const decoyRefs = value.decoy.refs;
  const decoyGroups = value.groups.filter((row) => row.members.some((member) => decoyRefs.includes(member.ref)));
  if (!normalize(value.title) || ids.size !== 16 || new Set(terms).size !== 16 || terms.some((term) => !normalize(term)) ||
      new Set(value.groups.map((row) => row.color)).size !== 4 ||
      new Set(members).size !== 16 || members.some((id) => !ids.has(id)) ||
      new Set(decoyRefs).size !== 4 || decoyRefs.some((id) => !ids.has(id)) || decoyGroups.length < 3) {
    throw new Error("invalid_partition");
  }
  const groups = value.groups.map(({ color, title, rule, members }) => ({
    color, title, rule, members: members.map(({ ref, explanation }) => ({ id: ids.get(ref), explanation })),
  }));
  const tiles = value.tiles.map(({ ref, text }) => ({ id: ids.get(ref), text }));
  for (let attempt = 0; attempt < 80; attempt++) {
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }
    if (!groups.some((row) => {
      const positions = row.members.map(({ id }) => tiles.findIndex((tile) => tile.id === id));
      return new Set(positions.map((i) => Math.floor(i / 4))).size === 1 ||
        new Set(positions.map((i) => i % 4)).size === 1;
    })) {
      return {
        tiles, groups, title: value.title,
        decoy: { title: value.decoy.title, explanation: value.decoy.explanation, tileIds: decoyRefs.map((ref) => ids.get(ref)) },
      };
    }
  }
  throw new Error("shuffle_failed");
}

export function guessKey(tileIds) {
  return [...tileIds].sort().join(",");
}

export function publicGroup(row) {
  return { color: row.color, title: row.title, tileIds: row.members.map(({ id }) => id) };
}

export function addEvent(game, type, payload = {}) {
  game.events.push({ seq: game.events.length + 1, at: new Date(), type, ...payload });
}

export function finish(game, status, reason) {
  game.status = status;
  game.phase = game.key ? "retrospective_author" : "done";
  game.pendingGuess = null;
  game.requestedHint = null;
  game.stagedHost = null;
  game.candidate = null;
  game.coldReview = null;
  game.feedback = null;
  game.failure = null;
  addEvent(game, "outcome", { status, reason });
  if (game.key) {
    addEvent(game, "solution_revealed", {
      groups: game.key.groups.map((row) => ({
        ...publicGroup(row), rule: row.rule, members: row.members.map(({ id, explanation }) => ({ id, explanation })),
      })),
      decoy: game.key.decoy,
      ...(named(status) ? { title: game.key.title } : {}),
    });
  }
}

export function stageGuess(game, tileIds, now = Date.now()) {
  const available = new Set(game.tiles.map(({ id }) => id));
  for (const row of game.solved) for (const id of row.tileIds) available.delete(id);
  const key = guessKey(tileIds);
  if (tileIds.length !== 4 || new Set(tileIds).size !== 4 || tileIds.some((id) => !available.has(id)) ||
      game.guesses.some((guess) => guessKey(guess.tileIds) === key)) return false;
  game.pendingGuess = { tileIds, resolveAfter: now + 700 };
  game.phase = "resolve";
  addEvent(game, "guess_previewed", { tileIds });
  return true;
}

export function resolveGuess(game, automatic = false) {
  const tileIds = game.pendingGuess.tileIds;
  const unsolved = game.key.groups.filter((row) => !game.solved.some(({ color }) => color === row.color));
  const overlaps = unsolved.map((row) => row.members.filter(({ id }) => tileIds.includes(id)).length);
  const match = unsolved[overlaps.indexOf(4)];
  const outcome = match ? "correct" : overlaps.includes(3) ? "one_away" : "incorrect";
  const group = match ? publicGroup(match) : null;
  if (group) game.solved.push(group);
  else game.mistakes--;
  const result = { tileIds, outcome, mistakes: game.mistakes, ...(group && { group }), ...(automatic && { automatic }) };
  game.guesses.push(result);
  game.pendingGuess = null;
  game.idle = 0;
  game.playerFeedback = null;
  addEvent(game, "guess_resolved", result);
  if (game.solved.length === 4) finish(game, "won", "solved");
  else if (game.mistakes === 0) finish(game, "lost", "mistakes");
  else game.phase = "host";
}
