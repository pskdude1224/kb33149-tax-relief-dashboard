// Step 3 — Join parcels (Step 1) + roll (Step 2), classify, and build the
// modeled dataset the dashboard consumes. Also computes a default-scenario
// summary + validation against the published Key Biscayne taxable base.
//
// Scenario math (the dashboard recomputes this live as sliders move; we mirror
// it here for the summary):
//   taxable base used  = non-school local taxable value (county_taxable)
//   baseline tax       = taxable * millage/1000
//   $E homestead exempt = homestead ? max(0, taxable - E) * millage/1000
//                                   : taxable * millage/1000   (unchanged)
//   full elimination    = homestead ? 0 : taxable * millage/1000
//   Non-homestead (commercial + non-homestead residential) NEVER changes.
//
// Run: node pipeline/03_build_model.mjs

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const DERIVED = join(ROOT, "data", "derived");
mkdirSync(DERIVED, { recursive: true });

// ---- defaults (editable in the dashboard) ----
const DEFAULTS = {
  millage: 15.6226, // combined Village of Key Biscayne + Miami-Dade + School + districts (2025)
  village_only_millage: 2.9794, // Village of Key Biscayne operating, for reference
  exemption_presets: [250000, 500000],
  published_kb_taxable_2025: 11_600_000_000, // KB Independent: $11.6B record taxable base
};

// ---- DOR land-use code -> property class (FL DOR first-2-digit standard) ----
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

const parcels = JSON.parse(readFileSync(join(RAW, "parcels_33149_raw.json"), "utf8"));
const roll = JSON.parse(readFileSync(join(RAW, "roll_33149.json"), "utf8"));
const rollByFolio = new Map(roll.map((r) => [r.folio, r]));

const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

let missingRoll = 0;
const modeled = parcels.map((p) => {
  const folio = String(p.FOLIO);
  const r = rollByFolio.get(folio);
  if (!r || !r.ok) missingRoll++;
  const dorCode = (r && r.dor_code) || p.DOR_CODE_CUR;
  const dorDesc = (r && r.dor_desc) || p.DOR_DESC;
  return {
    folio,
    addr: p.TRUE_SITE_ADDR || null,
    muni: (r && r.municipality) || p.TRUE_SITE_CITY || null,
    dorCode,
    dorDesc,
    cls: classify(dorCode),
    homestead: r && r.homestead ? 1 : 0,
    taxable: r ? num(r.county_taxable) : 0, // model base (non-school local)
    schoolTaxable: r ? num(r.school_taxable) : 0,
    justVal: r ? num(r.just_value) : 0,
    assessedVal: r ? num(r.assessed_value) : 0,
    exemption: r ? num(r.county_exemption) : 0,
    rollYear: r ? r.roll_year : null,
    valid: !!(r && r.ok),
  };
});

// ---- scenario engine (shared shape with the dashboard) ----
function tax(taxable, millage) {
  return taxable * (millage / 1000);
}
function scenarioTax(row, millage, exemption, mode) {
  const base = row.taxable;
  if (!row.homestead) return tax(base, millage); // unchanged
  if (mode === "full") return 0;
  return tax(Math.max(0, base - exemption), millage);
}

