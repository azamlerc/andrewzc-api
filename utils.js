// Pure utility functions — no database or HTTP dependencies.

export function simplify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/'/g, "")
    .replace(/\./g, "")
    .replace(/,/g, "")
    .replace(/\*/g, "")
    .replace(/"/g, "")
    .replace(/</g, "")
    .replace(/>/g, "")
    .replace(/\(/g, "")
    .replace(/\)/g, "")
    .replace(/\//g, "-")
    .replace(/&/g, "-")
    .replace(/–/g, "-")
    .replace(/—/g, "-")
    .replace(/---/g, "-")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/the-/, "");
}

export function makeKeyFromPageTags({ tags, name, reference, countryCode }) {
  const t = Array.isArray(tags) ? tags : [];
  const referenceKey   = t.includes("reference-key");
  const referenceFirst = t.includes("reference-first");
  const countryKey     = t.includes("country-key");

  const n  = String(name || "");
  const r  = reference == null ? null : String(reference);
  const cc = countryCode == null ? null : String(countryCode).toUpperCase();

  if (countryKey && cc && !n.includes(",")) {
    return simplify(`${n} ${cc}`);
  } else if (referenceKey && r) {
    return simplify(referenceFirst ? `${r} ${n}` : `${n} ${r}`);
  } else {
    return simplify(n);
  }
}

function toTitleCaseWord(w) {
  if (!w) return w;
  const lower = w.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Convert a dashed key like `den-haag` or `new-york-ny` to a display name.
// If the last token is 2 letters, treats it as a state/province code: "New York, NY".
export function cityKeyToDisplayName(key) {
  const parts = String(key || "").split("-").filter(Boolean);
  if (parts.length === 0) return "";

  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1);

  if (last.length === 2 && rest.length > 0) {
    return `${rest.map(toTitleCaseWord).join(" ")}, ${last.toUpperCase()}`;
  }

  return parts.map(toTitleCaseWord).join(" ");
}

// ── Flag emoji → country code ─────────────────────────────────────────────────

// Sub-national flags use Unicode tag sequences rather than regional indicator
// pairs, so they need explicit mapping to their parent ISO 3166-1 alpha-2 code.
const SUBNATIONAL_FLAG_MAP = {
  "🏴󠁧󠁢󠁥󠁮󠁧󠁿": "GB", // England
  "🏴󠁧󠁢󠁳󠁣󠁴󠁿": "GB", // Scotland
  "🏴󠁧󠁢󠁷󠁬󠁳󠁿": "GB", // Wales
  "🏴󠁵󠁳󠁴󠁸󠁿":   "US", // Texas (unofficial)
};

function flagEmojiToCountryCode(icon) {
  if (SUBNATIONAL_FLAG_MAP[icon]) return SUBNATIONAL_FLAG_MAP[icon];
  const codePoints = [...String(icon || "")].map(c => c.codePointAt(0));
  if (codePoints.length !== 2) return null;
  if (!codePoints.every(cp => cp >= 0x1F1E6 && cp <= 0x1F1FF)) return null;
  return codePoints.map(cp => String.fromCharCode(cp - 0x1F1E6 + 65)).join("");
}

/**
 * Derive country/countries from an icons array and a page's tags.
 *
 * Returns an object with fields to $set and $unset, or null if no flags found
 * or if the page is tagged "no-country".
 *
 * Usage:
 *   const patch = deriveCountryPatch(entity.icons, page.tags);
 *   if (patch) Object.assign(doc, patch);
 */
export function deriveCountryPatch(icons, pageTags = []) {
  if (Array.isArray(pageTags) && pageTags.includes("no-country")) return null;
  if (!Array.isArray(icons) || icons.length === 0) return null;

  const codes = [...new Set(icons.map(flagEmojiToCountryCode).filter(Boolean))];
  if (codes.length === 0) return null;

  if (codes.length === 1) {
    return { country: codes[0], countries: undefined };
  } else {
    return { countries: codes, country: undefined };
  }
}
