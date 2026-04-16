// config/models.js
// Static configuration for imagine model slugs.
// Slugs are frozen — once assigned, a slug always refers to the same underlying
// model. New model versions get new slugs. This is the source of truth for
// which models and styles are valid; the API no longer queries the DB for this.

export const models = [
  // ── 2026 ───────────────────────────────────────────────────────────────────
  { id: "flux",     label: "Flux 2 Flex (Black Forest Labs)", deprecated: false, styles: ["photo", "lego", "anime", "art", "pixar"] },
  { id: "gpt",      label: "OpenAI gpt-image-1",       deprecated: false, styles: ["photo", "lego", "anime", "art", "pixar"] },
  { id: "nano",     label: "Gemini Flash (getimg v2)", deprecated: false, styles: ["photo", "lego", "anime", "art", "pixar"] },
  { id: "seedream", label: "Seedream 5 Lite (getimg v2)", deprecated: false, styles: ["photo", "lego", "anime", "art", "pixar"] },

  // ── 2024 archive — deprecated ──────────────────────────────────────────────
  // Images exist in the DB but no new images are generated under these slugs.
  { id: "openai",   label: "OpenAI DALL·E 3",         deprecated: true,  styles: ["photo", "lego", "anime", "art", "pixar"] },
  { id: "getimg",   label: "getimg Essential (2024)",  deprecated: true,  styles: ["photo", "art", "anime"] },
  { id: "gemini",   label: "Gemini (2024)",            deprecated: true,  styles: ["photo", "lego"] },
  { id: "meta",     label: "Meta (WhatsApp, manual)",  deprecated: true,  styles: ["photo", "lego", "anime", "pixar"] },

];

// All non-deprecated models, for use in generation scripts and UI.
export const activeModels = models.filter(m => !m.deprecated);

// Map of id → model object, for fast lookup.
export const modelMap = Object.fromEntries(models.map(m => [m.id, m]));
