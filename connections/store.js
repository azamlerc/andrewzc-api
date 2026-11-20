import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { connectToMongo } from "../database.js";

const collection = "connections_games";
const quotas = "connections_quotas";
const slots = "connections_provider_slots";
export const leaseMs = 45000;

export const digest = (token) => createHash("sha256").update(token).digest("hex");

export function controlsGame(game, token) {
  return Boolean(token && timingSafeEqual(Buffer.from(game.controller, "hex"), Buffer.from(digest(token), "hex")));
}

export function newGame({ author, player, creation, controller, promptVersions, rulesVersion }) {
  return {
    _id: new ObjectId(), createdAt: new Date(), author, player, creation, controller,
    promptVersions, rulesVersion, revision: 0, status: "creating", phase: "generate", claim: null,
    calls: 0, activeMs: 0, generationCount: 0, tiles: [], solved: [], mistakes: 4, guesses: [],
    pendingGuess: null, requestedHint: null, hintCount: 0, idle: 0, playerFeedback: null,
    events: [], memory: { author: null, player: null }, candidate: null, coldReview: null,
    feedback: null, reviewRetried: false, key: null, stagedHost: null, failure: null, resumeStatus: null,
  };
}

export async function ensureConnectionsIndexes() {
  const db = await connectToMongo();
  await db.collection(collection).createIndex({ createdAt: -1, _id: -1 });
  await db.collection(collection).createIndex({ creation: 1 }, { unique: true });
  await db.collection(quotas).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

export function createStore(getDb = connectToMongo) {
  async function games() { return (await getDb()).collection(collection); }

  // Upsert a window counter. An existing exhausted bucket cannot match the
  // filter, so the unique _id makes a competing upsert a clean quota denial.
  async function takeQuota(key, windowMs, limit) {
    const window = Math.floor(Date.now() / windowMs);
    try {
      await (await getDb()).collection(quotas).updateOne(
        { _id: `${key}:${windowMs}:${window}`, used: { $lt: limit } },
        { $inc: { used: 1 }, $setOnInsert: { expiresAt: new Date((window + 1) * windowMs) } },
        { upsert: true },
      );
      return true;
    } catch (error) {
      if (error.code === 11000) return false;
      throw error;
    }
  }

  return {
    get: async (id) => (await games()).findOne({ _id: id }),
    byCreation: async (creation) => (await games()).findOne({ creation }),
    async insert(game) {
      try {
        await (await games()).insertOne(game);
        return game;
      } catch (error) {
        if (error.code !== 11000) throw error;
        return (await games()).findOne({ creation: game.creation });
      }
    },
    async list(cursor, limit) {
      const filter = cursor ? {
        $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }],
      } : {};
      return (await games()).find(filter, {
        projection: { createdAt: 1, author: 1, player: 1, status: 1, "key.title": 1, "key.emoji": 1 },
      }).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
    },
    claim: async (game, paid, leaseDuration = leaseMs) => (await games()).findOneAndUpdate({
      _id: game._id, revision: game.revision,
      $or: [{ claim: null }, { "claim.expiresAt": { $lte: new Date() } }],
    }, {
      $set: { claim: { id: randomUUID(), expiresAt: new Date(Date.now() + leaseDuration) } },
      ...(paid && { $inc: { calls: 1, ...(game.phase === "generate" ? { generationCount: 1 } : {}) } }),
    }, { returnDocument: "after" }),
    async release(game) {
      await (await games()).updateOne({ _id: game._id, revision: game.revision, "claim.id": game.claim.id }, {
        $set: { claim: null },
        $inc: { calls: -1, ...(game.phase === "generate" ? { generationCount: -1 } : {}) },
      });
    },
    async ownsClaim(game) {
      return Boolean(await (await games()).findOne({
        _id: game._id, revision: game.revision, "claim.id": game.claim.id, "claim.expiresAt": { $gt: new Date() },
      }, { projection: { _id: 1 } }));
    },
    async commit(game, claim = null) {
      const { _id, revision, calls, generationCount, activeMs, ...record } = game;
      // The claim increments counters before the provider call and does not
      // change revision. A racing control must preserve these reservations.
      if (claim) Object.assign(record, { calls, generationCount, activeMs });
      return (await games()).findOneAndUpdate({
        _id, revision,
        ...(claim && { "claim.id": claim.id, "claim.expiresAt": { $gt: new Date() } }),
      }, { $set: { ...record, claim: null }, $inc: { revision: 1 } }, { returnDocument: "after" });
    },
    creationAllowed: async (client) => takeQuota(`create:${client}`, 3600000, 6),
    async providerSlot(client, leaseDuration = leaseMs) {
      const providerSlots = (await getDb()).collection(slots);
      const id = randomUUID();
      for (let slot = 0; slot < 3; slot++) {
        try {
          await providerSlots.updateOne(
            { _id: slot, expiresAt: { $lte: new Date() } },
            { $set: { id, expiresAt: new Date(Date.now() + leaseDuration) } },
            { upsert: true },
          );
        } catch (error) {
          if (error.code === 11000) continue;
          throw error;
        }
        const release = () => providerSlots.updateOne({ _id: slot, id }, { $set: { expiresAt: new Date(0) } });
        let reserved = false;
        try {
          reserved = await takeQuota(`advance:${client}`, 3600000, 80) && await takeQuota("global", 86400000, 400);
        } finally {
          if (!reserved) await release();
        }
        return reserved ? { release } : { reason: "rate_limited" };
      }
      return { reason: "busy" };
    },
  };
}
