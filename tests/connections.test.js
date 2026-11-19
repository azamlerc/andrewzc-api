import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { MongoClient } from "mongodb";
import { agentRequest, applyResponse, promptVersion } from "../connections/agents.js";
import { rulesVersion } from "../connections/coordinator.js";
import { gameSummary, publicGame } from "../connections/projections.js";
import { finish, prepareCandidate, resolveGuess, stageGuess } from "../connections/rules.js";
import { createStore, digest, newGame } from "../connections/store.js";
import { createConnectionsRouter } from "../routes/connections.js";
import { fixture, scriptedModels } from "./fixtures/connections.js";

function board() {
  const game = newGame({ author: { provider: "openai" }, player: { provider: "claude" } });
  const { tiles, ...key } = prepareCandidate(fixture);
  Object.assign(game, { tiles, key, phase: "player", status: "playing" });
  const ids = (terms) => terms.map((term) => tiles.find(({ text }) => text === term).id);
  return { game, ids };
}

test("structural validation catches duplicate terms and overlapping groups", () => {
  const altered = structuredClone(fixture);
  altered.tiles[0].text = `  ${altered.tiles[1].text.toLowerCase()}  `;
  assert.throws(() => prepareCandidate(altered), /invalid_partition/);
  const overlap = structuredClone(fixture);
  overlap.groups[0].members[0].ref = overlap.groups[1].members[0].ref;
  assert.throws(() => prepareCandidate(overlap), /invalid_partition/);
});

test("scoring rejects repeated sets, hides one-away membership and reveals the title at loss", () => {
  const { game, ids } = board();
  const decoy = ids(fixture.decoy.refs);
  assert.equal(stageGuess(game, decoy), true);
  resolveGuess(game);
  assert.equal(game.guesses.at(-1).outcome, "incorrect");
  assert.equal(stageGuess(game, [...decoy].reverse()), false);
  for (const last of ["FLASH", "STAR", "LIME"]) {
    stageGuess(game, ids(["STOP", "PIPE", "PEDAL", last]));
    resolveGuess(game);
  }
  assert.deepEqual(Object.keys(game.guesses[1]).sort(), ["mistakes", "outcome", "tileIds"]);
  assert.equal(game.guesses[1].outcome, "one_away");
  assert.equal(game.mistakes, 0);
  assert.equal(game.status, "lost");
  assert.equal(publicGame(game).title, fixture.title);
  assert.equal(game.events.at(-1).title, fixture.title);
});

test("private context, title, and held host text stay outside public projections", () => {
  const { game } = board();
  applyResponse(game, JSON.stringify({ say: "Maybe these are all dances.", privateStateUpdate: "candidate-player" }));
  assert.equal(game.guesses.length, 0);
  assert.equal(game.mistakes, 4);
  const hostRequest = JSON.stringify(agentRequest(game));
  assert.doesNotMatch(hostRequest, /candidate-player|Under the Spotlight/);
  assert.ok(hostRequest.includes(fixture.groups[0].rule));
  applyResponse(game, JSON.stringify({ say: fixture.title, privateStateUpdate: "candidate-author" }));
  const playerRequest = JSON.stringify(agentRequest(game));
  assert.doesNotMatch(playerRequest, /candidate-author|Under the Spotlight|Pipe organ components/);
  assert.match(playerRequest, /candidate-player/);
  assert.doesNotMatch(JSON.stringify(publicGame(game)), /candidate-(author|player)|Under the Spotlight/);
  finish(game, "ended", "director");
  assert.equal(gameSummary(game).title, undefined);
  assert.equal(game.events.at(-1).title, undefined);
});

test("a separate editorial review must pass before a candidate becomes public", () => {
  const game = newGame({ author: { provider: "openai" }, player: { provider: "claude" } });
  applyResponse(game, JSON.stringify(fixture));
  assert.equal(game.status, "validating");
  assert.deepEqual(publicGame(game).tiles, []);
  assert.deepEqual(Object.keys(JSON.parse(agentRequest(game).messages[0].content)), ["tiles"]);
  applyResponse(game, '{"observations":"The purple rule is weak."}');
  applyResponse(game, '{"pass":false,"feedback":"Make purple uniform."}');
  assert.equal(game.phase, "generate");
  assert.deepEqual(publicGame(game).tiles, []);
});

