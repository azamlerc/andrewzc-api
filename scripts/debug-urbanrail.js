// scripts/debug-urbanrail.js
// Standalone script to fetch urbanrail.net/news.htm, strip HTML, and print
// the clean text. Run with: node scripts/debug-urbanrail.js
//
// Optionally pass a cutoff date to test truncation:
//   node scripts/debug-urbanrail.js 2026-02-14

const NEWS_URL = "https://www.urbanrail.net/news.htm";
const cutoffDate = process.argv[2] ?? null;

const MONTHS = {
  jan:"01", feb:"02", mar:"03", apr:"04", may:"05", jun:"06",
  jul:"07", aug:"08", sep:"09", oct:"10", nov:"11", dec:"12",
};

function htmlToText(html) {
  return html
    // Normalise Windows line endings first — the page is served with CRLF
    // and without this, \n{3,} collapse never fires and the output is noise.
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Type tokens — must come before general tag stripping
    .replace(/<img[^>]*metro-minilogo[^>]*>/gi, "\n[METRO] ")
    .replace(/<img[^>]*monorail-minilogo[^>]*>/gi, "\n[MONORAIL] ")
    .replace(/<img[^>]*light-rail-minilogo[^>]*>/gi, "\n[LIGHT-RAIL] ")
    .replace(/<img[^>]*tram-minilogo[^>]*>/gi, "\n[TRAM] ")
    .replace(/<img[^>]*suburban-minilogo[^>]*>/gi, "\n[SUBURBAN] ")
    .replace(/<img[^>]*people-mover-minilogo[^>]*>/gi, "\n[PEOPLE-MOVER] ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
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
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractNewOpenings(html, cutoffDate) {
  const text = htmlToText(html);

  // Stop at "Next openings" section
  const nextIdx = text.search(/Next openings:/i);
  const openSection = nextIdx > -1 ? text.slice(0, nextIdx) : text;

  // Find the start of the actual entries — look for the first type token
  const firstEntryIdx = openSection.search(/\n\[(METRO|TRAM|LIGHT-RAIL|SUBURBAN|MONORAIL|PEOPLE-MOVER)\]/);
  const entriesOnly = firstEntryIdx > -1 ? openSection.slice(firstEntryIdx) : openSection;

  if (!cutoffDate) return entriesOnly;

  // Walk line by line, stop when we hit a date at or before cutoffDate
  const lines = entriesOnly.split("\n");
  const result = [];
  const datePattern = /(\d{2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i;

  for (const line of lines) {
    const m = line.match(datePattern);
    if (m) {
      const isoDate = `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}`;
      if (isoDate <= cutoffDate) {
        console.log(`\n--- stopping at cutoff: found date ${isoDate} <= ${cutoffDate} ---`);
        break;
      }
    }
    result.push(line);
  }

  return result.join("\n").trim();
}

async function main() {
  console.log(`Fetching ${NEWS_URL}...`);
  const res = await fetch(NEWS_URL, {
    headers: { "User-Agent": "andrewzc-debug/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  console.log(`Fetched ${html.length} bytes of HTML\n`);

  // ---- Diagnostics ----

  // Check if the page content looks like what we expect
  const hasMinilogos = /minilogo/i.test(html);
  const hasMetroLogo = /metro-minilogo/i.test(html);
  const hasDatePattern = /\d{2}\s+\w+\s+\d{4}\s+--/.test(html);
  const imgCount = (html.match(/<img/gi) ?? []).length;
  const pCount = (html.match(/<p/gi) ?? []).length;

  console.log("=== DIAGNOSTICS ===");
  console.log(`  <img> tags found:       ${imgCount}`);
  console.log(`  <p> tags found:         ${pCount}`);
  console.log(`  'minilogo' in HTML:     ${hasMinilogos}`);
  console.log(`  'metro-minilogo':       ${hasMetroLogo}`);
  console.log(`  date pattern (DD Mon YYYY --): ${hasDatePattern}`);

  // Show a snippet around the first minilogo if present
  if (hasMinilogos) {
    const idx = html.toLowerCase().indexOf("minilogo");
    console.log(`\n  First minilogo context (chars ${idx-100} to ${idx+100}):`);
    console.log("  " + html.slice(Math.max(0, idx - 100), idx + 100).replace(/\n/g, "↵"));
  }

  // Show the first 500 chars of raw HTML to check structure
  console.log("\n  First 500 chars of HTML:");
  console.log("  " + html.slice(0, 500).replace(/\n/g, "↵"));

  // Check if there's a "Now open" or "Recent Openings" section
  const hasNowOpen = /now open/i.test(html);
  const hasRecentOpenings = /recent openings/i.test(html);
  console.log(`\n  'Now open' in HTML:      ${hasNowOpen}`);
  console.log(`  'Recent Openings':       ${hasRecentOpenings}`);

  console.log("\n=== END DIAGNOSTICS ===\n");

  if (cutoffDate) {
    console.log(`Cutoff date: ${cutoffDate}\n`);
  }

  const text = extractNewOpenings(html, cutoffDate);

  console.log("=== CLEAN TEXT ===\n");
  console.log(text || "(empty)");
  console.log("\n=== END ===");
  console.log(`\nTotal length: ${text.length} chars`);
  console.log(`Lines: ${text.split("\n").filter(l => l.trim()).length}`);
}

main().catch(console.error);