function summarize(millage) {
  const scenarios = [
    { key: "baseline", label: "Baseline (current)", mode: "exempt", exemption: 0 },
    { key: "e250", label: "$250K homestead exemption", mode: "exempt", exemption: 250000 },
    { key: "e500", label: "$500K homestead exemption", mode: "exempt", exemption: 500000 },
    { key: "full", label: "Full elimination (homestead)", mode: "full", exemption: 0 },
  ];
  const base = modeled.reduce((s, r) => s + tax(r.taxable, millage), 0);
  const out = {};
  for (const sc of scenarios) {
    let rev = 0,
      freed = 0;
    for (const r of modeled) {
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

// ---- aggregates ----
const valid = modeled.filter((r) => r.valid);
const homesteads = valid.filter((r) => r.homestead);
const kbOnly = valid.filter((r) => (r.muni || "").toLowerCase().includes("key biscayne"));
const sum = (a, f) => a.reduce((s, r) => s + f(r), 0);

const byClass = {};
for (const r of modeled) {
  const k = r.cls;
  (byClass[k] ||= { class: k, count: 0, homestead_count: 0, taxable: 0 });
  byClass[k].count++;
  if (r.homestead) byClass[k].homestead_count++;
  byClass[k].taxable += r.taxable;
}

const byMuni = {};
for (const r of valid) {
  const k = r.muni || "(unknown)";
  (byMuni[k] ||= { muni: k, count: 0, taxable: 0 });
  byMuni[k].count++;
  byMuni[k].taxable += r.taxable;
}

const summary = {
  generated_at: new Date().toISOString(),
  defaults: DEFAULTS,
  roll_year: (roll.find((r) => r.ok) || {}).roll_year || null,
  counts: {
    parcels: modeled.length,
    valid_roll: valid.length,
    missing_roll: missingRoll,
    homestead: homesteads.length,
    non_homestead: valid.length - homesteads.length,
    key_biscayne_parcels: kbOnly.length,
  },
  taxable_totals: {
    all_33149: Math.round(sum(valid, (r) => r.taxable)),
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
  scenarios_at_default_millage: summarize(DEFAULTS.millage),
};

// ---- write derived data ----
writeFileSync(join(DERIVED, "parcels_modeled.json"), JSON.stringify(modeled));
writeFileSync(join(DERIVED, "summary.json"), JSON.stringify(summary, null, 2));

const csvCols = ["folio", "addr", "muni", "dorCode", "dorDesc", "cls", "homestead", "taxable", "assessedVal", "justVal", "exemption", "rollYear", "valid"];
const esc = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
writeFileSync(
  join(DERIVED, "parcels_modeled.csv"),
  [csvCols.join(","), ...modeled.map((r) => csvCols.map((c) => esc(r[c])).join(","))].join("\r\n")
);

// ---- inline data for the dashboard (open index.html with no server) ----
mkdirSync(join(ROOT, "dashboard"), { recursive: true });
writeFileSync(
  join(ROOT, "dashboard", "data.js"),
  `// Generated by pipeline/03_build_model.mjs — do not edit by hand.\n` +
    `window.__SUMMARY__ = ${JSON.stringify(summary)};\n` +
    `window.__PARCELS__ = ${JSON.stringify(modeled)};\n`
);

// ---- console report ----
const f$ = (n) => "$" + Math.round(n).toLocaleString();
console.log(`\n=== MODEL BUILT (roll year ${summary.roll_year}) ===`);
console.log(`Parcels: ${summary.counts.parcels} | valid roll: ${summary.counts.valid_roll} | missing: ${summary.counts.missing_roll}`);
console.log(`Homestead: ${summary.counts.homestead} | Non-homestead: ${summary.counts.non_homestead}`);
console.log(`KB-municipality parcels: ${summary.counts.key_biscayne_parcels}`);
console.log(`\nTaxable base (non-school local):`);
console.log(`  All 33149:        ${f$(summary.taxable_totals.all_33149)}`);
console.log(`  KB municipality:  ${f$(summary.taxable_totals.key_biscayne_only)}  (published ~$11.6B)`);
console.log(`  Homestead:        ${f$(summary.taxable_totals.homestead)}`);
console.log(`  Non-homestead:    ${f$(summary.taxable_totals.non_homestead)}`);
console.log(`\nScenarios @ ${DEFAULTS.millage} mills (all 33149):`);
for (const [k, s] of Object.entries(summary.scenarios_at_default_millage)) {
  console.log(`  ${s.label.padEnd(32)} rev ${f$(s.revenue).padStart(16)}  lost ${f$(s.revenue_lost).padStart(14)}  (${(s.pct_base_eroded * 100).toFixed(1)}% eroded, ${s.parcels_fully_tax_free} tax-free)`);
}
console.log(`\nWrote data/derived/{parcels_modeled.json,summary.json,parcels_modeled.csv} + dashboard/data.js`);
