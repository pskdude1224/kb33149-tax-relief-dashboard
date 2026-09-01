// Step 3 — Join parcels (Step 1) + roll (Step 2), classify, and build the
// modeled dataset the dashboard consumes. Multi-ZIP: each parcel carries `zip`
// and summaries are computed per ZIP + overall.

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const DERIVED = join(ROOT, "data", "derived");
mkdirSync(DERIVED, { recursive: true });

// ---- defaults (editable in the dashboard) ----
// Amendment 3 (Nov 2026 ballot) raises the homestead exemption for NON-SCHOOL
// local taxes only. School millages keep the existing $25K exemption unchanged.
// Ballot amounts: $150,000 in 2027, $250,000 in 2028+ (inflation-adjusted).
const DEFAULTS = {
  millage: 9.0, // approx KB combined NON-school local (Village + County + specials); editable
  combined_millage: 15.6226, // combined incl. school — for reference only (amendment doesn't touch school)
  village_only_millage: 2.9794, // Village of Key Biscayne operating
  exemption_presets: [150000, 250000], // ballot amounts
  published_kb_taxable_2025: 11_600_000_000,
};

// ---- FL DOR land-use code -> property class ----
function classify(dorCode) {
  const c = String(dorCode || "").padStart(4, "0");
  if (c === "0000") return "Reference Folio";
  const d = Number(c.slice(0, 2));
  if (c === "0101" || d === 1) return "Single Family";
  if (d === 4) return "Condominium";
  if (d === 5) return "Cooperative";
  if (d === 3 || d === 8) return "Multifamily";
  if (d === 0) return "Vacant Residential";
  if (d === 2 || d === 6 || d === 7) return "Other Residential";
  if (d >= 10 && d <= 39) return "Commercial";
  if (d >= 40 && d <= 49) return "Industrial";
  if (d >= 70 && d <= 79) return "Institutional";
  if (d >= 80 && d <= 89) return "Government";
  return "Other";
}

const parcels = JSON.parse(readFileSync(join(RAW, "parcels.json"), "utf8"));
const roll = JSON.parse(readFileSync(join(RAW, "roll.json"), "utf8"));
const rollByFolio = new Map(roll.map((r) => [r.folio, r]));

const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
let missingRoll = 0;
const modeled = [];
for (const p of parcels) {
  const folio = String(p.FOLIO);
  const r = rollByFolio.get(folio);
  if (!r || !r.ok) { missingRoll++; continue; } // drop invalid; keeps data.js lean
  const dorCode = r.dor_code || p.DOR_CODE_CUR;
  modeled.push({
    folio,
    zip: p.zip || String(p.TRUE_SITE_ZIP_CODE || "").slice(0, 5) || null,
    addr: p.TRUE_SITE_ADDR || null,
    muni: r.municipality || p.TRUE_SITE_CITY || null,
    dorCode, cls: classify(dorCode),
    homestead: r.homestead ? 1 : 0,
    taxable: num(r.county_taxable),
    justVal: num(r.just_value),
    assessedVal: num(r.assessed_value),
    exemption: num(r.county_exemption),
  });
}

const zips = [...new Set(modeled.map((r) => r.zip).filter(Boolean))].sort();

