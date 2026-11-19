import { agentRequest, applyFailure, applyResponse, localPhases, maxActiveMs, maxCalls, promptVersion, providers } from "./agents.js";
import { finish, resolveGuess, terminal } from "./rules.js";

export const rulesVersion = "1";

function phaseAfterLimit(game) {
  if (terminal(game.status)) game.phase = "done";
  else if (game.key) finish(game, "ended", "budget");
  else {
    game.status = "failed";
    game.phase = "done";
    game.failure = game.generationCount >= 3 ? "puzzle_rejected" : "budget";
  }
}

export async function advance(game, { store, client, modelCalls = providers, timeoutMs = 36000 }) {
  if (game.phase === "done" || (!terminal(game.status) && ["paused", "failed"].includes(game.status))) {
    return { game, reason: "stopped" };
  }
  if (game.phase === "resolve" && game.pendingGuess.resolveAfter > Date.now()) {
    return { game, reason: "preview" };
  }

  const paid = !localPhases.has(game.phase);
  const exhausted = paid && (game.calls >= (terminal(game.status) ? maxCalls : maxCalls - 2) ||
    (!terminal(game.status) && game.activeMs >= maxActiveMs) || (game.phase === "generate" && game.generationCount >= 3));
  const incompatible = paid && (game.rulesVersion !== rulesVersion ||
    ["author", "player"].some((role) => game.promptVersions[role] !== promptVersion(role)));
  const claimed = await store.claim(game, paid && !exhausted && !incompatible);
  if (!claimed) return { game: await store.get(game._id), reason: "busy" };
  const claim = claimed.claim;

  if (incompatible) {
    if (terminal(claimed.status)) claimed.phase = "done";
    else {
      claimed.phase = "done";
      claimed.status = "failed";
      claimed.failure = "version_changed";
    }
  } else if (exhausted) phaseAfterLimit(claimed);
  else if (!paid) resolveGuess(claimed);
  else {
    let slot;
    try {
      slot = await store.providerSlot(client);
    } catch (error) {
      await store.release(claimed);
      throw error;
    }
    if (!slot.release) {
      await store.release(claimed);
      return { game: await store.get(game._id), reason: slot.reason };
    }
    const startedAt = Date.now();
    const beforeResponse = structuredClone({ ...claimed, _id: null, claim: null });
    try {
      if (!await store.ownsClaim(claimed)) return { game: await store.get(game._id), reason: "stale" };
      const { role, ...request } = agentRequest(claimed);
      const { provider, model } = claimed[role];
      const result = await modelCalls[provider]({ ...request, model, maxRetries: 0, signal: AbortSignal.timeout(timeoutMs) });
      try {
        applyResponse(claimed, result.text);
      } catch (error) {
        Object.assign(claimed, { ...beforeResponse, _id: game._id });
        applyFailure(claimed, error, { malformed: true });
      }
    } catch (error) {
      applyFailure(claimed, error);
    } finally {
      claimed.activeMs += Date.now() - startedAt;
      try { await slot.release(); } catch { /* The slot lease expires without intervention. */ }
    }
  }
  const updated = await store.commit(claimed, claim);
  return { game: updated ?? await store.get(game._id), reason: updated ? "advanced" : "stale" };
}

export async function control(game, command, store) {
  if (terminal(game.status)) return null;
  if (command === "end") finish(game, "ended", "director");
  else if (command === "pause" && ["creating", "validating", "playing"].includes(game.status)) {
    game.resumeStatus = game.status;
    game.status = "paused";
  } else if (command === "resume" && ["paused", "failed"].includes(game.status) && game.phase !== "done") {
    game.status = game.resumeStatus;
    game.resumeStatus = null;
    game.failure = null;
  } else return null;
  return store.commit(game);
}
