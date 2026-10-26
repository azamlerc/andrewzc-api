import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { assertLocationFields, pointLatLon } from "../location.js";
import { strip, stripKeepSummary } from "../routes/middleware.js";

const point = (lon, lat) => ({ type: "Point", coordinates: [lon, lat] });
const writes = [];
let pipeline;
const entities = {
  async findOne() { return null; },
  async insertOne(doc) { writes.push({ insert: doc }); },
  async findOneAndUpdate(filter, update) { writes.push({ filter, update }); return { list: "bridges", key: "a", ...update.$set }; },
  aggregate(value) { pipeline = value; return { async toArray() { return []; } }; },
};
mock.module("mongodb", { namedExports: { MongoClient: class {
  async connect() {}
  db() { return { collection(name) { return name === "entities" ? entities : { async findOne() { return { tags: [] }; } }; } }; }
} } });
const { createEntity, updateEntity, getEntitiesNearPoint } = await import("../database.js");
const { RULES } = await import("../agents/hygieneRules.js");
const { getLocationFromUrl } = await import("../wiki.js");

test("write validation accepts GeoJSON/clearing and rejects legacy or malformed input", () => {
  for (const fields of [{ name: "A" }, { location: null }, { location: point(0, 0) }, { location: point(-180, 90) }]) {
    assert.doesNotThrow(() => assertLocationFields(fields));
  }
  for (const fields of [{ coords: "1, 2" }, { "coords.foo": 1 }, { "location.coordinates": [1, 2] },
    { location: "1, 2" }, { location: point(181, 0) }, { location: point(0, 91) },
    { location: point("1", "2") }, { location: point(null, null) }]) {
    assert.throws(() => assertLocationFields(fields), error => error.status === 400);
  }
});

test("create/update preserve GeoJSON and clearing changes only location", async () => {
  writes.length = 0;
  const result = await createEntity("bridges", { name: "Bridge", location: point(2, 1) });
  assert.deepEqual(result.doc.location, point(2, 1));
  assert.equal("coords" in writes[0].insert, false);
  await updateEntity("bridges", "a", { location: null });
  assert.deepEqual(writes[1].update.$set.location, null);
  assert.equal("$unset" in writes[1].update, false);
  assert.equal("coords" in writes[1].update.$set, false);
  const count = writes.length;
  await assert.rejects(createEntity("bridges", { name: "Legacy", coords: "1, 2" }), /deprecated/);
  await assert.rejects(updateEntity("bridges", "a", { location: point(0, 100) }), /GeoJSON/);
  assert.equal(writes.length, count);
});

test("nearby projection returns location for markers and bounds", async () => {
  await getEntitiesNearPoint(2, 1);
  const projection = pipeline.at(-1).$project;
  assert.equal(projection.location, 1);
  assert.equal("coords" in projection, false);
});

test("public responses omit lingering legacy data", () => {
  const doc = { _id: "a", name: "Bridge", coords: "80, 90", location: point(2, 1) };
  for (const sanitize of [strip, stripKeepSummary]) {
    assert.deepEqual(sanitize(doc), { name: "Bridge", location: point(2, 1) });
  }
  assert.equal(doc.coords, "80, 90");
});

test("enrichment results expose only GeoJSON and reject out-of-range source points", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => ({ ok: true, text: async () => "center=1.25,-2.5" }));
  try {
    assert.deepEqual(await getLocationFromUrl("https://www.booking.com/example"), { location: point(-2.5, 1.25) });
    fetchMock.mock.mockImplementation(async () => ({ ok: true, text: async () => "center=91,0" }));
    assert.equal(await getLocationFromUrl("https://www.booking.com/example"), null);
  } finally { fetchMock.mock.restore(); }
});

test("hygiene uses canonical location and never reconstructs from legacy coordinates", () => {
  const rule = id => RULES.find(rule => rule.id === id);
  const entity = { list: "confluence", location: point(-73, 40), coords: "0, 0" };
  assert.deepEqual(rule("C1").fix(entity), { prefix: "40°N 73°W" });
  assert.deepEqual(rule("C3").fix(entity), { link: "https://confluence.org/confluence.php?lat=40&lon=-73" });
  assert.equal(rule("C1").fix({ list: "confluence", coords: "40, -73" }), null);
  assert.equal(rule("U9").applies({ coords: "40, -73" }), false);
  assert.equal(rule("U9").check(entity), false);
  assert.equal(rule("U9").check({ location: point(0, 100) }), true);
  assert.equal(rule("U10"), undefined);
  assert.deepEqual(pointLatLon(point(0, 0)), { lat: 0, lon: 0 });
});
