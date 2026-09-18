// A scenario is user-supplied text in whatever language they choose, so a
// persona may come back in that language. parsePersona used to require an
// English first-person pronoun, which rejected valid briefs: ChatGPT found
// it on 2026-09-18 while diagnosing a live casting failure on a French and
// German scenario.

import test from "node:test";
import assert from "node:assert/strict";
import { parsePersona } from "../blue-room/prompts.js";

const cast = brief => JSON.stringify({ name: "Margit", brief });

test("a brief is accepted whatever language it is written in", () => {
  const briefs = {
    english: "I'm Margit and I fix railway signals.\n\nI want a quiet night.",
    // The exact shape that failed live: German has no word matching the old
    // English pronoun list.
    german: "Ich bin Margit und repariere Bahnsignale.\n\nHeute Abend möchte ich meine Ruhe.",
    french: "Je suis Margit et je répare des signaux ferroviaires.\n\nCe soir, je veux du calme.",
    japanese: "私はマルギットです。鉄道の信号を直しています。\n\n今夜は静かに過ごしたい。",
    greek: "Είμαι η Μαργκίτ και επισκευάζω σηματοδότες τρένων.\n\nΑπόψε θέλω ησυχία.",
  };

  for (const [language, brief] of Object.entries(briefs)) {
    const persona = parsePersona(cast(brief));
    assert.equal(persona.brief, brief, `${language} brief was rejected`);
    assert.equal(persona.name, "Margit");
  }
});

// The old test passed only because French "me" collides with English "me",
// which is the clearest possible sign the check was measuring the wrong
// thing. Keep a case that would have been a false positive.
test("acceptance does not depend on a word that happens to look English", () => {
  const brief = "Elle s'appelle Margit.\n\nCe soir, elle veut du calme.";
  assert.equal(parsePersona(cast(brief)).brief, brief);
});

test("structural validation still applies in every language", () => {
  // One paragraph: too thin to be a persona, in any language.
  assert.throws(() => parsePersona(cast("Ich bin Margit.")), { code: "invalid_persona_brief" });
  // Four paragraphs: more than the casting prompt asks for.
  assert.throws(
    () => parsePersona(cast("Eins.\n\nZwei.\n\nDrei.\n\nVier.")),
    { code: "invalid_persona_brief" }
  );
  // Length cap is measured in characters, so it holds for any script.
  assert.throws(() => parsePersona(cast(`${"あ".repeat(4001)}\n\nに`)), { code: "invalid_persona_brief" });
  // A name is still a single short line.
  assert.throws(
    () => parsePersona(JSON.stringify({ name: "Margit\nHollósy", brief: "Ich bin hier.\n\nIch warte." })),
    { code: "invalid_persona_name" }
  );
});

test("malformed JSON is still refused, not guessed at", () => {
  assert.throws(() => parsePersona("```json\n{}\n```"), { code: "invalid_persona_json" });
  assert.throws(() => parsePersona(JSON.stringify({ name: "Margit" })), { code: "invalid_persona" });
});
