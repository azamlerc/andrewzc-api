// agents/hygieneRules.js
// Declarative hygiene rules derived from hygiene-rules.md.
// Each rule follows the shape defined in agents/runner.js.

import { connectToMongo } from "../database.js";
import { findWikipediaArticle } from "../connectors/wikipedia.js";
import { countryToFlag, typeToEmoji, normalizeDate } from "./hygieneHelpers.js";

// Icons that indicate an intentional non-country entity.
// Entities with these icons are exempt from the country requirement.
const EXCEPTION_ICONS = ["🌊", "🌍", "🌎", "🌏", "🌐", "🌕"];

// ---- Universal rules ----

const U1 = {
  id: "U1",
  scope: "auto",
  applies: (e) => typeof e.country === "string" && e.country.length > 0,
  check: (e) => e.country !== e.country.toUpperCase(),
  fix: (e) => ({ country: e.country.toUpperCase() }),
  message: (e) => `country "${e.country}" should be uppercase`,
};

const U2 = {
  id: "U2",
  scope: "auto",
  applies: (e) => e.been == null,
  check: () => true,
  fix: () => ({ been: false }),
  message: () => "been is null or missing",
};

const U3 = {
  id: "U3",
  scope: "flag",
  applies: () => true,
  check: (e) => typeof e.key === "string" && /[A-Z\s]/.test(e.key),
  message: (e) => `key "${e.key}" contains uppercase letters or spaces`,
  flagField: "key",
  flagValue: (e) => e.key,
};

// U4 — link missing (async: attempts Wikipedia lookup)
const U4 = {
  id: "U4",
  scope: "auto",
  applies: (e, page) => !page?.tags?.includes("no-links"),
  check: (e) => !e.link,
  fix: async (e) => {
    const url = await findWikipediaArticle(e.name, e.country);
    if (!url) return null; // falls through to flag
    return { link: url };
  },
  message: (e) => `link is missing for "${e.name}" — Wikipedia lookup found no confident match`,
  flagField: "link",
};

// U6 — country / countries missing
const U6 = {
  id: "U6",
  scope: "flag",
  applies: (e, page) => {
    if (page?.tags?.includes("no-country")) return false;
    if (e.icons?.some((i) => EXCEPTION_ICONS.includes(i))) return false;
    return true;
  },
  check: (e) => !e.country && (!e.countries || e.countries.length === 0),
  message: (e) => `"${e.key}" (list: ${e.list}) has no country or countries field`,
  flagField: "country",
};

// U7 — icons missing or empty
const U7 = {
  id: "U7",
  scope: "auto",
  applies: (e, page) => !page?.tags?.includes("no-country"),
  check: (e) => !e.icons || e.icons.length === 0,
  fix: (e) => {
    if (!e.country) return null; // can't infer, falls through to flag
    const flag = countryToFlag(e.country);
    if (!flag) return null;
    return { icons: [flag] };
  },
  message: (e) => `icons is empty and country "${e.country}" is also missing — cannot infer flag`,
  flagField: "icons",
};

// U8 — dateAdded missing on agent-created records
const U8 = {
  id: "U8",
  scope: "auto",
  applies: (e) => e.source === "agent" && !e.dateAdded,
  check: () => true,
  fix: () => ({ dateAdded: new Date().toISOString().slice(0, 10) }),
  message: () => "dateAdded is missing on agent-created record",
};

// U9 — GeoJSON location missing (derives from coords)
const U9 = {
  id: "U9",
  scope: "auto",
  applies: (e) => !!e.coords && !e.location,
  check: () => true,
  fix: (e) => {
    const parts = e.coords.split(",").map((s) => parseFloat(s.trim()));
    if (parts.length !== 2 || parts.some(isNaN)) return null;
    const [lat, lon] = parts;
    return { location: { type: "Point", coordinates: [lon, lat] } };
  },
  message: (e) => `location GeoJSON missing; coords is "${e.coords}"`,
  flagField: "location",
};

// U10 — coords format
const U10 = {
  id: "U10",
  scope: "auto",
  applies: (e) => !!e.coords,
  check: (e) => !/^-?\d+\.?\d*,\s*-?\d+\.?\d*$/.test(e.coords),
  fix: (e) => {
    // Attempt whitespace normalization only
    const normalized = e.coords.replace(/\s*,\s*/, ", ").trim();
    if (!/^-?\d+\.?\d*,\s*-?\d+\.?\d*$/.test(normalized)) return null;
    return { coords: normalized };
  },
  message: (e) => `coords "${e.coords}" is not in expected "lat, lon" format`,
  flagField: "coords",
  flagValue: (e) => e.coords,
};

