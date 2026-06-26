// rag/sources/fred.mjs — FRED, Federal Reserve Bank of St. Louis.
// Needs a free API key in FRED_API_KEY (https://fred.stlouisfed.org/docs/api/api_key.html).
// Stores a curated set of key US/macro series as short, citeable time-series docs.
import { fetchWithTimeout, upsertDoc, requireEnv } from './_lib.mjs';

const FRED_API_KEY = process.env.FRED_API_KEY;

// Curated series. Extend with whatever your charts/analogues lean on.
const SERIES = [
  { id: 'GDPC1',    label: 'US Real GDP (chained 2017 $, SAAR)' },
  { id: 'CPIAUCSL', label: 'US CPI (all urban consumers, index)' },
  { id: 'UNRATE',   label: 'US Unemployment Rate (%)' },
  { id: 'FEDFUNDS', label: 'US Effective Federal Funds Rate (%)' },
  { id: 'DGS10',    label: 'US 10-Year Treasury Yield (%)' },
  { id: 'DGS2',     label: 'US 2-Year Treasury Yield (%)' },
  { id: 'T10Y2Y',   label: 'US 10Y-2Y Treasury Spread (%)' },
  { id: 'M2SL',     label: 'US M2 Money Stock' },
  { id: 'DEXINUS',  label: 'India / US Foreign Exchange Rate (INR per USD)' },
];

export async function ingestFred() {
  requireEnv(['FRED_API_KEY']); // throws → runner logs "FRED skipped: Missing env var(s)…"
  let added = 0, failed = 0;
  for (const s of SERIES) {
    try {
      // Newest 8 observations (descending), then we reverse to oldest→newest.
      const url = `https://api.stlouisfed.org/fred/series/observations`
        + `?series_id=${encodeURIComponent(s.id)}&api_key=${FRED_API_KEY}`
        + `&file_type=json&sort_order=desc&limit=8`;
      const r = await fetchWithTimeout(url);
      if (!r.ok) { failed++; console.warn(`  FRED ${s.id}: ${r.status}`); continue; }
      const d = await r.json();
      const obs = (d.observations || []).filter(o => o.value !== '.').reverse(); // '.' = missing in FRED
      if (!obs.length) continue;

      const series = obs.map(o => `${o.date}: ${o.value}`).join(', ');
      const content = `${s.label} — FRED series ${s.id}. Recent values: ${series}.`;
      const source_url = `https://fred.stlouisfed.org/series/${s.id}`;
      await upsertDoc({ content, source_name: 'FRED (St. Louis Fed)', source_url, category: 'data' });
      added++;
    } catch (e) {
      failed++;
      console.warn(`  FRED ${s.id} failed: ${e.message}`);
    }
  }
  console.log(`FRED: added ${added}, failed ${failed}`);
  return { added, failed };
}
