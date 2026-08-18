// rag/sources/worldbank.mjs — World Bank Open Data (CC BY 4.0, no API key).
// Pulls a curated set of macro indicators for key economies and stores each as a
// short, citeable time-series document the chat can retrieve for analogue/chart talk.
import { fetchWithTimeout, upsertDoc } from './_lib.mjs';

// Curated indicators. Every row this writes is publishable=true — World Bank
// Open Data is CC BY 4.0, so these are corpus we may both cite AND republish,
// which is exactly the material the product claims to be grounded in.
// Widened 2026-08-18 (7 -> 12) to cover the questions the chat actually gets:
// currency/reserves, external debt, and investment, not just growth and prices.
// Cost note: upsertDoc() now skips the embedding call when a series is
// unchanged, and these are annual series — so after the first seed this whole
// job costs close to zero embedding requests no matter how long the lists get.
const INDICATORS = [
  { id: 'NY.GDP.MKTP.CD',    label: 'GDP (current US$)' },
  { id: 'NY.GDP.MKTP.KD.ZG', label: 'GDP growth (annual %)' },
  { id: 'NY.GDP.PCAP.CD',    label: 'GDP per capita (current US$)' },
  { id: 'FP.CPI.TOTL.ZG',    label: 'Inflation, consumer prices (annual %)' },
  { id: 'FR.INR.RINR',       label: 'Real interest rate (%)' },
  { id: 'SL.UEM.TOTL.ZS',    label: 'Unemployment (% of labour force)' },
  { id: 'GC.DOD.TOTL.GD.ZS', label: 'Central government debt (% of GDP)' },
  { id: 'NE.EXP.GNFS.ZS',    label: 'Exports of goods & services (% of GDP)' },
  { id: 'NE.IMP.GNFS.ZS',    label: 'Imports of goods & services (% of GDP)' },
  { id: 'BN.CAB.XOKA.GD.ZS', label: 'Current account balance (% of GDP)' },
  { id: 'FI.RES.TOTL.MO',    label: 'Total reserves (months of imports)' },
  { id: 'BX.KLT.DINV.WD.GD.ZS', label: 'Foreign direct investment, net inflows (% of GDP)' },
];
// World Bank country codes (ISO2 + aggregates). Widened to the economies this
// audience actually asks about — India's trade partners, the Gulf, ASEAN and
// the South Asian neighbours — not just the G7.
const COUNTRIES = [
  'WLD', 'IN', 'US', 'CN', 'JP', 'DE', 'GB', 'FR',
  'BR', 'RU', 'ZA', 'KR', 'ID', 'SA', 'AE', 'BD',
];

export async function ingestWorldBank() {
  let added = 0, failed = 0;
  for (const c of COUNTRIES) {
    for (const ind of INDICATORS) {
      try {
        // mrv=5 → the 5 most recent values for this indicator/country.
        const url = `https://api.worldbank.org/v2/country/${c}/indicator/${ind.id}?format=json&mrv=5`;
        const r = await fetchWithTimeout(url);
        if (!r.ok) { failed++; continue; }
        const data = await r.json();
        const rows = Array.isArray(data) ? data[1] : null;       // [meta, rows]
        if (!Array.isArray(rows) || !rows.length) continue;

        const country = rows[0].country?.value || c;
        // oldest → newest, skipping null values
        const series = rows
          .filter(x => x.value != null)
          .map(x => `${x.date}: ${x.value}`)
          .reverse()
          .join(', ');
        if (!series) continue;

        const content = `${country} — ${ind.label} (World Bank, indicator ${ind.id}). Recent values: ${series}.`;
        const iso2 = rows[0].country?.id || c;
        const source_url = `https://data.worldbank.org/indicator/${ind.id}?locations=${iso2}`;
        await upsertDoc({ content, source_name: 'World Bank Open Data', source_url, category: 'data' });
        added++;
      } catch (e) {
        failed++;
        console.warn(`  WorldBank ${c}/${ind.id} failed: ${e.message}`);
      }
    }
  }
  console.log(`World Bank: added ${added}, failed ${failed}`);
  return { added, failed };
}
