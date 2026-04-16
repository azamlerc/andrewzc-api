// config/animals.js
// Static configuration for the animals project.
// Artist/style data is kept here rather than in the DB because it is
// structural config, not generated content.

export const artists = [
  // Primary photographers — full animal set, photo + lego + anime
  { id: "corbijn",    name: "Anton Corbijn",       emoji: "🇳🇱", styles: ["photo", "lego", "anime"], short: false },
  { id: "lachapelle", name: "David La Chapelle",   emoji: "🇺🇸", styles: ["photo", "lego", "anime"], short: false },
  { id: "von-gloeden",name: "Wilhelm von Gloeden", emoji: "🇩🇪", styles: ["photo", "lego", "anime"], short: false },
  { id: "hope",       name: "Hope",                emoji: "🇺🇸", styles: ["photo", "lego", "anime"], short: false },

  // Secondary artists — photo only, short animal set
  { id: "picasso",      name: "Pablo Picasso",       emoji: "🇪🇸", styles: ["photo"], short: true },
  { id: "saudek",       name: "Jan Saudek",          emoji: "🇨🇿", styles: ["photo"], short: true },
  { id: "neon",         name: "Neon",                emoji: null,  styles: ["photo"], short: true },
  { id: "anatomy",      name: "Anatomy",             emoji: null,  styles: ["photo"], short: true },
  { id: "cloud",        name: "Clouds",              emoji: null,  styles: ["photo"], short: true },
  { id: "crayon",       name: "Crayon",              emoji: null,  styles: ["photo"], short: true },
  { id: "delftware",    name: "Delftware",           emoji: null,  styles: ["photo"], short: true },
  { id: "hieroglyphics",name: "Hieroglyphics",       emoji: null,  styles: ["photo"], short: true },
  { id: "ice",          name: "Ice Sculpture",       emoji: null,  styles: ["photo"], short: true },
  { id: "icon",         name: "Icons",               emoji: null,  styles: ["photo"], short: true },
  { id: "noir",         name: "Noir",                emoji: null,  styles: ["photo"], short: true },
  { id: "origami",      name: "Origami",             emoji: null,  styles: ["photo"], short: true },
  { id: "pop-art",      name: "Pop Art",             emoji: null,  styles: ["photo"], short: true },
  { id: "socialist",    name: "Socialist Realism",   emoji: null,  styles: ["photo"], short: true },
  { id: "space",        name: "Space Battle",        emoji: null,  styles: ["photo"], short: true },
  { id: "stained-glass",name: "Stained Glass",       emoji: null,  styles: ["photo"], short: true },
  { id: "street-art",   name: "Street Art",          emoji: null,  styles: ["photo"], short: true },
  { id: "sumi-e",       name: "Sumi-e",              emoji: null,  styles: ["photo"], short: true },
  { id: "ukiyo-e",      name: "Ukiyo-e",             emoji: null,  styles: ["photo"], short: true },
  { id: "watercolor",   name: "Watercolor",          emoji: null,  styles: ["photo"], short: true },
];
