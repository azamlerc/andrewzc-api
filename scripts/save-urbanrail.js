// scripts/save-urbanrail.js
// Fetches urbanrail.net/news.htm and saves the raw HTML to disk for inspection.
// Run with: node scripts/save-urbanrail.js

import { writeFileSync } from "fs";

const NEWS_URL = "https://www.urbanrail.net/news.htm";

const res = await fetch(NEWS_URL, {
  headers: { "User-Agent": "andrewzc-debug/1.0" },
});
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const html = await res.text();
writeFileSync("scripts/urbanrail-raw.html", html, "utf8");
console.log(`Saved ${html.length} bytes to scripts/urbanrail-raw.html`);
