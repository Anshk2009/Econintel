// rag/ingest-data.mjs — runner for the open-data ingesters (World Bank, SEC
// EDGAR, FRED, OGD India). Writes CITEABLE (publishable=true) documents.
//
// Run with:  node ingest-data.mjs
// Required env: NVIDIA_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY
// Optional env: FRED_API_KEY, DATA_GOV_IN_KEY, INGEST_CONTACT
//
// Resilient: a source that errors (e.g. missing API key) is skipped and the
// others still run. The run only fails (exit 1) if EVERY source errored.
import { requireEnv, prune } from './sources/_lib.mjs';
import { ingestWorldBank } from './sources/worldbank.mjs';
import { ingestEdgar } from './sources/edgar.mjs';
import { ingestFred } from './sources/fred.mjs';
import { ingestOgdIndia } from './sources/ogd-india.mjs';

async function main() {
  // These three are needed by EVERY source (embeddings + Supabase). Fail loud if
  // missing so we don't "succeed" having written nothing.
  requireEnv(['NVIDIA_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']);

  const sources = [
    ['World Bank', ingestWorldBank], // no key
    ['SEC EDGAR',  ingestEdgar],     // no key (needs User-Agent / INGEST_CONTACT)
    ['FRED',       ingestFred],      // needs FRED_API_KEY
    ['OGD India',  ingestOgdIndia],  // needs DATA_GOV_IN_KEY + configured resource IDs
  ];

  let totalAdded = 0, ranOK = 0, errored = 0;
  for (const [name, fn] of sources) {
    try {
      const { added } = await fn();
      totalAdded += added;
      ranOK++;
    } catch (e) {
      // e.g. a missing API key — skip this source, keep going.
      errored++;
      console.warn(`${name} skipped: ${e.message}`);
    }
  }

  // Retention runs here, on the DAILY job, not on the 3-hourly news cron —
  // once a day is plenty to hold a size ceiling, and it keeps the hot path
  // (ingest-live) to fetching and embedding. Best-effort: never fails the run.
  await prune();

  console.log(`ingest-data done. total added ${totalAdded}, sources ran ${ranOK}, errored ${errored}`);
  // Only a hard failure (nothing ran at all) should mark the run red. A source
  // skipping for a missing key, or adding 0 new rows, is normal and stays green.
  if (ranOK === 0) {
    console.error('Every data source errored — failing the run so it is visible.');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
