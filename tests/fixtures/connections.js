const rows = [
  { color: "yellow", title: "Geometric shapes", rule: "Outline shapes", terms: ["CRESCENT", "DIAMOND", "OVAL", "STAR"] },
  { color: "green", title: "DC superheroes", rule: "Characters from DC Comics", terms: ["FLASH", "BATMAN", "CYBORG", "AQUAMAN"] },
  { color: "blue", title: "Pipe organ components", rule: "Components of a traditional pipe organ", terms: ["STOP", "PEDAL", "PIPE", "MANUAL"] },
  { color: "purple", title: "Add S to make a new word", rule: "Prepend S to each term", terms: ["LIME", "PINE", "NAIL", "WING"],
    explanations: ["SLIME", "SPINE", "SNAIL", "SWING"] },
];

export const fixture = {
  title: "Under the Spotlight",
  emoji: "🔦",
  tiles: rows.flatMap(({ terms }) => terms.map((text) => ({ ref: text, text }))),
  groups: rows.map(({ terms, explanations, ...row }) => ({
    ...row,
    members: terms.map((ref, index) => ({ ref, explanation: explanations?.[index] || `${ref} fits ${row.title.toLowerCase()}.` })),
  })),
  decoy: {
    title: "Compounds ending in light", refs: ["STOP", "STAR", "FLASH", "LIME"],
    explanation: "Stoplight, starlight, flashlight and limelight form a competing connection.",
    identity: { kind: "connector", anchor: "light" },
  },
};

export const fishFixture = {
  ...fixture,
  title: "Fish Out of Water",
  emoji: "🐟",
  groups: [
    fixture.groups[0],
    { color: "green", title: "X-Men", rule: "Founding members of the X-Men",
      members: ["ANGEL", "CYCLOPS", "ICEMAN", "BEAST"].map((ref) => ({ ref, explanation: `${ref} was a founding member.` })) },
    fixture.groups[2],
    { color: "purple", title: "Words with a silent W", rule: "Each word contains an unpronounced W",
      members: ["SWORD", "ANSWER", "TWO", "WRITE"].map((ref) => ({ ref, explanation: `The W in ${ref} is silent.` })) },
  ],
  decoy: { title: "___ FISH", refs: ["STAR", "ANGEL", "PIPE", "SWORD"],
    explanation: "Starfish, angelfish, pipefish and swordfish.", identity: { kind: "connector", anchor: "fish" } },
};
fishFixture.tiles = fishFixture.groups.flatMap(({ members }) => members.map(({ ref }) => ({ ref, text: ref })));

export function scriptedModels(callLog = [], delay = 0) {
  let playerTurns = 0;
  const call = (provider) => async (request) => {
    callLog.push({ provider, request });
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const input = JSON.parse(request.messages[0].content);
    let data;
    if ("revisionFeedback" in input) data = input.previousTraps.some(({ key }) => key === "connector:light") ? fishFixture : fixture;
    else if ("tiles" in input) data = { observations: "I found three strong groups and one prefix pattern." };
    else if ("candidate" in input) data = { pass: true, feedback: "All categories apply uniformly." };
    else if ("proposed" in input) data = { allow: true };
    else if ("solution" in input) data = { say: "The last four snap together once you try the prefix." };
    else if ("key" in input) data = { say: "There are a few plausible ways to start.", privateStateUpdate: "AUTHOR-MEMORY-ONLY" };
    else {
      const puzzle = input.board.tiles.some(({ text }) => text === "ANGEL") ? fishFixture : fixture;
      const [yellow, green, blue, purple] = puzzle.groups.map((row) => row.members.map(({ ref }) => ref));
      const moves = [puzzle.decoy.refs, [...blue.slice(0, 3), green[0]], blue, yellow, green, purple];
      const move = moves[playerTurns++ % moves.length];
      const ids = new Map(input.board.tiles.map(({ id, text }) => [text, id]));
      data = {
        say: playerTurns % moves.length === 0 ? "I see the last connection." : "I’ll try this set.",
        action: { type: "submit_guess", tileIds: move.map((term) => ids.get(term)) },
        privateStateUpdate: "PLAYER-MEMORY-ONLY",
      };
    }
    return { text: JSON.stringify(data) };
  };
  return { claude: call("claude"), openai: call("openai") };
}
