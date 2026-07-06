# RAG retrieval eval

8 econ/geopolitics test queries (`queries.json`) mapped to the case-study docs
that should answer them (`ground_truth.json`, filenames without `.md`).

Baseline (2026-07-06, TF-IDF proxy over 7 case studies):
Recall@5 62.5% | MRR 0.279 | Precision@1 12.5%

Re-run after growing the corpus or changing retrieval. Add a query + ground-truth
entry for every new case study. Targets: precision@5 >= 0.8, recall@10 >= 0.85.
