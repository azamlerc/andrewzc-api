import { cityKeyToDisplayName } from "./utils.js";

function strings(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean))]
    : [];
}

// Each criterion contributes to a union; list arrays contain entity keys.
export function tripCriteriaClauses(criteria) {
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) return [];
  const clauses = [];
  const countries = strings(criteria.countries).map(code => code.toUpperCase());
  if (countries.length) {
    clauses.push({ country: { $in: countries } }, { countries: { $in: countries } });
  }
  const cities = strings(criteria.cities).map(cityKeyToDisplayName).filter(Boolean);
  if (cities.length) clauses.push({ city: { $in: cities } });
  if (criteria.lists && typeof criteria.lists === "object" && !Array.isArray(criteria.lists)) {
    for (const [list, selection] of Object.entries(criteria.lists)) {
      if (selection === true) {
        clauses.push({ list });
      } else {
        const keys = strings(selection);
        if (keys.length) clauses.push({ list, key: { $in: keys } });
      }
    }
  }
  return clauses;
}

export function buildTripEntityFilter(key, page) {
  const included = tripCriteriaClauses(page?.include);
  const tagged = { trips: key };
  // Empty criteria must never become an unrestricted query.
  if (!included.length) return tagged;
  const excluded = tripCriteriaClauses(page?.exclude);
  const criteria = { $or: included };
  if (excluded.length) criteria.$nor = excluded;
  // (included minus excluded) union tagged: explicit tags override exclusions.
  // A single Mongo query returns each entity once, even if several clauses match.
  return { $or: [criteria, tagged] };
}
