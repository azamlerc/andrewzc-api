import { named, terminal } from "./rules.js";

export function gameSummary(game) {
  return {
    id: String(game._id), createdAt: game.createdAt, status: game.status,
    author: game.author, player: game.player,
    ...(named(game.status) ? { title: game.key.title } : {}),
  };
}

const failureStages = {
  generate: "authoring", cold_review: "cold_review", quality_review: "quality_review",
  host: "author_turn", player: "player_turn",
};

export function publicGame(game) {
  return {
    ...gameSummary(game),
    revision: game.revision,
    tiles: game.tiles,
    solved: game.solved,
    mistakes: game.mistakes,
    pendingGuess: game.pendingGuess,
    hintCount: game.hintCount,
    events: game.events,
    activity: game.phase === "done" ? "done"
      : game.phase === "resolve" ? "preview"
      : game.phase.startsWith("retrospective") ? "retrospective"
      : game.status === "playing" ? "thinking" : game.status,
    canAdvance: game.phase !== "done" && (terminal(game.status) || !["paused", "failed"].includes(game.status)),
    ...(game.failure ? { failure: game.failure } : {}),
    ...(["malformed_output", "provider_timeout"].includes(game.failure) && failureStages[game.phase]
      ? { failureStage: failureStages[game.phase] } : {}),
  };
}

export function modelBoard(game) {
  return {
    tiles: game.tiles, solved: game.solved, mistakesRemaining: game.mistakes, guesses: game.guesses,
    hintCount: game.hintCount, requestedHint: game.requestedHint,
    conversation: game.events.filter(({ type }) => ["chat", "hint", "hint_requested"].includes(type)).slice(-16),
  };
}