// ---- Confluence-specific rules ----

const C1 = {
  id: "C1",
  scope: "auto",
  applies: (e) => e.list === "confluence",
  check: (e) => {
    if (!e.prefix) return true;
    return (
      !/^\d+°[NS] \d+°[EW]$/.test(e.prefix) &&  // normal: "48°N 2°E"
      !/^0° \d+°[EW]$/.test(e.prefix) &&         // equator (non-zero lon): "0° 37°E"
      !/^\d+°[NS] 0°$/.test(e.prefix) &&          // prime meridian (non-zero lat): "51°N 0°"
      e.prefix !== "0° 0°"                         // null island: exactly "0° 0°"
    );
  },
  fix: (e) => {
    if (!e.coords) return null;
    const [lat, lon] = e.coords.split(",").map((s) => parseFloat(s.trim()));
    if (isNaN(lat) || isNaN(lon)) return null;
    const latDir = lat >= 0 ? "N" : "S";
    const lonDir = lon >= 0 ? "E" : "W";
    const prefix =
      lat === 0 && lon === 0
        ? "0° 0°"                                                                    // Null Island
        : lat === 0
        ? `0° ${Math.abs(Math.round(lon))}°${lonDir}`                               // equator
        : lon === 0
        ? `${Math.abs(Math.round(lat))}°${latDir} 0°`                               // prime meridian
        : `${Math.abs(Math.round(lat))}°${latDir} ${Math.abs(Math.round(lon))}°${lonDir}`; // normal
    return { prefix };
  },
  message: (e) => `prefix "${e.prefix}" does not match confluence format (e.g. "48°N 2°E")`,
  flagField: "prefix",
  flagValue: (e) => e.prefix,
};

const C2 = {
  id: "C2",
  scope: "flag",
  applies: (e) => e.list === "confluence" && !!e.coords && !!e.prefix,
  check: (e) => {
    const [lat, lon] = e.coords.split(",").map((s) => parseFloat(s.trim()));
    const match = e.prefix.match(/(\d+)°([NS])\s+(\d+)°([EW])/);
    if (!match) return false; // C1 will catch malformed prefix
    const [, pLat, latDir, pLon, lonDir] = match;
    const expectedLat = parseInt(pLat) * (latDir === "S" ? -1 : 1);
    const expectedLon = parseInt(pLon) * (lonDir === "W" ? -1 : 1);
    return Math.round(lat) !== expectedLat || Math.round(lon) !== expectedLon;
  },
  message: (e) => `coords "${e.coords}" does not match prefix "${e.prefix}"`,
  flagField: "coords",
};

const C3 = {
  id: "C3",
  scope: "auto",
  applies: (e) => e.list === "confluence",
  check: (e) => !e.link || !e.link.includes("confluence.org"),
  fix: (e) => {
    if (!e.coords) return null;
    const [lat, lon] = e.coords.split(",").map((s) => parseFloat(s.trim()));
    if (isNaN(lat) || isNaN(lon)) return null;
    return { link: `https://confluence.org/confluence.php?lat=${Math.round(lat)}&lon=${Math.round(lon)}` };
  },
  message: (e) => `link "${e.link}" is not a confluence.org URL`,
  flagField: "link",
  flagValue: (e) => e.link,
};

// ---- Transit projects rules ----

const P1 = {
  id: "P1",
  scope: "auto",
  applies: (e) => e.list === "projects" && !!e.prefix,
  check: (e) => {
    const valid = /^\d{4}(-\d{2}(-\d{2})?)?$/.test(e.prefix) || e.prefix === "20??";
    return !valid;
  },
  fix: (e) => {
    const normalized = normalizeDate(e.prefix);
    if (!normalized) return null;
    return { prefix: normalized };
  },
  message: (e) => `prefix "${e.prefix}" is not a valid date format (expected YYYY, YYYY-MM, YYYY-MM-DD, or 20??)`,
  flagField: "prefix",
  flagValue: (e) => e.prefix,
};

const P2 = {
  id: "P2",
  scope: "flag",
  applies: (e) => e.list === "projects",
  check: (e) => {
    const valid = ["metro", "tram", "light-rail", "suburban", "people-mover", "monorail"];
    return !valid.includes(e.type);
  },
  message: (e) => `type "${e.type}" is not a valid projects type`,
  flagField: "type",
  flagValue: (e) => e.type,
};

