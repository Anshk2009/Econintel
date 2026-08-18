# Fine-tuning EconIntel — what it can and cannot buy

Dot-prefixed directory, so EdgeOne never serves this. Written 2026-08-18, for
"train the model once the inference key is sorted".

## Read this part before spending anything

**Fine-tuning does not teach facts. It teaches form.** A tuned model does not
learn that India's CPI print was 4.1% — it learns to *sound* like something that
knows. On a product whose whole claim is source-grounding, tuning on facts makes
the failure mode worse, not better: the model gets more fluent and more
confident about material it cannot actually check, and the confident-fabrication
bug already documented in this repo gets harder to spot, not easier.

Everything factual has to keep coming from retrieval. That is not a limitation
to engineer around; it is the product.

So the honest ranking of what improves answers per rupee and per hour:

| Lever | Cost | Effect |
|---|---|---|
| Fix the inference key + credit | ~$10 | Chat works at all. Nothing else matters until this is done. |
| Corpus + retrieval quality | done, ongoing | Directly changes what the answer can contain |
| System-prompt iteration | hours, free | Most of the "voice" gain people expect from tuning |
| **Fine-tuning** | **$20–100 + days** | **Consistency of format and voice. Cheaper output. Nothing factual.** |

Tuning is worth doing — but as step 4, and for a specific reason, below.

## The one thing tuning is genuinely worth here

Format compliance. The system prompt currently spends a large share of its
tokens enforcing house style: bullets only, 4–5 max, ARVC order, no "Great
question", date every retrieved figure, sources line at the end, never
cross-attribute. A tuned model absorbs all of that into its weights.

That buys three real things:

1. **Consistency.** Prompt rules are requests. Weights are not. The rules that
   matter most for integrity — dating, never cross-attributing — are exactly the
   ones a small model drops first under a long context.
2. **A shorter prompt**, which means more of the context window is retrieved
   sources instead of instructions, on a model where context is the binding
   constraint.
3. **A smaller model can do the job**, which is the actual cost saving: a tuned
   8B matching an untuned 120B on format is a large drop in per-message cost.

## Where the training data comes from (you already have it)

`chat_history` in Supabase — every real question and answer, already paired.
That is the corpus. Never scrape someone else's outputs for this.

The catch: most of those rows are outputs of an *untuned* model, so training on
them straight teaches the model to imitate its own current mistakes. It has to
be filtered and corrected first. That editing pass is the real work; the
training run is an afternoon.

## The actual sequence, when you get to it

1. **Unblock inference.** Nothing below is testable until chat is reliably up.

2. **Instrument first.** Log which sources were retrieved per answer, and add a
   thumbs up/down in `chat.html`. Without a quality signal you cannot tell
   whether tuning helped, and "it feels better" is how people ship regressions.
   Collect for 2–4 weeks. This step is not optional and it is not glamorous.

3. **Build the set — 300–1,000 examples, quality over volume.** Pull the
   thumbs-up conversations plus any you would be happy to show a paying reader.
   For each: keep the question, **rewrite the answer to be exactly right** —
   correct bullets, correct dating, correct sources line, no filler. You are
   writing the answers you wish it gave. 500 hand-corrected examples beat 50,000
   scraped ones, and this is the part that cannot be automated.

   Format (JSONL, one object per line, the standard everywhere):

   ```
   {"messages":[{"role":"system","content":"<short version of the house rules>"},
                {"role":"user","content":"<question>"},
                {"role":"assistant","content":"<the corrected answer>"}]}
   ```

   Include the retrieved SOURCES block in the user turn for a realistic share of
   examples, and deliberately include some with **no** sources where the right
   answer is the "I don't have current data" line. If every training example has
   sources, the tuned model learns that sources are always present — and
   hallucinates them when they are not. That single omission would undo the
   entire integrity effort.

4. **Hold out 15%.** Never evaluate on what you trained on.

5. **Train.** LoRA, not full fine-tuning — minutes on a rented GPU, tens of
   dollars, and reversible. Sensible defaults for a set this size: rank 16,
   2–3 epochs, low learning rate. More epochs on 500 examples memorises them.

6. **Evaluate against the untuned model on the held-out set**, blind, on the
   things you actually care about: does it keep the bullet limit, does it date
   figures, does it refuse cleanly with no sources, does it ever attach a claim
   to the wrong source. `.rag/check-retrieval.mjs` covers retrieval; this is the
   generation half of the same idea.

7. **Ship behind the existing bucket switch.** `MODEL_BUCKETS` in
   `functions/chat.js` already routes per plan tier — point one tier at the tuned
   model, watch, then widen. Rollback is one line.

## Do not

- Do not train on facts, prices or current events. That is retrieval's job and
  it is the whole argument of this file.
- Do not train on unedited `chat_history`. It teaches the model its own errors.
- Do not tune before there is a quality signal to measure against.
- Do not delete the system prompt after tuning. Shorten it; keep the integrity
  rules (dating, attribution, the no-sources refusal) in text as well as weights.
  Belt and braces, for the two rules where being wrong is unrecoverable.
