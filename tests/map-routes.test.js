import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const source = readFileSync(new URL("../database.js", import.meta.url), "utf8");
const fn = source.slice(source.indexOf("export async function getMapRoutes("), source.indexOf("export async function getEntitiesByTrip(")).replace("export ", "");
for (const country of ["be", " es-cn ", null]) {
  test(`route country selection ${country} preserves other filters and all stop identities`, async () => {
    const calls = [];
    const routes = [{key: "cross-border", stops: [{list: "airports", key: "a"}, {list: "waypoints", key: "b"}, {list: "airports", key: "c"}]}];
    const entities = routes[0].stops.map(stop => ({...stop, location: {type: "Point", coordinates: [1, 2]}}));
    const db = {collection(name) {return {find(filter) {
      calls.push({name, filter});
      if (name === "routes") return {sort() {return {async toArray() {return routes;}};}};
      return {async toArray() {return entities;}};
    }};}};
    const getMapRoutes = vm.runInNewContext(`(${fn})`, {connectToMongo: async () => db});
    const result = await getMapRoutes({mode: "air", trip: "test", country});
    const expected = {mode: "air", trips: "test"};
    if (country) expected.$or = [{country: country.trim().toUpperCase()}, {countries: country.trim().toUpperCase()}];
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].filter)), expected);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[1].filter)), {$or: routes[0].stops});
    assert.equal(result.entities.length, 3);
  });
}
const lookup = readFileSync(new URL("../routes/lookup.js", import.meta.url), "utf8");
const registration = lookup.slice(lookup.indexOf('lookupRouter.get("/routes",'), lookup.indexOf('lookupRouter.get("/flags",'));
for (const [query, expectedStatus] of [[{country: "es-cn"}, 200], [{country: ["BE", "FR"]}, 400], [{country: {$ne: ""}}, 400], [{country: ""}, 400], [{country: "BE.*"}, 400]]) {
  test(`routes HTTP country validation: ${JSON.stringify(query)}`, async () => {
    let handler, selected, status = 200;
    vm.runInNewContext(registration, {console, lookupRouter: {get(path, fn) {handler = fn;}},
      getMapRoutes: async filter => {selected = filter; return {routes: [], entities: []};}, strip: x => x, cleanError: x => x.message});
    const response = {status(n) {status = n; return this;}, json() {return this;}};
    await handler({query}, response);
    assert.equal(status, expectedStatus);
    if (expectedStatus === 200) assert.equal(selected.country, "ES-CN");
    else assert.equal(selected, undefined);
  });
}
