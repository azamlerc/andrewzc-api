// maps.js
// Composes a small mosaic of OpenStreetMap raster tiles for the map_view MCP
// tool, with a marker at the exact point requested.
//
// This is deliberately the same shape as the images pipeline: no accounts, no
// storage, nothing cached — just fetch a handful of public tiles, stitch them,
// and hand back bytes. It exists so Claude can look at what a place actually
// looks like (a roundabout, an intersection, a station throat) without a
// browser in the loop.
//
// OSM's tile usage policy (https://operations.osmfoundation.org/policies/tiles/)
// requires a real identifying User-Agent and no heavy/bulk/scripted use. This
// is single-user, on-demand, a handful of tiles per call — well inside normal
// personal use — but it is not a general-purpose tile proxy, and should not
// become one. If usage ever grows past occasional lookups, switch to a paid
// provider (MapTiler, Stadia, etc.) or a self-hosted tile cache instead of
// leaning harder on OSM's free servers.

import sharp from "sharp";

const TILE_SIZE = 256;
const OSM_TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const USER_AGENT = "andrewzc.net map_view/1.0 (+https://andrewzc.net; contact andrew@voyagier.com)";

const MARKER_COLOR = "#e8412c";
const MARKER_RADIUS = 7;

// Fractional tile coordinates (Web Mercator "slippy map" projection). The
// integer part of each is the tile index; the fractional part is where within
// that tile the point falls, which is what lets the marker land on an exact
// pixel rather than just "somewhere in this tile."
export function latLonToTileFrac(lat, lon, zoom) {
  const latRad = (lat * Math.PI) / 180;
  const n = 2 ** zoom;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

async function fetchTile(zoom, x, y) {
  const res = await fetch(OSM_TILE_URL(zoom, x, y), { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Tile fetch failed (${res.status}): z${zoom}/${x}/${y}`);
  return Buffer.from(await res.arrayBuffer());
}

// lat/lon must be valid Web Mercator input: |lat| <= 85.05112878.
export async function renderMapView({ lat, lon, zoom, size = 3 }) {
  const n = 2 ** zoom;
  const { x: xFrac, y: yFrac } = latLonToTileFrac(lat, lon, zoom);
  const centerX = Math.floor(xFrac);
  const centerY = Math.floor(yFrac);
  const half = Math.floor(size / 2);
  const topLeftX = centerX - half;
  const topLeftY = centerY - half;

  const wanted = [];
  for (let dy = 0; dy < size; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) {
      const ty = topLeftY + dy;
      if (ty < 0 || ty >= n) continue; // off the top/bottom of the projection
      const tx = ((topLeftX + dx) % n + n) % n; // wrap around the antimeridian
      wanted.push({ dx, dy, tx, ty });
    }
  }

  const fetched = await Promise.all(
    wanted.map(async (t) => ({ ...t, buf: await fetchTile(zoom, t.tx, t.ty) }))
  );

  const canvasSize = size * TILE_SIZE;
  const markerPxX = (xFrac - topLeftX) * TILE_SIZE;
  const markerPxY = (yFrac - topLeftY) * TILE_SIZE;
  const markerSvg = Buffer.from(
    `<svg width="${canvasSize}" height="${canvasSize}" xmlns="http://www.w3.org/2000/svg">
       <circle cx="${markerPxX}" cy="${markerPxY}" r="${MARKER_RADIUS}" fill="${MARKER_COLOR}" stroke="white" stroke-width="2.5"/>
     </svg>`
  );

  const bytes = await sharp({
    create: { width: canvasSize, height: canvasSize, channels: 3, background: "#e8e8e0" },
  })
    .composite([
      ...fetched.map(t => ({ input: t.buf, left: t.dx * TILE_SIZE, top: t.dy * TILE_SIZE })),
      { input: markerSvg, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();

  return {
    bytes,
    contentType: "image/png",
    tileRange: { zoom, x: [topLeftX, topLeftX + size - 1], y: [topLeftY, topLeftY + size - 1] },
  };
}
