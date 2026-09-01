// Turns data/raw/zips_esri.json (Miami-Dade ArcGIS ZIP polygons, WGS84) into
// dashboard/zips_map.svg — themed, clickable, aspect-correct SVG.
//
// Each district is wrapped in an <a> that navigates the top window to
// app.html?zip=<zip> so the dashboard opens pre-filtered to that ZIP.
// Labels use true polygon centroids, are sized to fit inside the polygon,
// and drop when they'd collide with a bigger neighbour's label.
//
// Run: node scripts/gen_zip_map.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = JSON.parse(readFileSync(join(ROOT, "data", "raw", "zips_esri.json"), "utf8"));

// ---- projection: aspect-correct equirectangular, cropped to the UDB ----
// Use the ZIP polygons' full extent for east/north/south, but CROP the western
// bound to just west of the Urban Development Boundary. This drops the empty
// Everglades tails from the visible map and zooms into where people actually live.
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const f of src.features) for (const ring of f.geometry.rings) for (const [x, y] of ring) {
  if (x < minX) minX = x; if (x > maxX) maxX = x;
  if (y < minY) minY = y; if (y > maxY) maxY = y;
}
// Pull UDB early to find its westernmost longitude; if we have it, use it as
// the map's western crop (a small buffer to the west so the line isn't at the edge).
let udbMinX = Infinity;
try {
  const udbPre = JSON.parse(readFileSync(join(ROOT, "data", "raw", "udb.json"), "utf8"));
  for (const f of udbPre.features || []) for (const p of (f.geometry || {}).paths || []) for (const [x] of p) {
    if (x < udbMinX) udbMinX = x;
  }
} catch { udbMinX = Infinity; }
if (isFinite(udbMinX)) minX = Math.max(minX, udbMinX - 0.010); // ~1 km buffer west of the UDB
const pad = 0.005;
minX -= pad; maxX += pad; minY -= pad; maxY += pad;
const midLat = (minY + maxY) / 2;
const lonScale = Math.cos(midLat * Math.PI / 180);
const dLon = (maxX - minX) * lonScale;
const dLat = (maxY - minY);
const W = 1000, H = Math.round(W * dLat / dLon);
const project = (lon, lat) => [((lon - minX) * lonScale / dLon) * W, ((maxY - lat) / dLat) * H];

