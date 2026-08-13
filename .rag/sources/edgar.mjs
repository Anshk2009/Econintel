// rag/sources/edgar.mjs — U.S. SEC EDGAR latest filings (public domain).
// SEC requires a descriptive User-Agent with contact info (set INGEST_CONTACT).
// Stores recent filings (company + form + link) as short, citeable docs.
import { fetchWithTimeout, upsertDoc, CONTACT } from './_lib.mjs';

const FORM_TYPES = ['10-K', '10-Q', '8-K']; // annual, quarterly, material-event
const PER_TYPE = 15;                          // newest N filings of each type

// Pull the <entry> blocks out of EDGAR's Atom feed.
function parseAtom(xml) {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  return entries.map(e => ({
    title:   (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.trim() || '',
    href:    (e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '',
    updated: (e.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1]?.trim() || '',
  }));
}

export async function ingestEdgar() {
  let added = 0, failed = 0;
  for (const type of FORM_TYPES) {
    let entries;
    try {
      const url = `https://www.sec.gov/cgi-bin/browse-edgar`
        + `?action=getcurrent&type=${encodeURIComponent(type)}&count=${PER_TYPE}&output=atom`;
      // User-Agent is mandatory for SEC — requests without it get blocked.
      const r = await fetchWithTimeout(url, { headers: { 'User-Agent': CONTACT } });
      if (!r.ok) { failed++; console.warn(`  EDGAR ${type}: ${r.status}`); continue; }
      entries = parseAtom(await r.text());
    } catch (e) {
      console.warn(`  EDGAR ${type} fetch failed: ${e.message}`);
      continue;
    }

    for (const en of entries) {
      if (!en.href || !en.title) continue;
      try {
        // Title looks like: "8-K - Apollo Infrastructure Co LLC (0001971381) (Filer)"
        const content = `SEC EDGAR filing: ${en.title}.`;
        const published_at = en.updated ? new Date(en.updated).toISOString() : null;
        await upsertDoc({ content, source_name: 'SEC EDGAR', source_url: en.href, category: 'filing', published_at });
        added++;
      } catch (e) {
        failed++;
        console.warn(`  EDGAR item failed: ${e.message}`);
      }
    }
  }
  console.log(`SEC EDGAR: added ${added}, failed ${failed}`);
  return { added, failed };
}
