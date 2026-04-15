// connectors/urbanrail.js
// Fetches and parses urbanrail.net/news.htm to extract transit openings.
// Uses Claude to parse the cleaned text — the HTML markup is too inconsistent
// for CSS selectors (20+ years of WYSIWYG editing).
// Responses are cached in data_source_cache with a 23-hour TTL.
// Only lines newer than the last-inserted project date are sent to Claude.

import Anthropic from "@anthropic-ai/sdk";
import { connectToMongo } from "../database.js";

const NEWS_URL = "https://www.urbanrail.net/news.htm";
const CACHE_KEY_PREFIX = "urbanrail:news:";
const TTL_HOURS = 23;

// ---- Country inference from href path ----
// urbanrail.net uses a consistent directory structure:
//   eu/fr/...  → FR, eu/uk/... → GB, as/in/... → IN, etc.

const PATH_TO_COUNTRY = {
  // Europe
  "eu/at": "AT", "eu/be": "BE", "eu/bg": "BG", "eu/by": "BY",
  "eu/ch": "CH", "eu/cs": "CZ", "eu/cz": "CZ", "eu/de": "DE",
  "eu/dk": "DK", "eu/ee": "EE", "eu/es": "ES", "eu/fi": "FI",
  "eu/fr": "FR", "eu/gb": "GB", "eu/uk": "GB", "eu/gr": "GR",
  "eu/hr": "HR", "eu/hu": "HU", "eu/ie": "IE", "eu/it": "IT",
  "eu/lt": "LT", "eu/lv": "LV", "eu/md": "MD", "eu/mk": "MK",
  "eu/mn": "ME", "eu/nl": "NL", "eu/no": "NO", "eu/pl": "PL",
  "eu/pt": "PT", "eu/ro": "RO", "eu/rs": "RS", "eu/ru": "RU",
  "eu/se": "SE", "eu/si": "SI", "eu/sk": "SK", "eu/tr": "TR",
  "eu/ua": "UA",
  // Asia
  "as/ae": "AE", "as/am": "AM", "as/az": "AZ", "as/bd": "BD",
  "as/cn": "CN", "as/ge": "GE", "as/hk": "HK", "as/id": "ID",
  "as/il": "IL", "as/in": "IN", "as/ir": "IR", "as/jp": "JP",
  "as/kh": "KH", "as/kr": "KR", "as/kz": "KZ", "as/lb": "LB",
  "as/mm": "MM", "as/mn": "MN", "as/my": "MY", "as/ph": "PH",
  "as/pk": "PK", "as/qa": "QA", "as/sa": "SA", "as/sg": "SG",
  "as/th": "TH", "as/tw": "TW", "as/uz": "UZ", "as/vn": "VN",
  // Americas
  "am/arg": "AR", "am/braz": "BR", "am/belo": "BR", "am/spau": "BR",
  "am/rio": "BR", "am/can": "CA", "am/toro": "CA", "am/van": "CA",
  "am/mont": "CA", "am/cal": "US", "am/chi": "US", "am/ny": "US",
  "am/wash": "US", "am/bost": "US", "am/atl": "US", "am/mia": "US",
  "am/hou": "US", "am/dal": "US", "am/sea": "US", "am/den": "US",
  "am/min": "US", "am/mex": "MX", "am/col": "CO", "am/ven": "VE",
  "am/per": "PE", "am/chi2": "CL", "am/ecu": "EC", "am/pan": "PA",
  "am/arg2": "AR",
  // Africa
  "af/eg": "EG", "af/et": "ET", "af/ma": "MA", "af/ng": "NG",
  "af/sa": "ZA", "af/tz": "TZ", "af/ke": "KE", "af/gh": "GH",
  "af/sn": "SN", "af/ci": "CI", "af/dz": "DZ",
  // Oceania
  "au/aus": "AU", "au/nz": "NZ",
};

function inferCountryFromHref(href) {
  if (!href) return null;
  const parts = href.split("/");
  for (let len = 3; len >= 2; len--) {
    const prefix = parts.slice(0, len).join("/");
    if (PATH_TO_COUNTRY[prefix]) return PATH_TO_COUNTRY[prefix];
  }
  return null;
}

// ---- HTML → clean text ----
// Replaces type-indicator images with text tokens BEFORE stripping all other
// HTML. This preserves the only semantically meaningful content in the markup.

