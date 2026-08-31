// Step 1 — Enumerate every parcel (folio) for one or more ZIP codes.
//
// SOURCE: Miami-Dade County live ArcGIS (PaGis, MD_LandInformation layer 24).
// The UM GDSC mirror in the original spec is dead; PaGis is the equivalent
// live layer (same MDC roll, same field names). Its value fields are NULL —
// per-folio assessed/taxable/exemption come from Step 2 (PA proxy API).
//
// ZIPs are configurable via CLI or env: node 01_fetch_parcels.mjs 33149 33156
// or ZIPS="33149,33156" node 01_fetch_parcels.mjs. Default = 33149,33156.
//
// Output: data/raw/parcels.json  (combined; each record has a `zip` field)
//         data/raw/parcels.csv   (flattened, same set)
//         data/raw/parcels_meta.json (per-zip + total counts, DOR breakdown)

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_DIR = join(ROOT, "data", "raw");
mkdirSync(RAW_DIR, { recursive: true });

const argsZips = process.argv.slice(2).filter((a) => /^\d{5}$/.test(a));
const ZIPS = argsZips.length
  ? argsZips
  : (process.env.ZIPS || "33149,33156").split(",").map((s) => s.trim()).filter((s) => /^\d{5}$/.test(s));

const LAYER = "https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer/24/query";
const OUT_FIELDS = [
  "OBJECTID", "FOLIO", "TRUE_SITE_ADDR", "TRUE_SITE_CITY", "TRUE_SITE_ZIP_CODE",
  "DOR_CODE_CUR", "DOR_DESC", "CONDO_FLAG", "PARENT_FOLIO", "PRIMARY_ZONE",
  "BEDROOM_COUNT", "YEAR_BUILT", "LOT_SIZE", "BUILDING_HEATED_AREA",
  "UNIT_COUNT", "ASSESSMENT_YEAR_CUR",
];
const PAGE = 1000;

function qs(params) {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
async function getJSON(params, tries = 4) {
  const url = `${LAYER}?${qs(params)}`;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`ArcGIS ${body.error.code}: ${body.error.message}`);
      return body;
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

async function fetchZip(zip) {
  const where = `TRUE_SITE_ZIP_CODE LIKE '${zip}%'`;
  const b = await getJSON({ where, returnCountOnly: "true", f: "json" });
  const expected = b.count ?? null;
  console.log(`\n[${zip}] server reports ${expected} parcels`);
  const rows = [];
  let lastOid = -1;
  for (;;) {
    const body = await getJSON({
      where: `(${where}) AND OBJECTID > ${lastOid}`,
      outFields: OUT_FIELDS.join(","),
      returnGeometry: "false",
      f: "json",
      resultRecordCount: String(PAGE),
      orderByFields: "OBJECTID ASC",
    });
    const page = (body.features || []).map((f) => ({ ...f.attributes, zip }));
    if (page.length === 0) break;
    for (const r of page) rows.push(r);
    lastOid = page[page.length - 1].OBJECTID;
    console.log(`  [${zip}] +${page.length} (${rows.length}), lastOID=${lastOid}`);
    if (page.length < PAGE) break;
  }
  if (expected != null && rows.length !== expected)
    console.warn(`  [${zip}] WARNING: fetched ${rows.length} != reported ${expected}`);
  return { zip, expected, rows };
}

console.log(`Fetching parcels for ZIPs: ${ZIPS.join(", ")}`);
const perZip = [];
for (const zip of ZIPS) perZip.push(await fetchZip(zip));

// combine + dedupe by folio (defensive)
const seen = new Set();
const combined = [];
for (const { rows } of perZip) {
  for (const r of rows) {
    if (seen.has(r.FOLIO)) continue;
    seen.add(r.FOLIO);
    combined.push(r);
  }
}

function toCSV(rows) {
  if (!rows.length) return "";
  const cols = [...OUT_FIELDS, "zip"];
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");
}
writeFileSync(join(RAW_DIR, "parcels.json"), JSON.stringify(combined, null, 2));
writeFileSync(join(RAW_DIR, "parcels.csv"), toCSV(combined));

const perZipMeta = {};
for (const { zip, expected, rows } of perZip) {
  const dor = {};
  for (const r of rows) {
    const k = `${r.DOR_CODE_CUR} ${r.DOR_DESC}`;
    dor[k] = (dor[k] || 0) + 1;
  }
  perZipMeta[zip] = { parcel_count: rows.length, server_reported: expected, dor_distribution: dor };
}
writeFileSync(join(RAW_DIR, "parcels_meta.json"), JSON.stringify({
  fetched_at: new Date().toISOString(), source: LAYER, zips: ZIPS,
  total_parcels: combined.length, per_zip: perZipMeta,
}, null, 2));

console.log(`\n=== DONE === ${combined.length} unique parcels across ${ZIPS.length} zip(s)`);
console.log("Wrote data/raw/parcels.json, parcels.csv, parcels_meta.json");