// ---- scenario engine ----
const taxOf = (taxable, mil) => taxable * (mil / 1000);
function scenarioTax(row, millage, exemption, mode) {
  const base = row.taxable;
  if (!row.homestead) return taxOf(base, millage);
  if (mode === "full") return 0;
  return taxOf(Math.max(0, base - exemption), millage);
}
function summarize(rows, millage) {
  // Amendment 3 scenarios (Nov 2026 ballot) — $25K school exemption stays.
  const scenarios = [
    { key: "baseline", label: "Baseline (current $25K/$50K homestead)", mode: "exempt", exemption: 0 },
    { key: "y2027", label: "2027 · $150K homestead exemption", mode: "exempt", exemption: 150000 },
    { key: "y2028", label: "2028+ · $250K homestead exemption", mode: "exempt", exemption: 250000 },
  ];
  const base = rows.reduce((s, r) => s + taxOf(r.taxable, millage), 0);
  const out = {};
  for (const sc of scenarios) {
    let rev = 0, freed = 0;
    for (const r of rows) {
      const t = scenarioTax(r, millage, sc.exemption, sc.mode);
      rev += t;
      if (r.homestead && t === 0 && r.taxable > 0) freed++;
    }
    out[sc.key] = {
      label: sc.label,
      revenue: Math.round(rev),
      revenue_lost: Math.round(base - rev),
      pct_base_eroded: base > 0 ? (base - rev) / base : 0,
      parcels_fully_tax_free: freed,
    };
  }
  return out;
}

const valid = modeled; // invalid rows are dropped upstream now
const homesteads = valid.filter((r) => r.homestead);
const kbOnly = valid.filter((r) => (r.muni || "").toLowerCase().includes("key biscayne"));
const sum = (a, f) => a.reduce((s, r) => s + f(r), 0);

const byClass = {};
for (const r of modeled) {
  (byClass[r.cls] ||= { class: r.cls, count: 0, homestead_count: 0, taxable: 0 });
  byClass[r.cls].count++;
  if (r.homestead) byClass[r.cls].homestead_count++;
  byClass[r.cls].taxable += r.taxable;
}
const byMuni = {};
for (const r of valid) {
  const k = r.muni || "(unknown)";
  (byMuni[k] ||= { muni: k, count: 0, taxable: 0, homestead_count: 0 });
  byMuni[k].count++;
  byMuni[k].taxable += r.taxable;
  if (r.homestead) byMuni[k].homestead_count++;
}
// per-municipality FULL aggregate with scenarios (for the splash "By municipality" map view)
const byMuniFull = {};
const uniqueMunis = [...new Set(valid.map((r) => r.muni || "(unknown)"))].sort();
for (const m of uniqueMunis) {
  const rowsM = valid.filter((r) => (r.muni || "(unknown)") === m);
  byMuniFull[m] = {
    muni: m,
    count: rowsM.length,
    homestead: rowsM.filter((r) => r.homestead).length,
    taxable: Math.round(sum(rowsM, (r) => r.taxable)),
    zips: [...new Set(rowsM.map((r) => r.zip).filter(Boolean))].sort(),
    scenarios: summarize(rowsM, DEFAULTS.millage),
  };
}
const byZip = {};
for (const z of zips) {
  const rowsZ = valid.filter((r) => r.zip === z);
  // dominant municipality by parcel count (used to color a ZIP polygon by its taxing city)
  const muniCounts = {};
  for (const r of rowsZ) { const m = r.muni || "(unknown)"; muniCounts[m] = (muniCounts[m] || 0) + 1; }
  const dominant = Object.entries(muniCounts).sort((a, b) => b[1] - a[1])[0];
  byZip[z] = {
    zip: z,
    count: rowsZ.length,
    homestead: rowsZ.filter((r) => r.homestead).length,
    taxable: Math.round(sum(rowsZ, (r) => r.taxable)),
    municipalities: [...new Set(rowsZ.map((r) => r.muni).filter(Boolean))].sort(),
    dominant_muni: dominant ? dominant[0] : null,
    dominant_share: dominant ? dominant[1] / rowsZ.length : 0,
    scenarios: summarize(rowsZ, DEFAULTS.millage),
  };
}

