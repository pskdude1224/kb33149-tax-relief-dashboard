// Step 2 — Per-folio tax roll: assessed value, taxable value, exemptions,
// homestead status. Source: Miami-Dade Property Appraiser public proxy API
// (apps.miamidadepa.gov/PApublicServiceProxy). One call per folio.
//
// This is the source that has the exemption flag + taxable value the budget
// model needs (the GIS layers do NOT). Free, no key. Reflects the certified
// current roll (RollYear1).
//
// Resumable: re-running skips folios already captured in roll_33149.json unless
// you pass --fresh. Output: data/raw/roll_33149.json + data/raw/roll_meta.json
// Run: node pipeline/02_fetch_roll.mjs [--fresh] [--limit=N] [--conc=8]

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_DIR = join(ROOT, "data", "raw");
mkdirSync(RAW_DIR, { recursive: true });
const ROLL_PATH = join(RAW_DIR, "roll_33149.json");

const args = process.argv.slice(2);
const FRESH = args.includes("--fresh");
const LIMIT = Number((args.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || Infinity;
const CONC = Number((args.find((a) => a.startsWith("--conc=")) || "").split("=")[1]) || 8;

const PROXY = "https://apps.miamidadepa.gov/PApublicServiceProxy/PaServicesProxy.ashx";
const HEADERS = { "User-Agent": "Mozilla/5.0", Referer: "https://www.miamidadepa.gov/" };

const parcels = JSON.parse(readFileSync(join(RAW_DIR, "parcels_33149_raw.json"), "utf8"));
let folios = parcels.map((p) => String(p.FOLIO));

// resume
const done = new Map();
if (!FRESH && existsSync(ROLL_PATH)) {
  for (const r of JSON.parse(readFileSync(ROLL_PATH, "utf8"))) done.set(r.folio, r);
  console.log(`Resuming: ${done.size} folios already captured`);
}
let todo = folios.filter((f) => !done.has(f));
if (LIMIT !== Infinity) todo = todo.slice(0, LIMIT);
console.log(`To fetch: ${todo.length} of ${folios.length} folios (conc=${CONC})`);

function pick(infos, year) {
  if (!Array.isArray(infos) || infos.length === 0) return null;
  return infos.find((x) => x.Year === year) || infos.slice().sort((a, b) => b.Year - a.Year)[0];
}

async function fetchFolio(folio, tries = 4) {
  const url = `${PROXY}?Operation=GetPropertySearchByFolio&clientAppName=PropertySearch&folioNumber=${encodeURIComponent(folio)}`;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return extract(folio, j);
    } catch (e) {
      if (i === tries - 1) return { folio, ok: false, error: String(e.message || e) };
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
}

function extract(folio, j) {
  const pi = j.PropertyInfo || {};
  const rollYear = j.RollYear1 || 0;
  const a = pick((j.Assessment || {}).AssessmentInfos, rollYear);
  const t = pick((j.Taxable || {}).TaxableInfos, rollYear);
  const benefits = ((j.Benefit || {}).BenefitInfos || []).filter((b) => b.TaxYear === rollYear);
  const invalid = /Invalid Folio/i.test(j.Message || "") || !a;

  const homesteadBenefit = benefits.some(
    (b) => b.Type === "Exemption" && /homestead/i.test(b.Description) && !/second/i.test(b.Description)
  );
  const homestead = homesteadBenefit || (pi.HxBaseYear || 0) > 0 || (pi.PercentHomesteadCapped || 0) > 0;

  return {
    folio,
    ok: !invalid,
    roll_year: rollYear || null,
    municipality: pi.Municipality || null,
    dor_code: pi.DORCode || null,
    dor_desc: pi.DORDescriptionCurrent || pi.DORDescription || null,
    hx_base_year: pi.HxBaseYear || 0,
    pct_homestead_capped: pi.PercentHomesteadCapped || 0,
    homestead,
    just_value: a ? a.TotalValue : null, // market value
    assessed_value: a ? a.AssessedValue : null, // SOH-capped
    land_value: a ? a.LandValue : null,
    building_value: a ? a.BuildingOnlyValue : null,
    // non-school local taxable (Village + County levy base) — primary for model
    county_taxable: t ? t.CountyTaxableValue : null,
    city_taxable: t ? t.CityTaxableValue : null,
    school_taxable: t ? t.SchoolTaxableValue : null,
    county_exemption: t ? t.CountyExemptionValue : null,
    city_exemption: t ? t.CityExemptionValue : null,
    school_exemption: t ? t.SchoolExemptionValue : null,
    exemptions: benefits
      .filter((b) => b.Type === "Exemption")
      .map((b) => ({ desc: b.Description, value: b.Value })),
    soh_cap: (benefits.find((b) => /save our homes/i.test(b.Description)) || {}).Value || 0,
  };
}

// worker pool
const results = Array.from(done.values());
let i = 0,
  ncompleted = 0,
  nfail = 0;
const t0 = Date.now();

async function worker() {
  while (i < todo.length) {
    const folio = todo[i++];
    const r = await fetchFolio(folio);
    if (!r || r.ok === false) nfail++;
    results.push(r);
    ncompleted++;
    if (ncompleted % 250 === 0 || ncompleted === todo.length) {
      writeFileSync(ROLL_PATH, JSON.stringify(results, null, 1));
      const rate = ncompleted / ((Date.now() - t0) / 1000);
      console.log(`  ${ncompleted}/${todo.length} (fail ${nfail}) ~${rate.toFixed(1)}/s`);
    }
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
writeFileSync(ROLL_PATH, JSON.stringify(results, null, 1));

// provenance + quick stats
const valid = results.filter((r) => r && r.ok);
const years = {};
const munis = {};
let hs = 0;
for (const r of valid) {
  years[r.roll_year] = (years[r.roll_year] || 0) + 1;
  munis[r.municipality || "(none)"] = (munis[r.municipality || "(none)"] || 0) + 1;
  if (r.homestead) hs++;
}
writeFileSync(
  join(RAW_DIR, "roll_meta.json"),
  JSON.stringify(
    {
      fetched_at: new Date().toISOString(),
      source: PROXY,
      operation: "GetPropertySearchByFolio",
      total_folios: folios.length,
      captured: results.length,
      valid: valid.length,
      invalid_or_failed: results.length - valid.length,
      homestead_count: hs,
      roll_year_distribution: years,
      municipality_distribution: munis,
    },
    null,
    2
  )
);

console.log(`\n=== DONE === captured ${results.length}, valid ${valid.length}, homestead ${hs}`);
console.log("roll years:", years);
console.log("municipalities:", munis);
