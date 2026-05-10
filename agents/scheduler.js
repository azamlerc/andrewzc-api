// agents/scheduler.js
// Initialises cron jobs and the change stream.
// Called once at server startup: initScheduler()

import cron from "node-cron";
import { connectToMongo } from "../database.js";
import { runBatch, buildDailyDigest } from "./hygiene.js";
import { run as runProjects } from "./projects.js";
import { refreshNow as refreshPageCache } from "./pageCache.js";
import { postHygieneDigest, postAdmin } from "../connectors/slack.js";
import { deriveCountryPatch } from "../utils.js";

let changeStream = null;

export async function initScheduler() {
  console.log("[scheduler] initialising");

  const db = await connectToMongo();

  // Pre-warm the page cache
  await refreshPageCache();

  // ---- Change stream: set country/countries from flag emoji on every entity write ----
  startChangeStream(db);

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

  console.log("[scheduler] ready");
}

// ---- Change stream ----

function startChangeStream(db) {
  try {
    changeStream = db.collection("entities").watch(
      [{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }],
      { fullDocument: "updateLookup" }
    );

    changeStream.on("change", async (event) => {
      const doc = event.fullDocument;
      if (!doc) return;

      // Skip if the change itself set country/countries (avoids looping on our own writes)
      const updatedFields = event.updateDescription?.updatedFields ?? {};
      if ("country" in updatedFields || "countries" in updatedFields) return;

      // Skip if entity already has country or countries
      if (doc.country || (Array.isArray(doc.countries) && doc.countries.length > 0)) return;

      // Derive from flag emoji in icons
      const icons = doc.icons;
      if (!Array.isArray(icons) || icons.length === 0) return;

      try {
        // Fetch page tags to respect "no-country"
        const page = await db.collection("pages").findOne(
          { key: doc.list },
          { projection: { tags: 1 } }
        );
        const patch = deriveCountryPatch(icons, page?.tags ?? []);
        if (!patch) return;

        // Build update: set the derived field, unset the other
        const $set   = {};
        const $unset = {};
        if (patch.country !== undefined)   { $set.country   = patch.country;   $unset.countries = ""; }
        if (patch.countries !== undefined) { $set.countries = patch.countries; $unset.country   = ""; }

        const update = Object.keys($unset).length ? { $set, $unset } : { $set };
        await db.collection("entities").updateOne({ _id: doc._id }, update);
      } catch (err) {
        console.error("[scheduler] change stream country update error:", err.message);
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
