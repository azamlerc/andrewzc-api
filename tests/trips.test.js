import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { buildTripEntityFilter, tripCriteriaClauses } from "../trips.js";

const page = {
  key: "europe",
  include: { countries: ["lu", "ch"], cities: ["aachen"], lists: { airports: ["brussels"] } },
  exclude: { cities: ["zurich"], lists: { "power-stations": true } },
};

test("criteria are unions, with exclusions inside the criteria branch and tags outside", () => {
  assert.deepEqual(buildTripEntityFilter("europe", page), {
    $or: [
      {
        $or: [
          { country: { $in: ["LU", "CH"] } },
          { countries: { $in: ["LU", "CH"] } },
          { city: { $in: ["Aachen"] } },
          { list: "airports", key: { $in: ["brussels"] } },
        ],
        $nor: [{ city: { $in: ["Zurich"] } }, { list: "power-stations" }],
      },
      { trips: "europe" },
    ],
  });
});

test("missing, empty, and exclude-only pages remain tagged-only", () => {
  for (const record of [null, {}, { exclude: page.exclude }, { include: {} },
    { include: { countries: [], cities: [], lists: { airports: [], rivers: false } } }]) {
    assert.deepEqual(buildTripEntityFilter("legacy", record), { trips: "legacy" });
  }
});

test("whole-list includes and specific-key exclusions retain list identity", () => {
  assert.deepEqual(buildTripEntityFilter("trip", {
    include: { lists: { airports: true, rivers: ["brussels"] } },
    exclude: { lists: { airports: ["brussels"] } },
  }), {
    $or: [
      { $or: [{ list: "airports" }, { list: "rivers", key: { $in: ["brussels"] } }],
        $nor: [{ list: "airports", key: { $in: ["brussels"] } }] },
      { trips: "trip" },
    ],
  });
});

test("city keys follow the existing city endpoint's naming conventions", () => {
  assert.deepEqual(tripCriteriaClauses({ cities: ["new-york-ny", "den-haag", " aachen "] }),
    [{ city: { $in: ["New York, NY", "Den Haag", "Aachen"] } }]);
});

test("invalid values cannot inject query operators or broaden selection", () => {
  assert.deepEqual(tripCriteriaClauses({
    countries: { $ne: null }, cities: [null, 42, { $gt: "" }, ""],
    lists: { airports: { $ne: null }, rivers: false },
  }), []);
  assert.deepEqual(buildTripEntityFilter("trip", { include: { countries: [" ch "] } }), {
    $or: [{ $or: [{ country: { $in: ["CH"] } }, { countries: { $in: ["CH"] } }] }, { trips: "trip" }],
  });
});

test("database loads saved criteria before querying and preserves sorted, unlimited response", async () => {
  const calls = [];
  const entities = [{ list: "airports", key: "brussels" }];
  mock.module("mongodb", { namedExports: { MongoClient: class {
    async connect() {}
    db() {
      return { collection(name) {
        if (name === "pages") return { async findOne(filter) {
          calls.push(["page", filter]); return page;
        } };
        assert.equal(name, "entities");
        return { find(filter) {
          calls.push(["entities", filter]);
          return { sort(order) {
            calls.push(["sort", order]);
            return { async toArray() { return entities; } };
          } };
        } };
      } };
    }
  } } });
  try {
    const { getEntitiesByTrip } = await import("../database.js");
    assert.deepEqual(await getEntitiesByTrip("europe"), { page, entities });
    assert.deepEqual(calls, [
      ["page", { key: "europe" }],
      ["entities", buildTripEntityFilter("europe", page)],
      ["sort", { name: 1, key: 1 }],
    ]);
  } finally { mock.restoreAll(); }
});
