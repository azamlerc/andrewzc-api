// agents/hygieneHelpers.js
// Pure helper functions used by hygiene rules.
// No async, no DB, no external calls.

// Convert ISO 2-letter country code to flag emoji.
// Uses regional indicator letters (Unicode block U+1F1E6–U+1F1FF).
export function countryToFlag(countryCode) {
  if (!countryCode || countryCode.length !== 2) return null;
  const upper = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  return [...upper]
    .map((c) => String.fromCodePoint(c.codePointAt(0) + 0x1f1a5))
    .join("");
}

// Convert transit type string to emoji.
export function typeToEmoji(type) {
  const map = {
    metro: "🚇",
    monorail: "🚝",
    tram: "🚋",
    "light-rail": "🚈",
    suburban: "🚆",
    "people-mover": "🚡",
  };
  return map[type] ?? null;
}

// Normalize a date string to the most specific valid standard form.
// Accepts: "January 7, 2025", "Jan 2025", "2025/01/07", etc.
// Returns: "YYYY-MM-DD", "YYYY-MM", "YYYY", "20??", or null.
export function normalizeDate(str) {
  if (!str) return null;
  const s = str.trim();

  // Already valid
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}$/.test(s)) return s;
  if (s === "20??") return s;

  // Slash-separated dates
  const slashFull = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashFull) return `${slashFull[1]}-${slashFull[2]}-${slashFull[3]}`;

  const slashYM = s.match(/^(\d{4})\/(\d{2})$/);
  if (slashYM) return `${slashYM[1]}-${slashYM[2]}`;

  // Month name formats
  const MONTHS = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
    jan: "01", feb: "02", mar: "03", apr: "04",
    jun: "06", jul: "07", aug: "08",
    sep: "09", oct: "10", nov: "11", dec: "12",
  };

  // "January 7, 2025" or "Jan 7, 2025"
  const longDate = s.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (longDate) {
    const m = MONTHS[longDate[1].toLowerCase()];
    if (m) return `${longDate[3]}-${m}-${longDate[2].padStart(2, "0")}`;
  }

  // "January 2025" or "Jan 2025"
  const monthYear = s.match(/^(\w+)\s+(\d{4})$/i);
  if (monthYear) {
    const m = MONTHS[monthYear[1].toLowerCase()];
    if (m) return `${monthYear[2]}-${m}`;
  }

  // "2025 January" or "2025 Jan"
  const yearMonth = s.match(/^(\d{4})\s+(\w+)$/i);
  if (yearMonth) {
    const m = MONTHS[yearMonth[2].toLowerCase()];
    if (m) return `${yearMonth[1]}-${m}`;
  }

  return null; // unrecognized format — fix() returns null, rule falls through to flag
}

// Convert a display name to a URL-safe kebab-case key.
// Mirrors the key generation rules in database-workflow.md.
export function toKebabCase(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9\s-]/g, "")   // remove non-alphanumeric
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^the-/, "");           // strip "the-" prefix
}
