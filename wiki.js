// Fetch coordinates from a Wikipedia, Booking.com, or Airbnb URL.
//
// Main export:
//   getCoordsFromUrl(url, { list }) → { coords, location } | null
//
// Returns:
//   coords   — human-readable decimal string: "51.50740000, -0.12780000"
//   location — GeoJSON Point: { type: "Point", coordinates: [lon, lat] }
//
// The cascade for Wikipedia pages mirrors the logic in andrewzc-v2/wiki.swift:
//   1. Fetch wikitext via Wikimedia REST API
//   2. Follow #REDIRECT links (once)
//   3. {{coord|...}} template
//   4. {{lat|...}} / {{long|...}} or `latitude = ` / `longitude = ` infobox fields
//   5. German breitengrad / längengrad infobox fields
//   6. lat_deg / lat_min / lat_sec / lon_deg / lon_min / lon_sec fields
//   7. {{Wikidatacoord|Q...}} in wikitext → Wikidata claims API
//   8. Wikidata search by page title → claims API

// ─── helpers ──────────────────────────────────────────────────────────────────

function toGeoJSON(lat, lon) {
  return { type: "Point", coordinates: [lon, lat] };
}

function formatDecimal(lat, lon) {
  return `${lat.toFixed(8)}, ${lon.toFixed(8)}`;
}

function makeResult(lat, lon) {
  return {
    coords: formatDecimal(lat, lon),
    location: toGeoJSON(lat, lon),
  };
}

// ─── DMS / mixed coordinate parser (mirrors parseCoordinates in wiki.swift) ───

/**
 * Parse a Wikipedia {{coord}} inner string (pipe-separated) into decimal degrees.
 * Handles:
 *   decimal:          "51.5074|N|-0.1278|W"  or  "51.5074|-0.1278"
 *   deg+dir:          "51|N|0|W"
 *   deg+min+dir:      "51|30|N|0|7|W"
 *   deg+min+sec+dir:  "51|30|26.64|N|0|7|39.96|W"
 */
function parseWikiCoord(inner) {
  let parts = inner.split("|").map(s => s.trim());

  // Strip leading display hint
  if (parts.length > 2 && parts[0] === "display=title") parts.shift();
  if (parts.length > 2 && /^display=/i.test(parts[0])) parts.shift();

  // Strip trailing display hint that sometimes appears at the end
  if (parts.length > 2 && /^display=/i.test(parts[parts.length - 1])) parts.pop();

  // Strip any "type:", "region:", "scale:" hints
  parts = parts.filter(p => !/^(type:|region:|scale:|name=)/i.test(p));

  const N = parts.length;

  // Fully decimal, no directions: "lat|lon"
  if (N === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return { lat: parseFloat(parts[0]), lon: parseFloat(parts[1]) };
  }

  // Normalise Spanish cardinal letters: O (Oeste) → W
  const normDir = p => p === "O" ? "W" : p;

  // Find direction indices (N/S for lat; E/W/O for lon)
  const latDirIdx = parts.findIndex(p => p === "N" || p === "S");
  const lonDirIdx = parts.findIndex((p, i) => (p === "E" || p === "W" || p === "O") && i > latDirIdx);

  if (latDirIdx === -1 || lonDirIdx === -1) return null;

  function dms(degIdx, dirIdx) {
    const sign = (normDir(parts[dirIdx]) === "S" || normDir(parts[dirIdx]) === "W") ? -1 : 1;
    const count = dirIdx - degIdx; // number of numeric parts before direction
    const deg = parseFloat(parts[degIdx]) || 0;
    const min = count >= 2 ? (parseFloat(parts[degIdx + 1]) || 0) : 0;
    const sec = count >= 3 ? (parseFloat(parts[degIdx + 2]) || 0) : 0;
    return sign * (deg + min / 60 + sec / 3600);
  }

  const lat = dms(0, latDirIdx);
  const lon = dms(latDirIdx + 1, lonDirIdx);
  if (isNaN(lat) || isNaN(lon)) return null;
  return { lat, lon };
}

/**
 * Parse a "deg°min′sec″DIR" DMS string into a decimal number.
 * Also handles plain decimal strings (optionally with a direction letter).
 */
