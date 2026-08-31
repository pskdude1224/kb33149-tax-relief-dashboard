// Turns data/raw/zips_esri.json (Miami-Dade ArcGIS ZIP polygons, WGS84) into
// dashboard/zips_map.svg — a themed, self-contained inline-ready SVG that
// matches the site's coastal/aurora palette. Run: node scripts/gen_zip_map.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = JSON.parse(readFileSync(join(ROOT, "data", "raw", "zips_esri.json"), "utf8"));

// Human labels (same as dashboard)
const ZIP_LABELS = {
  33149: "Key Biscayne",       33156: "Pinecrest",
  33143: "South Miami",         33146: "Coral Gables",
  33157: "Palmetto Bay",        33158: "Palmetto Bay",
  33170: "Redland",             33176: "Kendall",
  33186: "West Kendall",        33189: "Cutler Bay",
  33190: "South MDC",           33196: "West Kendall",
  33030: "Homestead",           33032: "Homestead",
  33033: "Homestead",           33034: "Florida City",
  33035: "Homestead",           33039: "Naranja",
};

// Compute bounding box of all rings
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const f of src.features) for (const ring of f.geometry.rings) for (const [x, y] of ring) {
  if (x < minX) minX = x; if (x > maxX) maxX = x;
  if (y < minY) minY = y; if (y > maxY) maxY = y;
}
const pad = 0.005; // ~500 m padding in degrees
minX -= pad; maxX += pad; minY -= pad; maxY += pad;

// Project to SVG coords: keep aspect-correct by scaling lon by cos(midLat)
const midLat = (minY + maxY) / 2;
const lonScale = Math.cos(midLat * Math.PI / 180);
const dLon = (maxX - minX) * lonScale;
const dLat = (maxY - minY);
const W = 1000;
const H = Math.round(W * dLat / dLon);
const project = (lon, lat) => {
  const x = ((lon - minX) * lonScale / dLon) * W;
  const y = ((maxY - lat) / dLat) * H;
  return [x.toFixed(2), y.toFixed(2)];
};
const ringToPath = (ring) => "M" + ring.map(([x, y]) => project(x, y).join(",")).join(" L") + " Z";

// Compute centroid for label placement (rough: use bounding-box centre of outer ring)
function centroid(rings) {
  const outer = rings[0];
  let sx = 0, sy = 0, n = 0, minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const [x, y] of outer) { sx += x; sy += y; n++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  // rough centroid = midpoint of bbox (safer for irregular shapes than mean of vertices)
  return [(minx + maxx) / 2, (miny + maxy) / 2];
}

const paths = src.features.map(f => {
  const zip = f.attributes.ZIP;
  const label = ZIP_LABELS[zip] || "";
  const d = f.geometry.rings.map(ringToPath).join(" ");
  const [cx, cy] = centroid(f.geometry.rings).map((v, i) => project(...(i === 0 ? [v, centroid(f.geometry.rings)[1]] : [centroid(f.geometry.rings)[0], v])));
  const [lx, ly] = project(...centroid(f.geometry.rings));
  return { zip, label, d, lx, ly };
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of the 18 South Miami-Dade ZIP codes covered by SaveOur.Homes">
  <defs>
    <linearGradient id="fill" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#46a6ff" stop-opacity=".28"/>
      <stop offset="1" stop-color="#2dd4bf" stop-opacity=".22"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2.5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <style>
      .zone { fill: url(#fill); stroke: rgba(45,212,191,.55); stroke-width: 1.2; transition: fill .15s, stroke .15s, filter .15s; cursor: default; }
      .zone:hover { fill: rgba(70,166,255,.42); stroke: rgba(45,212,191,.95); filter: url(#glow); }
      .zip-lbl { font: 700 12px -apple-system, "Segoe UI", Roboto, sans-serif; fill: #eaf4ff; pointer-events: none; text-anchor: middle; paint-order: stroke; stroke: rgba(7,11,17,.8); stroke-width: 3; stroke-linejoin: round; }
      .zip-sub { font: 500 9.5px -apple-system, "Segoe UI", Roboto, sans-serif; fill: #9fb0c3; pointer-events: none; text-anchor: middle; paint-order: stroke; stroke: rgba(7,11,17,.7); stroke-width: 2.5; stroke-linejoin: round; }
    </style>
  </defs>
${paths.map(p => `  <path class="zone" data-zip="${p.zip}" d="${p.d}"><title>ZIP ${p.zip}${p.label ? " · " + p.label : ""}</title></path>`).join("\n")}
${paths.map(p => `  <g><text class="zip-lbl" x="${p.lx}" y="${p.ly - 2}">${p.zip}</text><text class="zip-sub" x="${p.lx}" y="${p.ly + 10}">${p.label}</text></g>`).join("\n")}
</svg>
`;

writeFileSync(join(ROOT, "dashboard", "zips_map.svg"), svg);
console.log(`Wrote dashboard/zips_map.svg  (${svg.length} bytes)  viewBox 0 0 ${W} ${H}  bbox (${minX.toFixed(3)},${minY.toFixed(3)})→(${maxX.toFixed(3)},${maxY.toFixed(3)})`);