const uri = process.env.CONNECTIONS_TEST_MONGO;
test("Mongo-backed HTTP flow saves a win in either assignment, fences races and protects private data", { skip: !uri }, async (t) => {
  assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+(?:\/|$)/);
  const mongo = await MongoClient.connect(uri);
  const db = mongo.db(`connections_test_${randomBytes(8).toString("hex")}`);
  const store = createStore(async () => db);
  await db.collection("connections_games").createIndex({ creation: 1 }, { unique: true });
  const callLog = [];
  const app = express();
  app.use(express.json());
  app.use("/connections", createConnectionsRouter(store, { modelCalls: scriptedModels(callLog, 25) }));
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.dropDatabase();
    await mongo.close();
  });
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/connections`;

  async function request(path, body, token) {
    const response = await fetch(`${base}${path}`, {
      ...(body && { method: "POST", body: JSON.stringify(body) }),
      headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    });
    return { status: response.status, ...await response.json() };
  }

  for (const author of ["openai", "claude"]) {
    const token = randomBytes(32).toString("hex");
    const body = { author, creation: randomUUID() };
    const begin = callLog.length;
    let { game } = await request("/games", body, token);
    const path = `/games/${game.id}`;
    assert.equal((await request("/games", body, token)).game.id, game.id);
    assert.equal((await request(`${path}/advance`, { revision: game.revision })).status, 403);

    const start = { revision: game.revision };
    const first = await Promise.all([request(`${path}/advance`, start, token), request(`${path}/advance`, start, token)]);
    assert.equal(first.filter(({ reason }) => reason === "advanced").length, 1);
    assert.equal(callLog.length - begin, 1);
    assert.equal(callLog.at(-1).provider, author);
    assert.equal((await request(`${path}/advance`, start, token)).reason, "stale");
    game = (await request(path)).game;

    for (let i = 0; game.canAdvance && i < 50; i++) {
      if (!["won", "lost"].includes(game.status)) {
        assert.doesNotMatch(JSON.stringify(game), /Under the Spotlight|AUTHOR-MEMORY-ONLY|PLAYER-MEMORY-ONLY|Compounds ending in light/);
      }
      if (game.pendingGuess) {
        if (!game.events.some(({ type }) => type === "guess_resolved")) {
          assert.equal(game.mistakes, 4);
          const paused = await request(`${path}/control`, { revision: game.revision, command: "pause" }, token);
          assert.equal(paused.game.status, "paused");
          assert.deepEqual(paused.game.pendingGuess, game.pendingGuess);
          ({ game } = await request(`${path}/control`, { revision: paused.game.revision, command: "resume" }, token));
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, game.pendingGuess.resolveAfter - Date.now() + 5)));
      }
      ({ game } = await request(`${path}/advance`, { revision: game.revision }, token));
    }
    assert.equal(game.status, "won");
    assert.equal(game.title, fixture.title);
    assert.equal(game.mistakes, 2);
    assert.equal(game.solved.length, 4);
    assert.equal(game.events.filter(({ type }) => type === "retrospective").length, 2);
    assert.deepEqual((await request(path)).game.events, game.events);
    assert.equal((await request("/games")).games.find(({ id }) => id === game.id).title, fixture.title);
    for (const { provider, request } of callLog.slice(begin)) {
      if (provider === author) continue;
      const input = JSON.parse(request.messages[0].content);
      if ("solution" in input) continue;
      assert.doesNotMatch(JSON.stringify(input), /Under the Spotlight|AUTHOR-MEMORY-ONLY|Compounds ending in light/);
    }
  }

  const game = newGame({
    author: { provider: "openai", model: "test" }, player: { provider: "claude", model: "test" }, creation: randomUUID(),
    controller: digest("test"), rulesVersion, promptVersions: { author: promptVersion("author"), player: promptVersion("player") },
  });
  await store.insert(game);
  const claim = await store.claim(game, true);
  const paused = { ...game, status: "paused", resumeStatus: "creating" };
  await store.commit(paused);
  assert.equal(await store.commit(claim, claim.claim), null);
  assert.equal((await store.get(game._id)).calls, 1);
});
