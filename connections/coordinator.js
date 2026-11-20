import { agentRequest, applyFailure, applyResponse, localPhases, maxActiveMs, maxCalls, promptVersion, providers } from "./agents.js";
import { completeFinalGuess, finish, isFinalPlayerTurn, resolveGuess, terminal } from "./rules.js";

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

function modelTimeout(game) {
  if (isFinalPlayerTurn(game)) return 8000;
  if (game.phase === "generate") return 90000;
  if (game.status === "validating") return 60000;
  return 36000;
}

export async function advance(game, { store, client, modelCalls = providers, timeoutMs = modelTimeout(game) }) {
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
  const leaseDuration = timeoutMs + 10000;
  const claimed = await store.claim(game, paid && !exhausted && !incompatible, leaseDuration);
  if (!claimed) return { game: await store.get(game._id), reason: "busy" };
  const claim = claimed.claim;

  if ((exhausted || incompatible) && isFinalPlayerTurn(claimed)) {
    completeFinalGuess(claimed);
  } else if (incompatible) {
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
      slot = await store.providerSlot(client, leaseDuration);
    } catch (error) {
      await store.release(claimed);
      throw error;
    }
    if (!slot.release) {
      await store.release(claimed);
      if (isFinalPlayerTurn(claimed)) {
        const fallback = await store.claim(game, false);
        if (fallback) {
          completeFinalGuess(fallback);
          const updated = await store.commit(fallback, fallback.claim);
          if (updated) return { game: updated, reason: "advanced" };
        }
      }
      return { game: await store.get(game._id), reason: slot.reason };
    }
    const startedAt = Date.now();
    const beforeResponse = structuredClone({ ...claimed, _id: null, claim: null });
    let signal;
    try {
      if (!await store.ownsClaim(claimed)) return { game: await store.get(game._id), reason: "stale" };
      const { role, ...request } = agentRequest(claimed);
      const { provider, model } = claimed[role];
      signal = AbortSignal.timeout(timeoutMs);
      const result = await modelCalls[provider]({ ...request, model, maxRetries: 0, signal });
      try {
        applyResponse(claimed, result.text);
      } catch (error) {
        const kind = error instanceof SyntaxError ? "invalid_json"
          : error?.name === "ZodError" ? "invalid_schema" : "invalid_response";
        console.warn("connections: rejected model output", { gameId: String(game._id), phase: claimed.phase, provider, kind });
        Object.assign(claimed, { ...beforeResponse, _id: game._id });
        applyFailure(claimed, error, { malformed: true });
      }
    } catch (error) {
      applyFailure(claimed, error, { timedOut: signal?.aborted });
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
