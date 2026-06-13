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
