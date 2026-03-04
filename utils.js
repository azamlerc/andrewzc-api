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