const summary = {
  generated_at: new Date().toISOString(),
  defaults: DEFAULTS,
  roll_year: (roll.find((r) => r.ok) || {}).roll_year || null,
  zips,
  counts: {
    parcels: modeled.length,
    valid_roll: valid.length,
    missing_roll: missingRoll,
    homestead: homesteads.length,
    non_homestead: valid.length - homesteads.length,
    key_biscayne_parcels: kbOnly.length,
  },
  taxable_totals: {
    all: Math.round(sum(valid, (r) => r.taxable)),
    homestead: Math.round(sum(homesteads, (r) => r.taxable)),
    non_homestead: Math.round(sum(valid.filter((r) => !r.homestead), (r) => r.taxable)),
    key_biscayne_only: Math.round(sum(kbOnly, (r) => r.taxable)),
  },
  validation: {
    published_kb_taxable_2025: DEFAULTS.published_kb_taxable_2025,
    computed_kb_taxable: Math.round(sum(kbOnly, (r) => r.taxable)),
    note: "Computed KB-municipality taxable should land near the published $11.6B record base.",
  },
  by_class: Object.values(byClass).sort((a, b) => b.taxable - a.taxable),
  by_municipality: Object.values(byMuni).sort((a, b) => b.taxable - a.taxable),
  by_muni: byMuniFull, // full per-muni aggregate with scenarios (splash map "By municipality" view)
  by_zip: byZip,
  scenarios_at_default_millage: summarize(valid, DEFAULTS.millage),
};

writeFileSync(join(DERIVED, "parcels_modeled.json"), JSON.stringify(modeled));
writeFileSync(join(DERIVED, "summary.json"), JSON.stringify(summary, null, 2));

const csvCols = ["folio", "zip", "addr", "muni", "dorCode", "cls", "homestead", "taxable", "assessedVal", "justVal", "exemption"];
const esc = (v) => { if (v === null || v === undefined) return ""; const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
writeFileSync(join(DERIVED, "parcels_modeled.csv"),
  [csvCols.join(","), ...modeled.map((r) => csvCols.map((c) => esc(r[c])).join(","))].join("\r\n"));

mkdirSync(join(ROOT, "dashboard"), { recursive: true });
writeFileSync(join(ROOT, "dashboard", "data.js"),
  `// Generated by pipeline/03_build_model.mjs — do not edit by hand.\n` +
  `window.__SUMMARY__ = ${JSON.stringify(summary)};\n` +
  `window.__PARCELS__ = ${JSON.stringify(modeled)};\n`);
writeFileSync(join(ROOT, "dashboard", "summary.js"),
  `// Generated by pipeline/03_build_model.mjs — summary only (splash page).\n` +
  `window.__SUMMARY__ = ${JSON.stringify(summary)};\n`);

const f$ = (n) => "$" + Math.round(n).toLocaleString();
console.log(`\n=== MODEL BUILT (roll year ${summary.roll_year}) ===`);
console.log(`ZIPs: ${zips.join(", ")}`);
console.log(`Parcels: ${summary.counts.parcels} | valid roll: ${summary.counts.valid_roll} | missing: ${summary.counts.missing_roll}`);
console.log(`Homestead: ${summary.counts.homestead} | Non-homestead: ${summary.counts.non_homestead}`);
for (const z of zips) {
  const b = byZip[z];
  console.log(`  [${z}] ${b.count} parcels, ${b.homestead} HS, taxable ${f$(b.taxable)} (${b.municipalities.slice(0, 4).join(", ")}${b.municipalities.length > 4 ? "…" : ""})`);
}
console.log(`\nTaxable (all): ${f$(summary.taxable_totals.all)} | KB-only: ${f$(summary.taxable_totals.key_biscayne_only)} (published ~$11.6B)`);
console.log(`\nScenarios @ ${DEFAULTS.millage} mills (across all selected zips):`);
for (const [k, s] of Object.entries(summary.scenarios_at_default_millage)) {
  console.log(`  ${s.label.padEnd(32)} rev ${f$(s.revenue).padStart(16)}  lost ${f$(s.revenue_lost).padStart(14)}  (${(s.pct_base_eroded * 100).toFixed(1)}% eroded, ${s.parcels_fully_tax_free} freed)`);
}
