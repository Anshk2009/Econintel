# EconIntel — Source Catalog

The full list of sources EconIntel trusts and pulls from, grouped by type.
RSS URLs are the ones the live ingester polls (mirrored in `feeds.json`).

> ⚠️ **Verify each RSS URL before relying on it** — outlets move or retire feeds.
> Open the URL in a browser; if you see XML, it works.

---

## A. Core news (your current trusted sources)

| Source | Site | RSS feed |
|--------|------|----------|
| BBC Business | bbc.com/news/business | http://feeds.bbci.co.uk/news/business/rss.xml |
| BBC World | bbc.com/news/world | http://feeds.bbci.co.uk/news/world/rss.xml |
| The Hindu — Business | thehindu.com/business | https://www.thehindu.com/business/feeder/default.rss |
| Al Jazeera | aljazeera.com/economy | https://www.aljazeera.com/xml/rss/all.xml |

## B. Institutions & primary sources (highest trust — analysis + data)

| Source | Site | RSS / notes |
|--------|------|-------------|
| IMF | imf.org | https://www.imf.org/en/News/RSS?Language=ENG |
| World Bank | worldbank.org | https://www.worldbank.org/en/news/all?format=rss |
| US Federal Reserve | federalreserve.gov | https://www.federalreserve.gov/feeds/press_all.xml |
| OECD | oecd.org | https://www.oecd.org/newsroom/ (check for RSS) |
| WTO | wto.org | News page — RSS limited |
| Reserve Bank of India (RBI) | rbi.org.in | Press releases — key for India focus |

## C. India market (your core market)

| Source | Site | RSS / notes |
|--------|------|-------------|
| LiveMint | livemint.com | https://www.livemint.com/rss/economy |
| Business Standard | business-standard.com | https://www.business-standard.com/rss/economy-policy-103.rss |
| The Economic Times | economictimes.indiatimes.com | https://economictimes.indiatimes.com/rssfeedstopstories.cms |
| Press Information Bureau | pib.gov.in | Government announcements |

## D. Markets, data & geopolitics analysis

| Source | Site | Notes |
|--------|------|-------|
| Reuters | reuters.com | Public RSS is unreliable now — may need scraping/API |
| Trading Economics | tradingeconomics.com | Macro data (GDP, inflation, rates) |
| Project Syndicate | project-syndicate.org | Economist/geopolitics op-eds |
| The Economist | economist.com | Paywalled — limited RSS |
| Financial Times | ft.com | Paywalled |
| Geopolitical Futures | geopoliticalfutures.com | Your aspirational competitor — reference only, paywalled |

---

## E. Case studies (historical analogues — seed once from real sources)

Your product maps current events to historical analogues, so seed these
canonical events as documents. They are real events — pull the actual text from
the linked primary sources (IMF/World Bank/Fed/Wikipedia). Details and the
URLs to pull from are in `documents/case-studies-to-seed.md`.

- 2008 Global Financial Crisis
- 1997 Asian Financial Crisis
- 1991 India Balance-of-Payments crisis
- 1971 Nixon Shock (end of the gold standard)
- 2010–2012 Eurozone sovereign debt crisis
- 1923 Weimar hyperinflation
- 2020 COVID-19 economic shock
- 2022 Russia sanctions & energy shock
- 1985 Plaza Accord
- 1979–82 Volcker disinflation
- Japan's "Lost Decade" (1990s)
- 2018 Turkey & Argentina currency crises

---

## F. Citeable open-data / primary sources (PIPELINE-ONLY — never shown on the site)

> These are the sources allowed to be **cited to users** (they become
> `publishable = true`). Everything else in the library (commercial news) is
> retrieval-only BACKGROUND and is **never cited**. This list lives only in the
> pipeline — it is never listed or mentioned anywhere on the website/frontend,
> and the chat only emits a citation inline when a user explicitly asks.
>
> Two ingestion paths, because most of these are **data APIs, not RSS**:

**RSS / press-release feeds** — add to `feeds.json` with `"citeable": true`
(verify each URL returns XML first; the existing RSS ingester handles them):
- World Bank, OECD, Our World in Data, BLS, BEA, EIA (Today in Energy),
  WHO (news), NOAA, USGS, SEC EDGAR (latest-filings Atom feeds)
- Already wired and citeable: **IMF News**, **US Federal Reserve**

**Data APIs** — need a small dedicated ingester each (fetch indicator/dataset
metadata + a citeable URL, embed that as the "document"; not articles):
- World Bank Open Data, FRED, BEA/BLS/EIA data APIs, Eurostat, UNData,
  UN Comtrade, FAOSTAT, Data.gov, Data.gov.uk, OGD India (data.gov.in),
  NASA EarthData, WHO GHO (OData), Wikidata (SPARQL), GDELT, OpenStreetMap

How citeable gating works end to end:
1. `feeds.json` `"citeable": true`  ->  ingester writes `publishable = true`
2. `match_documents` returns `publishable`
3. chat.js puts publishable=true chunks in a CITEABLE block (may cite when asked)
   and everything else in a BACKGROUND block (used to answer, never cited)
