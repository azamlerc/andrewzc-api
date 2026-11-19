const rows = [
  { color: "yellow", title: "Geometric shapes", rule: "Outline shapes", terms: ["CRESCENT", "DIAMOND", "OVAL", "STAR"] },
  { color: "green", title: "DC superheroes", rule: "Characters from DC Comics", terms: ["FLASH", "BATMAN", "CYBORG", "AQUAMAN"] },
  { color: "blue", title: "Pipe organ components", rule: "Components of a traditional pipe organ", terms: ["STOP", "PEDAL", "PIPE", "MANUAL"] },
  { color: "purple", title: "Add S to make a new word", rule: "Prepend S to each term", terms: ["LIME", "PINE", "NAIL", "WING"],
    explanations: ["SLIME", "SPINE", "SNAIL", "SWING"] },
];

export const fixture = {
  title: "Under the Spotlight",
  tiles: rows.flatMap(({ terms }) => terms.map((text) => ({ ref: text, text }))),
  groups: rows.map(({ terms, explanations, ...row }) => ({
    ...row,
    members: terms.map((ref, index) => ({ ref, explanation: explanations?.[index] || `${ref} fits ${row.title.toLowerCase()}.` })),
  })),
  decoy: {
    title: "Compounds ending in light", refs: ["STOP", "STAR", "FLASH", "LIME"],
    explanation: "Stoplight, starlight, flashlight and limelight form a competing connection.",
  },
};

export function scriptedModels(callLog = [], delay = 0) {
  let playerTurns = 0;
  const moves = [
    ["STOP", "STAR", "FLASH", "LIME"],
    ["STOP", "PEDAL", "PIPE", "FLASH"],
    ["STOP", "PEDAL", "PIPE", "MANUAL"],
    ["CRESCENT", "DIAMOND", "OVAL", "STAR"],
    ["FLASH", "BATMAN", "CYBORG", "AQUAMAN"],
    ["LIME", "PINE", "NAIL", "WING"],
  ];
  const call = (provider) => async (request) => {
    callLog.push({ provider, request });
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const input = JSON.parse(request.messages[0].content);
    let data;
    if ("revisionFeedback" in input) data = fixture;
    else if ("tiles" in input) data = { observations: "I found three strong groups and one prefix pattern." };
    else if ("candidate" in input) data = { pass: true, feedback: "All categories apply uniformly." };
    else if ("proposed" in input) data = { allow: true };
    else if ("solution" in input) data = { say: "The last four snap together once you try the prefix." };
    else if ("key" in input) data = { say: "There are a few plausible ways to start.", privateStateUpdate: "AUTHOR-MEMORY-ONLY" };
    else {
      const move = moves[playerTurns++ % moves.length];
      const ids = new Map(input.board.tiles.map(({ id, text }) => [text, id]));
      data = {
        say: playerTurns % moves.length === 0 ? "Adding S gives me the final connection." : "I’ll try this set.",
        action: { type: "submit_guess", tileIds: move.map((term) => ids.get(term)) },
        privateStateUpdate: "PLAYER-MEMORY-ONLY",
      };
    }
    return { text: JSON.stringify(data) };
  };
  return { claude: call("claude"), openai: call("openai") };
}
