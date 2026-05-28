// Step 1 — Enumerate every parcel (folio) in ZIP 33149.
//
// NOTE ON SOURCE: The CLAUDE.md spec points at the UM GDSC mirror
// (arcgis.gdsc.miami.edu .../mdc_property_point_view). As of this build that
// mirror's query backend is DEAD — metadata loads but every /query returns
// HTTP 400 "Unable to perform query operation", and its service description is
// frozen at "Last Updated: April 12, 2023". We pivot to Miami-Dade County's
// own live ArcGIS: the Property Appraiser GIS layer "Property @ PaGis"
// (MD_LandInformation/MapServer/24). Same underlying MDC property roll, same
// field names (folio, dor_code_cur, dor_desc, condo_flag, true_site_*).
//
// IMPORTANT: PaGis value fields (LAND/BUILDING/TOTAL_VAL_CUR) are NULL for
// 33149, so this step only yields the parcel UNIVERSE (folio + address + DOR +
// condo flag). Assessed / taxable / exemption values come in Step 2 from the
// Property Appraiser per-folio roll API.
//
// Output: data/raw/parcels_33149_raw.json  (verbatim attributes)
//         data/raw/parcels_33149.csv       (flattened)
//         data/raw/parcels_meta.json       (fetch provenance)
// Run: node pipeline/01_fetch_parcels.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_DIR = join(ROOT, "data", "raw");
mkdirSync(RAW_DIR, { recursive: true });

const LAYER =
  "https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer/24/query";
const WHERE = "TRUE_SITE_ZIP_CODE LIKE '33149%'";
const OUT_FIELDS = [
  "OBJECTID", "FOLIO", "TRUE_SITE_ADDR", "TRUE_SITE_CITY", "TRUE_SITE_ZIP_CODE",
  "DOR_CODE_CUR", "DOR_DESC", "CONDO_FLAG", "PARENT_FOLIO", "PRIMARY_ZONE",
  "BEDROOM_COUNT", "YEAR_BUILT", "LOT_SIZE", "BUILDING_HEATED_AREA",
  "UNIT_COUNT", "ASSESSMENT_YEAR_CUR",
];
const PAGE = 1000;

function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
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

async function getCount() {
  const b = await getJSON({ where: WHERE, returnCountOnly: "true", f: "json" });
  return b.count ?? null;
}

// Keyset pagination on OBJECTID — robust even where resultOffset isn't honored.
async function fetchAll() {
  console.log(`Source: PaGis layer 24 | where ${WHERE}`);
  const expected = await getCount();
  console.log(`  server reports ${expected} parcels`);

  const rows = [];
  let lastOid = -1;
  for (;;) {
    const b = await getJSON({
      where: `(${WHERE}) AND OBJECTID > ${lastOid}`,
      outFields: OUT_FIELDS.join(","),
      returnGeometry: "false",
      f: "json",
      resultRecordCount: String(PAGE),
      orderByFields: "OBJECTID ASC",
    });
    const page = (b.features || []).map((f) => f.attributes);
    if (page.length === 0) break;
    for (const r of page) rows.push(r);
    lastOid = page[page.length - 1].OBJECTID;
    console.log(`  +${page.length} (total ${rows.length}), lastOID=${lastOid}`);
    if (page.length < PAGE) break;
  }
  return { rows, expected };
}

function toCSV(rows) {
  if (!rows.length) return "";
  const cols = OUT_FIELDS;
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");
}

const { rows, expected } = await fetchAll();
if (expected != null && rows.length !== expected)
  console.warn(`  WARNING: fetched ${rows.length} != reported ${expected}`);

// dedupe by folio (defensive)
const seen = new Set();
const deduped = rows.filter((r) => (seen.has(r.FOLIO) ? false : (seen.add(r.FOLIO), true)));

writeFileSync(join(RAW_DIR, "parcels_33149_raw.json"), JSON.stringify(deduped, null, 2));
writeFileSync(join(RAW_DIR, "parcels_33149.csv"), toCSV(deduped));

const dor = {};
for (const r of deduped) {
  const k = `${r.DOR_CODE_CUR} ${r.DOR_DESC}`;
  dor[k] = (dor[k] || 0) + 1;
}
writeFileSync(
  join(RAW_DIR, "parcels_meta.json"),
  JSON.stringify(
    {
      fetched_at: new Date().toISOString(),
      source: LAYER,
      source_note:
        "GDSC mirror dead (query backend 400s); using live Miami-Dade County PaGis layer 24. Values are sourced separately in Step 2 (PaGis value fields are null).",
      where: WHERE,
      parcel_count: deduped.length,
      server_reported_count: expected,
      dor_distribution: dor,
    },
    null,
    2
  )
);

console.log(`\n=== DONE === ${deduped.length} parcels`);
console.log("Wrote data/raw/parcels_33149_raw.json, parcels_33149.csv, parcels_meta.json");