function htmlToText(html) {
  return html
		.replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
		// Type tokens — must come before general tag stripping
    .replace(/<img[^>]*metro-minilogo[^>]*>/gi, "\n[METRO] ")
    .replace(/<img[^>]*monorail-minilogo[^>]*>/gi, "\n[MONORAIL] ")
    .replace(/<img[^>]*light-rail-minilogo[^>]*>/gi, "\n[LIGHT-RAIL] ")
    .replace(/<img[^>]*tram-minilogo[^>]*>/gi, "\n[TRAM] ")
    .replace(/<img[^>]*suburban-minilogo[^>]*>/gi, "\n[SUBURBAN] ")
    .replace(/<img[^>]*people-mover-minilogo[^>]*>/gi, "\n[PEOPLE-MOVER] ")
    // Strip all remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode common entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&mdash;|&#151;|&#8212;|&#8213;/g, "—")
    .replace(/&ndash;|&#8211;/g, "–")
    .replace(/&ocirc;/g, "ô")
    .replace(/&eacute;/g, "é")
    .replace(/&egrave;/g, "è")
    .replace(/&agrave;/g, "à")
    .replace(/&uuml;/g, "ü")
    .replace(/&ouml;/g, "ö")
    .replace(/&auml;/g, "ä")
    .replace(/&szlig;/g, "ß")
    .replace(/&[a-z]+;/gi, "")
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Extract only the "Now open" section, truncated at cutoffDate.
// cutoffDate is a YYYY-MM-DD string — any entry on or before this date is skipped.

function extractNewOpenings(html, cutoffDate) {
  const text = htmlToText(html);

  // Stop at "Next openings" section — we only want confirmed openings
  const nextIdx = text.search(/Next openings:/i);
  const openSection = nextIdx > -1 ? text.slice(0, nextIdx) : text;

  const firstEntryIdx = openSection.search(/\n\[(METRO|TRAM|LIGHT-RAIL|SUBURBAN|MONORAIL|PEOPLE-MOVER)\]/);
  const entriesOnly = firstEntryIdx > -1 ? openSection.slice(firstEntryIdx) : openSection;
	
  if (!cutoffDate) return entriesOnly;

  // Split into lines and drop any that are at or before the cutoff date.
  // Each entry line starts with a type token or a date pattern.
  // We walk line by line and stop as soon as we see a date <= cutoffDate.
  const lines = openSection.split("\n");
  const result = [];
  const datePattern = /(\d{2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i;
  const MONTHS = {
    jan:"01", feb:"02", mar:"03", apr:"04", may:"05", jun:"06",
    jul:"07", aug:"08", sep:"09", oct:"10", nov:"11", dec:"12",
  };

  for (const line of lines) {
    const m = line.match(datePattern);
    if (m) {
      const isoDate = `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}`;
      if (isoDate <= cutoffDate) break; // reached known territory — stop
    }
    result.push(line);
  }

  return result.join("\n").trim();
}

// ---- Cache ----

async function getCached(cacheKey) {
  const db = await connectToMongo();
  const doc = await db.collection("data_source_cache").findOne({
    source: "urbanrail",
    cacheKey,
  });
  if (!doc) return null;
  const ageHours = (Date.now() - doc.fetchedAt.getTime()) / 3600000;
  if (ageHours > doc.ttlHours) return null;
  return doc.response;
}

async function setCache(cacheKey, response) {
  const db = await connectToMongo();
  await db.collection("data_source_cache").updateOne(
    { source: "urbanrail", cacheKey },
    {
      $set: {
        source: "urbanrail",
        cacheKey,
        response,
        fetchedAt: new Date(),
        ttlHours: TTL_HOURS,
      },
    },
    { upsert: true }
  );
}

// ---- Fetch ----

async function fetchNewsHtml() {
  const res = await fetch(NEWS_URL, {
    headers: { "User-Agent": "andrewzc-agent/1.0 (personal project)" },
  });
  if (!res.ok) throw new Error(`urbanrail.net returned ${res.status}`);
  return res.text();
}

// ---- Get last-inserted date from agent_context ----

async function getLastInsertedDate() {
  const db = await connectToMongo();
  const ctx = await db.collection("agent_context").findOne({
    agent: "projects",
    topic: "last_inserted_date",
  });
  return ctx?.content ?? null;
}

// ---- Parse via Claude ----

async function parseWithClaude(cleanText) {
  if (!cleanText.trim()) {
    console.log("[urbanrail] no new content to parse");
    return [];
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are parsing a transit news page to extract openings and closures.

Each entry starts with a type token in brackets, then a date, city, and details:
  [METRO] 08 Apr 2026 -- Mumbai -- Line 2B Diamond Garden — Mandale (5.4 km)
  [TRAM] 05 Apr 2026 -- Birmingham -- Bull St/Corporation St — Millennium Point (0.5 km)
  [LIGHT-RAIL] 08 Feb 2026 -- Toronto -- Line 5 Mount Dennis – Kennedy (19 km) NEW LINE!

Type tokens: [METRO] [MONORAIL] [TRAM] [LIGHT-RAIL] [SUBURBAN] [PEOPLE-MOVER]
Use the token for the "type" field — do not infer type from any other text.
If no token is present, use "metro" as the default.

For each entry extract:
- date: YYYY-MM-DD (use YYYY-MM if day unknown, YYYY if only year)
- city: city name
- country: two-letter ISO code (infer from context — e.g. Mumbai=IN, Birmingham=GB, Toronto=CA)
- lineName: line name or number if present (e.g. "Line 2B", "T6", "Line 5")
- fromStation: first/origin station (before the dash)
- toStation: last/destination station (after the dash)
- type: from the bracket token — "metro", "monorail", "tram", "light-rail", "suburban", "people-mover"
- isNewLine: true if text contains "NEW LINE!"
- isNewSystem: true if text contains "NEW METRO!" or "NEW TRAM!" or "NEW LIGHT RAIL!" or similar
- isClosure: true if entry starts with [X] or mentions "permanently closed"
- lengthKm: numeric km value if present, otherwise null
- notes: any parenthetical notes (e.g. "limited service", "as part of Meerut Metro")

Some entries have two extensions separated by "&" — emit one object per extension.

Return ONLY a JSON array. No prose, no markdown fences.
Omit entries with no parseable date or city.

Content:
${cleanText}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ---- Main export ----

export async function fetchOpenings() {
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `${CACHE_KEY_PREFIX}${today}`;

  // Return cached parse if available
  const cached = await getCached(cacheKey);
  if (cached?.openings) {
    console.log(`[urbanrail] using cached parse (${cached.openings.length} entries)`);
    return cached.openings;
  }

  console.log("[urbanrail] fetching news page");
  const html = await fetchNewsHtml();

  // Get the cutoff date — only parse entries newer than this
  const cutoffDate = await getLastInsertedDate();
  console.log(`[urbanrail] cutoff date: ${cutoffDate ?? "none (first run)"}`);

  const cleanText = extractNewOpenings(html, cutoffDate);
  const lineCount = cleanText.split("\n").filter((l) => l.trim()).length;
  console.log(`[urbanrail] ${lineCount} lines of new content to parse`);

  const openings = await parseWithClaude(cleanText);

  // Backfill country from href where Claude couldn't infer it
  const hrefPattern = /href="([^"]+)"/g;
  const hrefs = [...html.matchAll(hrefPattern)].map((m) => m[1]);

  for (const entry of openings) {
    if (!entry.country) {
      const citySlug = entry.city?.toLowerCase().replace(/\s+/g, "");
      const match = hrefs.find((h) => h.toLowerCase().includes(citySlug ?? "____"));
      if (match) entry.country = inferCountryFromHref(match);
    }
  }

  await setCache(cacheKey, { openings, fetchedAt: new Date() });

  // Update parser state
  const db = await connectToMongo();
  await db.collection("agent_context").updateOne(
    { agent: "projects", topic: "urbanrail_parser_state" },
    {
      $set: {
        agent: "projects",
        topic: "urbanrail_parser_state",
        content: JSON.stringify({
          lastFetch: new Date(),
          itemCount: openings.length,
          cutoffDate,
          cacheKey,
        }),
        updatedAt: new Date(),
        version: 1,
      },
    },
    { upsert: true }
  );

  console.log(`[urbanrail] parsed ${openings.length} new entries`);
  return openings;
}

// Called by projects.js after successful inserts to update the cutoff date.
export async function updateLastInsertedDate(date) {
  if (!date) return;
  const db = await connectToMongo();
  await db.collection("agent_context").updateOne(
    { agent: "projects", topic: "last_inserted_date" },
    {
      $set: {
        agent: "projects",
        topic: "last_inserted_date",
        content: date,
        updatedAt: new Date(),
        version: 1,
      },
    },
    { upsert: true }
  );
  console.log(`[urbanrail] last inserted date updated to ${date}`);
}
