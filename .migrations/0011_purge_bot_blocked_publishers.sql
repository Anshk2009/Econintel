-- ============================================================================
-- EconIntel — 0011: remove content collected from publishers that refuse bots
-- ============================================================================
-- WHY THIS EXISTS
--   Until 2026-08-23 the RSS ingester sent a spoofed Chrome User-Agent. Four
--   feeds — PIB India, Moneycontrol (economy + business) and Business Standard —
--   answer 403 to a self-identifying crawler and 200 only to that disguise, so
--   every row from them was collected by working around a refusal.
--
--   Those feeds are gone from .rag/feeds.json and FEED_HEADERS now names the bot
--   honestly. Both of those changes stop the FUTURE. Neither touches the ~12k
--   rows already stored, and "we stopped doing it" is not the same claim as "we
--   are not holding it". This file is the second half.
--
-- WHY NOT JUST WAIT FOR prune()
--   .rag/sources/_lib.mjs prunes churn categories after 90 days, so these rows
--   would eventually age out on their own — but only the ones carrying a
--   published_at, and only over three months. An erasure that depends on a
--   retention job is not an erasure.
--
-- HOW TO RUN
--   Supabase dashboard -> SQL Editor -> paste -> Run. Safe to re-run (a second
--   run deletes 0 rows). Nothing else references documents.id, so no cascade.
--
-- AFTER RUNNING
--   The corpus shrinks. Confirm retrieval still clears its bar before assuming
--   that is fine:  cd .rag && node check-retrieval.mjs
--   The golden set is anchored on case studies and open data, not on commercial
--   press, so it should be unaffected — but check rather than assume.
-- ============================================================================

-- Count first, so the log records what was there. Run this on its own if you
-- want the number before committing to the delete.
select source_name, count(*) as rows_held
from documents
where source_name in ('PIB India', 'Moneycontrol Economy', 'Moneycontrol Business', 'Business Standard')
group by source_name
order by rows_held desc;

-- The delete itself.
delete from documents
where source_name in ('PIB India', 'Moneycontrol Economy', 'Moneycontrol Business', 'Business Standard');

-- Verify: expect 0 rows.
select count(*) as should_be_zero
from documents
where source_name in ('PIB India', 'Moneycontrol Economy', 'Moneycontrol Business', 'Business Standard');
