import test, { mock } from "node:test";
import assert from "node:assert/strict";

const page = {
  _id: "internal", key: "intermodal", propertyOf: "stations",
  notes: ["Store mode icons inside the prop."],
  schema: { "props.intermodal": "Required for membership." },
  tags: ["reference-first"], type: "place",
};
const getPage = mock.fn(async key => key === "intermodal" ? page : null);
mock.module("../database.js", {
  namedExports: Object.fromEntries([
    ["getPage", getPage],
    ...["searchByName", "getEntity", "updateEntity", "createEntity", "enrichEntity", "updatePage", "createPage"]
      .map(name => [name, () => { throw new Error(`Unexpected call: ${name}`); }]),
  ]),
});
const { railfanChat } = await import("../chat/railfan.js");

test("getPage exposes full live documentation and derived-page metadata", async () => {
  const tool = railfanChat.buildTools().find(t => t.name === "getPage");
  assert.deepEqual(tool.input_schema.required, ["key"]);
  const result = await railfanChat.executeTool("getPage", { key: "intermodal" });
  const { _id, ...expected } = page;
  assert.deepEqual(result, expected);
  assert.equal(getPage.mock.calls.at(-1).arguments[0], "intermodal");
  assert.deepEqual(await railfanChat.executeTool("getPage", { key: "missing" }), { error: "not_found" });
});

test("assembled prompt retains remote context and appends the live-page workflow", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async url => ({ text: async () => `Remote context: ${url}` }));
  try {
    const prompt = await railfanChat.loadSystemPrompt();
    assert.equal(fetchMock.mock.calls.length, 3);
    assert.match(prompt, /Remote context:.*system-prompt\.md/);
    assert.match(prompt, /Before creating, updating, or enriching entities, call getPage/);
    assert.match(prompt, /read both the requested detail page and its parent/);
    assert.match(prompt, /update the relevant page notes and\/or schema during the same task/);
    assert.ok(prompt.indexOf("Live page documentation workflow") > prompt.lastIndexOf("Remote context:"));
  } finally { fetchMock.mock.restore(); }
});
