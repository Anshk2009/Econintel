// rag/sources/ogd-india.mjs — Open Government Data Platform India (data.gov.in).
// Licence: Government Open Data Licence – India (GODL), attribution required.
// Needs a free API key in DATA_GOV_IN_KEY (register at data.gov.in).
//
// data.gov.in exposes each dataset as a "resource" with a UUID. You must add the
// resource IDs you want below — there is no generic "latest economics" feed, and
// I won't invent UUIDs. Find them on the dataset page → API tab on data.gov.in.
import { fetchWithTimeout, upsertDoc, requireEnv } from './_lib.mjs';

const KEY = process.env.DATA_GOV_IN_KEY;

// ⚠️ CONFIGURE: add real resource UUIDs from data.gov.in. Each becomes one
// citeable document summarising that dataset's latest records.
const RESOURCES = [
  // { id: '<resource-uuid>', label: 'CPI (Rural/Urban/Combined), monthly' },
  // { id: '<resource-uuid>', label: 'WPI, monthly' },
  // { id: '<resource-uuid>', label: 'India foreign exchange reserves, weekly' },
];

export async function ingestOgdIndia() {
  requireEnv(['DATA_GOV_IN_KEY']); // throws → runner logs "OGD India skipped: …"
  if (!RESOURCES.length) {
    console.log('OGD India: no resource IDs configured yet — skipping (add UUIDs in ogd-india.mjs).');
    return { added: 0, failed: 0 };
  }

  let added = 0, failed = 0;
  for (const res of RESOURCES) {
    try {
      const url = `https://api.data.gov.in/resource/${res.id}`
        + `?api-key=${KEY}&format=json&limit=20`;
      const r = await fetchWithTimeout(url);
      if (!r.ok) { failed++; console.warn(`  OGD ${res.id}: ${r.status}`); continue; }
      const d = await r.json();
      const records = d.records || [];
      if (!records.length) continue;

      // Compact summary of the most recent records (pipe-joined field values).
      const sample = records.slice(0, 10)
        .map(rec => Object.values(rec).join(' | '))
        .join('\n');
      const content = `${res.label || d.title || 'India open data'} (data.gov.in). Latest records:\n${sample}`;
      const source_url = `https://www.data.gov.in/resource/${res.id}`;
      await upsertDoc({ content, source_name: 'Open Government Data (India)', source_url, category: 'data' });
      added++;
    } catch (e) {
      failed++;
      console.warn(`  OGD India ${res.id} failed: ${e.message}`);
    }
  }
  console.log(`OGD India: added ${added}, failed ${failed}`);
  return { added, failed };
}
