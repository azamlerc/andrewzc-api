// agents/runRecords.js
// Write and query agent_runs documents.

import { connectToMongo } from "../database.js";

export async function writeRunRecord(doc) {
  const db = await connectToMongo();
  const record = {
    ...doc,
    ts: new Date(),
  };
  const result = await db.collection("agent_runs").insertOne(record);
  return { ...record, _id: result.insertedId };
}

export async function getRecentRuns(agent, limitHours = 24) {
  const db = await connectToMongo();
  const since = new Date(Date.now() - limitHours * 60 * 60 * 1000);
  return db
    .collection("agent_runs")
    .find({ agent, ts: { $gte: since } })
    .sort({ ts: -1 })
    .toArray();
}

export async function getRunsForEntity(entityKey) {
  const db = await connectToMongo();
  return db
    .collection("agent_runs")
    .find({ entityKey })
    .sort({ ts: -1 })
    .limit(20)
    .toArray();
}