function parseDMSComponent(s) {
  s = s.trim();

  // Plain decimal with optional direction (including Spanish O for Oeste)
  const decMatch = s.match(/^([+-]?\d+(?:\.\d+)?)\s*([NSEWOnsew]?)$/);
  if (decMatch) {
    let v = parseFloat(decMatch[1]);
    const dir = decMatch[2].toUpperCase();
    if (dir === "S" || dir === "W" || dir === "O") v = -v;
    return v;
  }

  // DMS: degrees°minutes′seconds″DIR  (seconds optional, O accepted for W)
  const dmsMatch = s.match(
    /^(\d+(?:\.\d+)?)°(?:(\d+(?:\.\d+)?)[′'])(?:(\d+(?:\.\d+)?)[″"])?([NSEWOnsew]?)$/
  );
  if (dmsMatch) {
    const deg = parseFloat(dmsMatch[1]) || 0;
    const min = parseFloat(dmsMatch[2]) || 0;
    const sec = parseFloat(dmsMatch[3]) || 0;
    let v = deg + min / 60 + sec / 3600;
    const dir = (dmsMatch[4] || "").toUpperCase();
    if (dir === "S" || dir === "W" || dir === "O") v = -v;
    return v;
  }

  return null;
}

/**
 * Parse a "lat, lon" string where each component may be decimal or DMS.
 * Returns { lat, lon } or null.
 */
function parseCoordsString(s) {
  if (!s) return null;
  const comma = s.indexOf(",");
  if (comma === -1) return null;
  const lat = parseDMSComponent(s.slice(0, comma));
  const lon = parseDMSComponent(s.slice(comma + 1));
  if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return null;
  return { lat, lon };
}

// ─── wikitext mining ──────────────────────────────────────────────────────────

/**
 * Extract all {{coord|...}} inner strings from wikitext.
 * Returns an array (may be empty).
 */
function getCoordTemplates(wikitext) {
  const results = [];
  const re = /\{\{[Cc]oord\|([^}]+)\}\}/g;
  let m;
  while ((m = re.exec(wikitext)) !== null) {
    results.push(m[1]);
  }
  return results;
}

/**
 * Parse infobox pipe fields into a flat key→value map.
 * Handles:  | latitude = 51.5074
 */
function parseInfoboxFields(wikitext) {
  const fields = {};
  for (const line of wikitext.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(1, eqIdx).trim().toLowerCase();
    const val = trimmed.slice(eqIdx + 1).trim();
    fields[key] = val;
  }
  return fields;
}

// ─── fetch helpers ─────────────────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 429) throw Object.assign(new Error("Rate limited"), { rateLimited: true });
    return null;
  }
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

// ─── Wikimedia REST API ────────────────────────────────────────────────────────