// ---- geometry helpers ----
function polygonArea(ring) {
  let a = 0; const n = ring.length - 1;
  for (let i = 0; i < n; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a * 0.5;
}
function polygonCentroid(ring) {
  let x = 0, y = 0, a = 0; const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    const c = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    a += c; x += (ring[i][0] + ring[i + 1][0]) * c; y += (ring[i][1] + ring[i + 1][1]) * c;
  }
  a *= 0.5;
  return [x / (6 * a), y / (6 * a)];
}
function pointInRing(pt, ring) {
  let inside = false; const [px, py] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const intersect = ((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function bestLabelPoint(rings, minLon = -Infinity) {
  // Outer ring = largest by |area|. When the map is cropped west of `minLon`,
  // we consider only the eastern (visible) portion of the polygon so labels
  // land inside the visible viewBox, not out in the Everglades.
  const outer0 = rings.reduce((a, b) => Math.abs(polygonArea(b)) > Math.abs(polygonArea(a)) ? b : a);
  let outer = outer0.filter(([x]) => x >= minLon);
  if (outer.length < 3) outer = outer0;
  else if (outer[0][0] !== outer[outer.length - 1][0] || outer[0][1] !== outer[outer.length - 1][1]) outer = outer.concat([outer[0]]);
  const c = polygonCentroid(outer);
  if (isFinite(c[0]) && pointInRing(c, outer)) return c;
  // fallback: sample a grid inside the polygon's bbox, pick point with max distance to edge
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (const [x, y] of outer) { if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; }
  let best = null, bestD = -1;
  for (let ix = 0; ix < 20; ix++) for (let iy = 0; iy < 20; iy++) {
    const px = mnx + (mxx - mnx) * (ix + 0.5) / 20;
    const py = mny + (mxy - mny) * (iy + 0.5) / 20;
    if (!pointInRing([px, py], outer)) continue;
    // distance to nearest edge (sample the ring)
    let d = Infinity;
    for (let k = 0; k < outer.length - 1; k++) {
      const [ax, ay] = outer[k], [bx, by] = outer[k + 1];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
      const qx = ax + t * dx, qy = ay + t * dy;
      const dd = (px - qx) * (px - qx) + (py - qy) * (py - qy);
      if (dd < d) d = dd;
    }
    if (d > bestD) { bestD = d; best = [px, py]; }
  }
  return best || c;
}

// ---- ZIP -> municipality label ----
const CITY = {
  33149: "Key Biscayne", 33156: "Pinecrest",     33143: "South Miami",  33146: "Coral Gables",
  33157: "Palmetto Bay", 33158: "Palmetto Bay",  33170: "Redland",       33176: "Kendall",
  33186: "West Kendall", 33189: "Cutler Bay",    33190: "South MDC",     33196: "West Kendall",
  33030: "Homestead",    33032: "Homestead",     33033: "Homestead",     33034: "Florida City",
  33035: "Homestead",    33039: "Naranja",
};

// ---- build feature records with area + centroid ----
const feats = src.features.map(f => {
  const zip = String(f.attributes.ZIP);
  const outer = f.geometry.rings.reduce((a, b) => Math.abs(polygonArea(b)) > Math.abs(polygonArea(a)) ? b : a);
  const area = Math.abs(polygonArea(outer));
  const [clon, clat] = bestLabelPoint(f.geometry.rings, minX);
  const [lx, ly] = project(clon, clat);
  const d = f.geometry.rings.map(r => "M" + r.map(([x, y]) => project(x, y).map(v => v.toFixed(2)).join(",")).join(" L") + " Z").join(" ");
  return { zip, area, lx, ly, d, city: CITY[zip] || "" };
});

// ---- label placement with three-tier fallback + city-name dedup ----
// 1. Inline "33149 · Key Biscayne" (~1-line, wider bbox)
// 2. ZIP-only fallback if the inline form collides
// 3. Drop label entirely if even ZIP-only collides (still clickable + tooltip)
// City name is only allowed on the LARGEST polygon per city — smaller
// same-city neighbours drop back to ZIP-only.
const CHAR_W = 6.6; // ~ px per char at the label font size
const LBL_H = 18;
const placed = [];
const sorted = feats.slice().sort((a, b) => b.area - a.area);
for (const f of sorted) {
  // ZIP-only labels on the map — the city names live in the legend beside it.
  const box = { x0: f.lx - 22, y0: f.ly - LBL_H / 2, x1: f.lx + 22, y1: f.ly + LBL_H / 2 };
  const collides = placed.some(p => !(box.x1 < p.x0 || box.x0 > p.x1 || box.y1 < p.y0 || box.y0 > p.y1));
  if (!collides) placed.push(box);
  f.showLabel = true; // always show — small overlaps beat a missing district number
  f.labelText = f.zip;
}

// ---- fetch UDB polyline (optional — beautifies map) ----
let udbPathD = "";
try {
  const udb = JSON.parse(readFileSync(join(ROOT, "data", "raw", "udb.json"), "utf8"));
  const parts = [];
  for (const f of udb.features || []) for (const path of (f.geometry || {}).paths || []) {
    if (path.length < 2) continue;
    parts.push("M" + path.map(([x, y]) => project(x, y).map(v => v.toFixed(1)).join(",")).join(" L"));
  }
  udbPathD = parts.join(" ");
} catch { /* UDB optional; if missing, skip it */ }

// ---- emit SVG (clickable via wrapping <a target="_top">) ----
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of the 18 South Miami-Dade ZIP districts. Click any district to open its dashboard view.">
  <defs>
    <linearGradient id="fill" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#46a6ff" stop-opacity=".22"/>
      <stop offset="1" stop-color="#2dd4bf" stop-opacity=".18"/>
    </linearGradient>
    <linearGradient id="fillHover" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#46a6ff" stop-opacity=".55"/>
      <stop offset="1" stop-color="#2dd4bf" stop-opacity=".50"/>
    </linearGradient>
    <radialGradient id="oceanGlow" cx="90%" cy="18%" r="70%">
      <stop offset="0" stop-color="#1a4a6b" stop-opacity=".45"/>
      <stop offset="1" stop-color="#050a12" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="wildernessMist" cx="10%" cy="55%" r="55%">
      <stop offset="0" stop-color="#12252a" stop-opacity=".55"/>
      <stop offset="1" stop-color="#050a12" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="drop" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
      <feOffset dx="0" dy="2" result="o"/>
      <feComponentTransfer><feFuncA type="linear" slope=".55"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <style>
      .backdrop-ocean { fill: url(#oceanGlow); }
      .backdrop-wild  { fill: url(#wildernessMist); }
      .zone { fill: url(#fill); stroke: rgba(45,212,191,.55); stroke-width: 1.2; transition: fill .15s, stroke .15s, filter .15s; cursor: pointer; filter: url(#drop); }
      .zone:hover, .zone.hi { fill: url(#fillHover); stroke: rgba(45,212,191,1); filter: url(#glow); }
      a { text-decoration: none; }
      a:focus .zone { outline: none; stroke: #fff; stroke-width: 2; }
      .zip-lbl { font: 700 12px -apple-system, "Segoe UI", Roboto, sans-serif; fill: #eaf4ff; pointer-events: none; text-anchor: middle; paint-order: stroke; stroke: rgba(7,11,17,.9); stroke-width: 3.5; stroke-linejoin: round; }
      .udb { fill: none; stroke: #f2b65a; stroke-width: 1.4; stroke-dasharray: 6 4; opacity: .85; pointer-events: none; }
      .udb-glow { fill: none; stroke: #f2b65a; stroke-width: 6; opacity: .18; filter: blur(2px); pointer-events: none; }
      .place-lbl { font: italic 400 13px -apple-system, "Segoe UI", Roboto, sans-serif; fill: rgba(159,176,195,.6); pointer-events: none; letter-spacing: 2px; text-transform: uppercase; }
      .map-legend { pointer-events: none; }
      .map-legend text { font: 500 11px -apple-system, "Segoe UI", Roboto, sans-serif; fill: rgba(195,206,219,.85); }
      .map-legend .lg-sw { stroke: #f2b65a; stroke-width: 1.4; stroke-dasharray: 6 4; fill: none; }
      .compass { pointer-events: none; }
      .compass .c-ring { fill: none; stroke: rgba(159,176,195,.35); stroke-width: 1; }
      .compass .c-needle-n { fill: #ff9b9b; }
      .compass .c-needle-s { fill: rgba(159,176,195,.6); }
      .compass text { font: 700 10px -apple-system, "Segoe UI", Roboto, sans-serif; fill: rgba(207,230,255,.85); text-anchor: middle; letter-spacing: 1px; }
    </style>
  </defs>

  <!-- atmospheric backdrops -->
  <rect class="backdrop-ocean" x="0" y="0" width="${W}" height="${H}"/>
  <rect class="backdrop-wild"  x="0" y="0" width="${W}" height="${H}"/>

  <!-- 'BISCAYNE BAY' whisper (east of the mainland) -->
  <text class="place-lbl" x="${W - 60}" y="${Math.round(H * .38)}" text-anchor="end">BISCAYNE BAY</text>
  <text class="place-lbl" x="60" y="${Math.round(H * .55)}" transform="rotate(-90 60 ${Math.round(H * .55)})">EVERGLADES</text>

  <!-- ZIP districts (each clickable) -->
${feats.map(f => `  <a href="app.html?zip=${f.zip}" target="_top"><path class="zone" data-zip="${f.zip}" d="${f.d}"><title>ZIP ${f.zip}${f.city ? " · " + f.city : ""} — click for its dashboard view</title></path></a>`).join("\n")}

  <!-- Urban Development Boundary (dashed amber accent + soft glow) -->
${udbPathD ? `  <path class="udb-glow" d="${udbPathD}"/>\n  <path class="udb" d="${udbPathD}"/>` : ""}

  <!-- ZIP labels -->
${feats.filter(f => f.showLabel).map(f => `  <text class="zip-lbl" data-zip="${f.zip}" x="${f.lx.toFixed(1)}" y="${(f.ly + 4).toFixed(1)}">${f.labelText}</text>`).join("\n")}

  <!-- in-map legend (bottom-left) -->
  <g class="map-legend" transform="translate(24 ${H - 40})">
    <line class="lg-sw" x1="0" y1="0" x2="34" y2="0"/>
    <text x="42" y="4">Urban Development Boundary</text>
  </g>

  <!-- compass (bottom-right) -->
  <g class="compass" transform="translate(${W - 60} ${H - 68})">
    <circle class="c-ring" r="26"/>
    <polygon class="c-needle-n" points="0,-22 5,0 -5,0"/>
    <polygon class="c-needle-s" points="0,22 5,0 -5,0"/>
    <text y="-32">N</text>
  </g>
</svg>
`;

writeFileSync(join(ROOT, "dashboard", "zips_map.svg"), svg);
const dropped = feats.filter(f => !f.showLabel).map(f => f.zip);
console.log(`Wrote dashboard/zips_map.svg  (${svg.length} bytes)  viewBox 0 0 ${W} ${H}`);
console.log(`Labels shown for ${feats.length - dropped.length}/${feats.length} zips. Dropped (collide with bigger neighbour, still clickable + tooltip): ${dropped.join(", ") || "none"}`);
