// agents/scheduler.js
// Initialises the change stream listener and all cron jobs.
// Called once at server startup: initScheduler()

import cron from "node-cron";
import { connectToMongo } from "../database.js";
import { runForEntity, runBatch, buildDailyDigest } from "./hygiene.js";
import { run as runProjects } from "./projects.js";
import { refreshNow as refreshPageCache } from "./pageCache.js";
import { postHygieneFlag, postHygieneDigest, postAdmin } from "../connectors/slack.js";

let changeStream = null;

export async function initScheduler() {
  console.log("[scheduler] initialising");

  const db = await connectToMongo();

  // Pre-warm the page cache
  await refreshPageCache();

  // ---- Change stream: hygiene on every entity insert/update ----
  if (process.env.NODE_ENV === "production") {
    startChangeStream(db);
  } else {
    console.log("[scheduler] change stream disabled in development");
  }

  // ---- Hourly: catch anything the change stream missed ----
  cron.schedule("0 * * * *", async () => {
    console.log("[scheduler] cron: hourly hygiene batch");
    try {
      const { summary } = await runBatch("cron-hourly");
      if (summary.flagged > 0) {
        await postAdmin(
          `Hourly hygiene batch: ${summary.fixed} fixes, ${summary.flagged} flagged`
        );
      }
    } catch (err) {
      console.error("[scheduler] hourly batch error:", err.message);
      await postAdmin(`⚠️ Hourly hygiene batch error: ${err.message}`);
    }
  });

  // ---- Daily 06:00 UTC: hygiene digest ----
  cron.schedule("0 6 * * *", async () => {
    console.log("[scheduler] cron: daily hygiene digest");
    try {
      const digest = await buildDailyDigest();
      if (digest) await postHygieneDigest(digest);
    } catch (err) {
      console.error("[scheduler] daily digest error:", err.message);
      await postAdmin(`⚠️ Daily hygiene digest error: ${err.message}`);
    }
  });

  // ---- Daily 06:05 UTC: transit projects monitor ----
  cron.schedule("5 6 * * *", async () => {
    console.log("[scheduler] cron: projects monitor");
    try {
      const result = await runProjects("cron-daily");
      if (result?.summary?.inserted === 0) {
        await postAdmin(
          `Projects monitor: no new openings (${result.summary.active} checked)`
        );
      }
    } catch (err) {
      console.error("[scheduler] projects monitor error:", err.message);
      await postAdmin(`⚠️ Projects monitor error: ${err.message}`);
    }
  });

  // ---- Hourly: refresh page cache ----
  cron.schedule("30 * * * *", async () => {
    try {
      await refreshPageCache();
    } catch (err) {
      console.error("[scheduler] page cache refresh error:", err.message);
    }
  });

  // Proposals: daily 07:00 UTC (phase 2)
  // cron.schedule("0 7 * * *", () => proposalsAgent.run("cron-daily"));

  console.log("[scheduler] ready");
}

// ---- Change stream ----

function startChangeStream(db) {
  try {
    changeStream = db.collection("entities").watch(
      [{ $match: { operationType: { $in: ["insert", "update"] } } }],
      { fullDocument: "updateLookup" }
    );

    changeStream.on("change", async (event) => {
      const entityId = event.documentKey._id;
      try {
        const result = await runForEntity(entityId, "change-stream");
        if (result?.flagged?.length) {
          await postHygieneFlag(result.entityKey, result.entityList, result.flagged);
        }
      } catch (err) {
        console.error("[scheduler] change stream handler error:", err.message);
      }
    });

    changeStream.on("error", async (err) => {
      console.error("[scheduler] change stream error:", err.message);
      await postAdmin(`⚠️ Change stream error: ${err.message}`).catch(() => {});
    });

    changeStream.on("close", () => {
      console.warn("[scheduler] change stream closed");
    });

    console.log("[scheduler] change stream listening");
  } catch (err) {
    console.error("[scheduler] failed to start change stream:", err.message);
  }
}

// Graceful shutdown
export async function closeScheduler() {
  if (changeStream) {
    await changeStream.close();
    changeStream = null;
  }
}