function wikiApiUrl(link) {
  // e.g. https://en.wikipedia.org/wiki/Paris  →  en, Paris
  const afterSlashes = link.replace(/^https?:\/\//, "");
  const parts = afterSlashes.split("/");
  const host = parts[0];                          // en.wikipedia.org
  const page = parts[parts.length - 1];           // Paris
  const language = host.split(".")[0];            // en
  return `https://api.wikimedia.org/core/v1/wikipedia/${language}/page/${page}`;
}

async function loadWikipediaContent(link) {
  const url = wikiApiUrl(link);
  const json = await fetchJSON(url).catch(err => {
    if (err.rateLimited) throw err;
    return null;
  });
  if (!json) return null;
  if (json.errorKey) {
    console.warn(`Wikipedia API error for ${link}: ${json.errorKey}`);
    return null;
  }
  const source = json.source;
  if (!source) return null;
  // Mask coord|qid= so it doesn't confuse the coord extractor (mirrors Swift)
  return source.replace(/\{\{coord\|qid=/gi, "{{xxxxx|qid=");
}

// ─── Wikidata ──────────────────────────────────────────────────────────────────

async function fetchWikidataCoords(entityId) {
  const url = `https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&props=claims&entity=${entityId}&origin=*`;
  const json = await fetchJSON(url);
  if (!json?.claims?.P625) return null;
  const snak = json.claims.P625[0]?.mainsnak?.datavalue?.value;
  if (!snak) return null;
  const { latitude, longitude } = snak;
  if (latitude == null || longitude == null) return null;
  return { lat: latitude, lon: longitude };
}

async function wikidataSearchByTitle(link) {
  // Derive the page title from the Wikipedia URL
  const afterSlashes = link.replace(/^https?:\/\//, "");
  const parts = afterSlashes.split("/");
  const host = parts[0];
  const page = decodeURIComponent(parts[parts.length - 1]).replace(/_/g, " ");
  const language = host.split(".")[0];

  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&search=${encodeURIComponent(page)}&language=${language}&origin=*`;
  const json = await fetchJSON(url);
  const id = json?.search?.[0]?.id;
  return id?.startsWith("Q") ? id : null;
}

// ─── Site-specific extractors ──────────────────────────────────────────────────

function coordsFromBooking(html) {
  const m = html.match(/center=([0-9.\-]+,[0-9.\-]+)/);
  if (!m) return null;
  const [lat, lon] = m[1].split(",").map(Number);
  if (isNaN(lat) || isNaN(lon)) return null;
  return { lat, lon };
}

function coordsFromAirbnb(html) {
  const m = html.match(/"lat":([-+]?\d*\.?\d+),"lng":([-+]?\d*\.?\d+)/);
  if (!m) return null;
  return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
}

// ─── Main entry point ──────────────────────────────────────────────────────────

const INTER_REQUEST_DELAY_MS = 1_000;  // pause between Wikipedia fetches

let lastWikipediaFetch = 0;

async function throttledWikipediaFetch(url) {
  const now = Date.now();
  const elapsed = now - lastWikipediaFetch;
  if (elapsed < INTER_REQUEST_DELAY_MS) {
    await new Promise(r => setTimeout(r, INTER_REQUEST_DELAY_MS - elapsed));
  }
  lastWikipediaFetch = Date.now();
  return loadWikipediaContent(url);
}

/**
 * Fetch coordinates from a URL.
 *
 * Supports:
 *   - https://en.wikipedia.org/wiki/*   (or any language)
 *   - https://www.booking.com/*
 *   - https://www.airbnb.com/*
 *
 * @param {string} url
 * @param {object} options
 * @param {string} [options.list]  list key (used for rivers special-case)
 * @returns {Promise<{coords: string, location: object}|null>}
 */
export async function getCoordsFromUrl(url, { list = "" } = {}) {
  const host = new URL(url).hostname;

  // ── Booking.com ──────────────────────────────────────────────────────────
  if (host.includes("booking.com")) {
    const html = await fetchText(url);
    if (!html) { console.warn(`Could not load booking page: ${url}`); return null; }
    const result = coordsFromBooking(html);
    if (!result) { console.warn(`Could not extract coords from booking: ${url}`); return null; }
    return makeResult(result.lat, result.lon);
  }

  // ── Airbnb ───────────────────────────────────────────────────────────────
  if (host.includes("airbnb.com")) {
    const html = await fetchText(url);
    if (!html) { console.warn(`Could not load airbnb page: ${url}`); return null; }
    const result = coordsFromAirbnb(html);
    if (!result) { console.warn(`Could not extract coords from airbnb: ${url}`); return null; }
    return makeResult(result.lat, result.lon);
  }

  // ── Wikipedia ────────────────────────────────────────────────────────────
  if (!host.includes("wikipedia.org")) {
    console.warn(`Unsupported URL: ${url}`);
    return null;
  }

  let content;
  try {
    content = await throttledWikipediaFetch(url);
  } catch (err) {
    if (err.rateLimited) {
      console.warn(`Rate limited on ${url} — aborting Wikipedia requests.`);
      throw err; // re-throw so callers can set wikiBlocked
    }
    return null;
  }

  if (!content) {
    // Try percent-encoding if the URL has non-ASCII chars
    if (!url.includes("%")) {
      const encoded = encodeURI(url);
      if (encoded !== url) {
        console.log(`Retrying encoded: ${encoded}`);
        return getCoordsFromUrl(encoded, { list });
      }
    }
    console.warn(`No content for: ${url}`);
    return null;
  }

  // ── 1. Follow redirects ──────────────────────────────────────────────────
  const redirectMatch = content.match(/^#[Rr][Ee][Dd][Ii][Rr][Ee][Cc][Tt]\s+\[\[([^\]]+)\]\]/m);
  if (redirectMatch) {
    const newName = redirectMatch[1];
    console.log(`Redirect → ${newName}`);
    const redirectUrl = "https://en.wikipedia.org/wiki/" +
      encodeURIComponent(newName.replace(/ /g, "_"));
    if (redirectUrl !== url) return getCoordsFromUrl(redirectUrl, { list });
  }

  // ── 2. {{coord|...}} template ────────────────────────────────────────────
  let coordTemplates = getCoordTemplates(content);
  if (list === "rivers" && coordTemplates.length === 2) {
    coordTemplates = [coordTemplates[1]]; // rivers: prefer mouth over source
  }
  if (coordTemplates.length > 0) {
    const parsed = parseWikiCoord(coordTemplates[0]);
    if (parsed) {
      console.log(`Coords from {{coord}}: ${parsed.lat}, ${parsed.lon}`);
      return makeResult(parsed.lat, parsed.lon);
    } else {
      console.warn(`Could not parse coord template: ${coordTemplates[0]}`);
    }
  }

  // ── 3. latitude= / longitude= infobox fields (also via getLatAndLong) ───
  const latMatch = content.match(/latitude\s*=\s*([-+]?\d*\.?\d+)/i);
  const lonMatch = content.match(/longitude\s*=\s*([-+]?\d*\.?\d+)/i);
  if (latMatch && lonMatch) {
    const lat = parseFloat(latMatch[1]);
    const lon = parseFloat(lonMatch[1]);
    if (!isNaN(lat) && !isNaN(lon)) {
      console.log(`Coords from latitude/longitude fields: ${lat}, ${lon}`);
      return makeResult(lat, lon);
    }
  }

  // ── 4. German infobox fields ─────────────────────────────────────────────
  const fields = parseInfoboxFields(content);
  if (fields["breitengrad"] && fields["längengrad"]) {
    const parsed = parseCoordsString(`${fields["breitengrad"]}, ${fields["längengrad"]}`);
    if (parsed) {
      console.log(`Coords from German fields: ${parsed.lat}, ${parsed.lon}`);
      return makeResult(parsed.lat, parsed.lon);
    }
  }

  // ── 5. lat_deg / lat_min / lat_sec / lon_deg / lon_min / lon_sec ─────────
  if (fields["lat_deg"] && fields["lon_deg"]) {
    const latDeg = parseFloat(fields["lat_deg"]) || 0;
    const latMin = parseFloat(fields["lat_min"]) || 0;
    const latSec = parseFloat(fields["lat_sec"]) || 0;
    const lonDeg = parseFloat(fields["lon_deg"]) || 0;
    const lonMin = parseFloat(fields["lon_min"]) || 0;
    const lonSec = parseFloat(fields["lon_sec"]) || 0;
    const latNS = fields["lat_ns"] || fields["lat_dir"] || "N";
    const lonEW = fields["lon_ew"] || fields["lon_dir"] || "E";

    let lat = latDeg + latMin / 60 + latSec / 3600;
    let lon = lonDeg + lonMin / 60 + lonSec / 3600;
    if (latNS.toUpperCase() === "S") lat = -lat;
    if (lonEW.toUpperCase() === "W") lon = -lon;

    if (!isNaN(lat) && !isNaN(lon)) {
      console.log(`Coords from lat/lon deg/min/sec fields: ${lat}, ${lon}`);
      return makeResult(lat, lon);
    }
  }

  // ── 6. {{Wikidatacoord|Q...}} in wikitext ────────────────────────────────
  const wikidataCoordMatch = content.match(/\{\{[Ww]ikidata[Cc]oord\|([^|}\s]+)/);
  let wikidataKey = wikidataCoordMatch?.[1]?.replace(/^Q=/, "Q") ?? null;

  // ── 7. Wikidata search fallback ───────────────────────────────────────────
  if (!wikidataKey) {
    wikidataKey = await wikidataSearchByTitle(url);
    if (wikidataKey) console.log(`Wikidata key from search: ${wikidataKey}`);
  }

  if (wikidataKey?.startsWith("Q")) {
    const result = await fetchWikidataCoords(wikidataKey);
    if (result) {
      console.log(`Coords from Wikidata ${wikidataKey}: ${result.lat}, ${result.lon}`);
      return makeResult(result.lat, result.lon);
    }
  }

  console.warn(`No coordinates found for: ${url}`);
  return null;
}

/**
 * Reset the inter-request throttle timer (useful between separate batch runs).
 */
export function resetRateLimit() {
  lastWikipediaFetch = 0;
}