const P3 = {
  id: "P3",
  scope: "auto",
  applies: (e) => e.list === "projects" && !!e.type && !!e.country,
  check: (e) => {
    const transportEmoji = typeToEmoji(e.type);
    if (!transportEmoji) return false;
    return !e.icons?.includes(transportEmoji);
  },
  fix: (e) => {
    const flag = countryToFlag(e.country);
    const transport = typeToEmoji(e.type);
    if (!flag || !transport) return null;
    // Rebuild icons: country flag first, then transport emoji
    const icons = [flag, transport];
    return { icons };
  },
  message: (e) => `icons for projects entity "${e.key}" missing transport emoji for type "${e.type}"`,
  flagField: "icons",
};

const P4 = {
  id: "P4",
  scope: "auto",
  applies: (e) => e.list === "projects" && e.source === "agent",
  check: (e) => e.been !== false,
  fix: () => ({ been: false }),
  message: () => "agent-created project entry has been !== false",
};

// ---- Metro / tram / light-rail rules ----

const T1 = {
  id: "T1",
  scope: "flag",
  applies: (e) => ["metros", "trams", "light-rail"].includes(e.list),
  check: (e) => {
    const valid = {
      metros: ["done", "taken", "visited", "want"],
      trams: ["done", "taken", "seen"],
      "light-rail": ["done", "taken", "seen"],
    };
    return e.section && !valid[e.list]?.includes(e.section);
  },
  message: (e) => `section "${e.section}" is not valid for list "${e.list}"`,
  flagField: "section",
  flagValue: (e) => e.section,
};

const T3 = {
  id: "T3",
  scope: "auto",
  applies: (e) => ["metros", "trams", "light-rail"].includes(e.list) && !!e.country,
  check: (e) => {
    const transportEmoji = { metros: "🚇", trams: "🚊", "light-rail": "🚈" }[e.list];
    return !e.icons?.includes(transportEmoji);
  },
  fix: (e) => {
    const flag = countryToFlag(e.country);
    const transport = { metros: "🚇", trams: "🚊", "light-rail": "🚈" }[e.list];
    if (!flag || !transport) return null;
    const icons = [flag, transport];
    return { icons };
  },
  message: (e) => `icons for "${e.key}" missing transport emoji for list "${e.list}"`,
  flagField: "icons",
};

// ---- UNESCO rules ----

const N1 = {
  id: "N1",
  scope: "flag",
  applies: (e) => e.list === "unesco",
  check: (e) => !e.country && (!e.countries || e.countries.length === 0),
  message: (e) => `UNESCO entity "${e.key}" has no country or countries field`,
  flagField: "country",
};

const N2 = {
  id: "N2",
  scope: "auto",
  applies: (e) => e.list === "unesco" && !!e.link,
  check: (e) => e.link.includes("whc.unesco.org"),
  fix: async (e) => {
    const url = await findWikipediaArticle(e.name, e.country);
    if (!url) return null;
    return { link: url };
  },
  message: (e) => `link "${e.link}" points to UNESCO website, not Wikipedia`,
  flagField: "link",
  flagValue: (e) => e.link,
};

// ---- Tripoints rules ----

const TR1 = {
  id: "TR1",
  scope: "flag",
  applies: (e) => e.list === "tripoints",
  check: (e) => !e.countries || e.countries.length !== 3,
  message: (e) =>
    e.countries
      ? `tripoint "${e.key}" countries array has ${e.countries.length} entries, expected 3`
      : `tripoint "${e.key}" has no countries array`,
  flagField: "countries",
  flagValue: (e) => e.countries,
};

const TR2 = {
  id: "TR2",
  scope: "auto",
  applies: (e) =>
    e.list === "tripoints" &&
    Array.isArray(e.countries) &&
    e.countries.length === 3,
  check: (e) => {
    const expectedFlags = e.countries.map(countryToFlag).filter(Boolean);
    if (expectedFlags.length !== 3) return false;
    return !expectedFlags.every((f) => e.icons?.includes(f));
  },
  fix: (e) => {
    const flags = e.countries.map(countryToFlag);
    if (flags.some((f) => !f)) return null;
    return { icons: flags };
  },
  message: (e) => `tripoint "${e.key}" icons don't match countries array`,
  flagField: "icons",
};

// ---- Airbnb / hotels rules ----

const H1 = {
  id: "H1",
  scope: "flag",
  applies: (e) => ["airbnb", "hotels"].includes(e.list),
  check: (e) => e.been !== true,
  message: (e) => `"${e.key}" in ${e.list} has been !== true (personal lists should all be visited)`,
  flagField: "been",
  flagValue: (e) => e.been,
};

// ---- Export all rules in evaluation order ----

export const RULES = [
  U1, U2, U3, U4,
  U6, U7, U8, U9, U10,
  C1, C2, C3,
  P1, P2, P3, P4,
  T1, T3,
  N1, N2,
  TR1, TR2,
  H1,
];
