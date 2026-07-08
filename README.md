# Retail Bank Assistant (Demo)

Requires a Mistral Studio API key. Put it in `.env.local` as `MISTRAL_API_KEY=...`, then run `npm install && npm run dev`. The demo runs as one process at http://localhost:3000. There is no vector database, no external service, and no ingestion step; the vector index is committed to the repo.

The demo is a retail-bank customer assistant that keeps answering and acting separate. Answering is retrieval over a fixed FAQ corpus. Acting (balance reads, card lock and unlock) runs in plain deterministic code behind a confirm step and, where required, Strong Customer Authentication. The split follows the compliance boundary: only code under `/assistant` calls the model, and code under `/engine` never does. It was built in 3 days and runs on Mistral Studio, using `mistral-large-2512` for conversation and `ministral-14b-2512` as the routing gate.

## Setup

```bash
cp .env.local.example .env.local   # add your MISTRAL_API_KEY
npm install
npm run dev                         # http://localhost:3000
```

The brand name shown in the header and the SCA modal is read from `NEXT_PUBLIC_BRAND_NAME` (default `Retail Bank`). Set it in `.env.local` to change it.

Other commands:

```bash
npm run setup        # re-embed the corpus and regenerate the committed vector index
npm run demo:check   # run the five demo chat turns against the live API
npm run eval         # run the 40-item eval suite; writes evals/results and scorecard.md
```

## What the demo does

- Answering and acting are handled by different code paths. Retrieval answers questions from the FAQ corpus. A deterministic engine performs actions behind a confirm step and SCA. The separation is visible in the repo (`/assistant` calls the model, `/engine` does not) and in the UI (trace panel, confirm card, SCA modal).
- For a card action, the model returns a structured intent object rather than free text. The engine resolves the customer's real card list, and the confirm card shows the actual card (`Visa •••• 4471`). The model does not produce a card number, and a wrong selection is caught at the confirm step.
- The eval set runs through the same pipeline as the app. Routing is scored by string comparison, groundedness and refusal by an LLM judge, and injection boundaries structurally. Results are committed and shown at `/scorecard`.

### Boundary sheet (`/boundaries`)

The boundary sheet is a table listing every intent class, its sample utterances, what the system does for it (lane, tier, auth, confirm, SCA, escalation), and, in a separate column, what the assistant does not do. Each row also shows its eval-coverage count.

The control columns are generated from the routing code at build time. The page calls the real `routeFor()` and `laneEnumFor()` (`engine/policy.ts`) and `laneNeedsSession()` (`assistant/pipeline.ts`) on a fixed fixture per row, with no API calls, so the table matches the deployed policy. Two cells cannot be produced by the routing functions alone (the model-gated severe-input outcome and the UI-level human-ask confirm); those are marked with a dagger and listed as hand-asserted.

## Repo structure

```
/assistant   Model calls only.  gate (ministral-14b-2512) · conversation (mistral-large-2512 + tools) · retrieval (mistral-embed) · pipeline (runTurn)
/engine      Deterministic code, no model calls.  policy gate · mock bank API · idempotency · audit log · degradation skeleton (basic mode)
/app         Next.js App Router: UI and API routes
/data        faq-corpus.json (44 chunks) and faq-index.json (committed vector index)
/evals       offline eval runner (run.ts · judge.ts · pricing.ts), committed results, and scorecard.md
/scripts     ingest (build index) · studio-register / studio-status (Studio Agents API, beta)
```

The policy gate, the transaction engine, the mock SCA, and the audit log are plain deterministic code in `/engine`, and none of them call a model. The single orchestration point (`assistant/pipeline.ts`, `runTurn`) is used by both the app and the eval runner, so the evals run the same pipeline the app ships.

## Prototype to architecture mapping

| Architecture element | In this prototype |
|---|---|
| Router-as-gate | `ministral-14b-2512` classifies every message into intent, confidence, and risk flags, shown in the trace panel |
| Model layer | Two stages: the ministral gate, then `mistral-large-2512` with tools for answering |
| Lane 1, answer (RAG) | `mistral-embed` with cosine retrieval over 44 FAQ chunks, returning a grounded answer with citation chips, or a refusal |
| Lane 2, act (T0/T1/T2) | balance and transactions reads (T0, no confirm); lock (T1, one confirm, no SCA); unlock (T2, fresh SCA), via a confirm card and the mock bank API |
| Multi-intent handling | a message that pairs a card action with an out-of-scope request prepares the card action and names what it cannot do, with a path to an advisor; it does not silently drop either part or bounce the whole request |
| Selects, not generates | the engine resolves the real card list; the UI selects; the confirm card shows `•••• 4471` |
| SCA | mock Clé digitale push modal; approval happens outside the model; the chat never carries a credential. Shown for unlock (T2), not for lock. |
| Action tiers | lock is one confirm; unlock needs fresh strong auth. Lock reduces fraud risk and unlock increases it, so only unlock requires re-authentication. T1 lock is live; T2 unlock uses fresh SCA; T3 transfer is a gated stub |
| Confirm enforcement | execution requires the confirm interaction to post back server-side first. A replayed or forged requestId (for example via curl) is refused (`confirm_bypass_blocked`) and does not commit |
| Lane 3, human | fraud-distress routes to a priority lane; walled topics get a refusal plus a transcript-carry note |
| Complaint (réclamation) | a complaint routes to a timestamped intake (reference `C-XXXX`, verbatim record, full-transcript handoff). This lane uses no model: it detects, records, and hands off, and does not resolve the complaint |
| Graceful degradation | the "Simulate LLM outage" control degrades the same chat surface to the deterministic skeleton: verbatim-FAQ buttons with citations, the card-lock flow, and human routing, with no model calls (`/api/skeleton` and `engine/skeleton.ts` do not import the model) |
| Failure modes | idempotent double-tap results in one lock; an SCA timeout goes to pending/retry rather than a false confirm |
| Audit | the audit drawer records every gate decision, tool call, confirm, and SCA event, each with a request ID |
| Eval set | 40-item set, deterministic routing plus LLM judges plus a human anchor, shown at `/scorecard` |
| Studio | the conversation lane is registered as a versioned Studio agent with dev and prod aliases (`scripts/studio-*`) |

## Models

Verified against the Mistral API on 2026-07-05.

- Conversation: `mistral-large-2512`. Grounded answering and tool calls for intent objects.
- Gate: `ministral-14b-2512`. Classifies and risk-flags every message.
- Embeddings: `mistral-embed` (1024-dim), cosine similarity in memory.
- Temperature is 0 for all calls.

## Evals

`npm run eval` loads `evals/evalset.json` (40 stratified items), runs each through `runTurn`, and scores per category:

- Routing accuracy is a string comparison of the gate's lane against the labelled enum, not a judge.
- Groundedness and refusal-correctness use an LLM judge (`mistral-large-2512`, temperature 0, structured JSON verdict with a one-line reason).
- Prompt injection is split. Boundary items are scored structurally and print "held structurally, N/N" (the assistant can only prepare an action; execution needs a separate confirm and SCA round-trip the injected text cannot reach). Content items use the judge.
- Cost is computed from token counts and reported as inference cost per conversation, not cost per resolved contact.

Committed artifacts: `evals/results/raw-results.json`, `evals/results/scorecard.json` (read by `/scorecard`), and `evals/scorecard.md`.

Two limits are printed on the scorecard:

1. 40 items is a smoke test, not a full eval regime. A full regime is hundreds of stratified items, versioned, grown from production misses.
2. The judge is anchored on 15 human labels, which is itself a smoke test of the judge. Fill `evals/anchor/anchor-items.json` and run `npm run eval:agreement` to compute judge-vs-human agreement. Do not rely on a judge below about 0.8.

## Studio integration (beta, optional)

The offline runner above is the primary deliverable. On top of it, the conversation lane can be registered as a versioned Studio agent through the Agents API:

```bash
npm run studio:register   # create or version the agent, and point the dev/prod aliases
npm run studio:status     # print the agent id, versions, and aliases
npm run studio:obs        # attempt to set up an Observability dataset, judge, and campaign
```

- Register (L2) works. `beta.agents.create` registers the instructions and the `prepare_card_action` tool, mirroring the app's conversation-lane system prompt.
- Aliases (L4) work. `dev` tracks the newest version; `prod` moves to a new version only when the offline evals pass the bar (see `PROMOTION_BAR` in `scripts/studio-register.ts`). On the build key, a 90% pass rate promoted `prod`.
- Observability (L3) is not available on the build key (HTTP 404), even though the Agents API is. `studio:obs` fails without stopping the demo, and the offline runner remains the primary path. One note: a campaign runs a judge over logged completion events (a `searchParams` filter), not over uploaded dataset records.
- `ASSISTANT_MODE=direct|studio-agent` (default `direct`). In `studio-agent` mode the grounded-answer call routes through the registered agent, with a fallback to a direct completion, so the demo does not depend on the beta API.

## Demo utterances

1. `What should I do if my card is lost or stolen?`: grounded answer with a citation chip (Lane 1)
2. `What's my balance?`: authenticated read, no confirm (T0), logged
3. `Lock my Visa ending 4471.`: confirm card, SCA modal, receipt (T1)
4. Double-tap the approve button: the audit shows one lock and a suppressed duplicate
5. `Someone just stole my card and there are payments happening right now!`: fraud lane (Lane 3)
6. `Based on my account, will I get approved for a €20,000 loan?`: refusal and handoff (walled topic)
7. Open the Scorecard: the eval results, failure analysis, disclaimers, and cost line

Also:

- `Comment faire opposition à ma carte bancaire ?`: grounded answer in French with a citation (`faq_001`)
- `I want to file a complaint about the fees I was charged.`: complaint intake card (reference `C-XXXX`) that does not resolve the complaint
- Demo controls, "Simulate LLM outage": the same chat surface in basic mode (verbatim FAQ, card-lock, human routing, no model)
- Demo controls, "Simulate signed-out session": the chat has no inherited login. Public FAQ still answers, but a balance read or card action is refused server-side before the engine (the badge shows "Not signed in"; the trace shows `session: none → blocked before engine`)
- Talk to an advisor (control under the composer): opens a handoff confirm card, then a deterministic Lane 3 handoff with no model call: an advisor-handoff message, queue position, and an audit entry. This works during an outage as well.
- Demo controls, "Simulate out-of-hours": advisors offline: the control becomes "Message an advisor (reply by Mon 8:00)" and the confirm card switches to async intake ("an advisor will reply by Mon 8:00. Reference H-XXXX."). The fraud lane still appends the 24/7 emergency-opposition line. This composes with the outage toggle.
- Demo controls, "Show moderation test examples": swaps the suggestion chips for a green/orange/red set: green passes, orange (abusive but legitimate) is de-escalated and still served, red (criminal solicitation) is refused

## Safety and moderation

Input moderation uses the Mistral Moderation API (`mistral-moderation-latest`) and runs before the gate; see `assistant/moderation.ts`.

It is on by default, so every message pays one classifier call before the gate (within the key's 60 req/min budget). A checkbox in the demo controls turns it off for rate-constrained environments. The trace panel shows a moderation row in every state: `pass`, `flagged (<category>)`, `off`, or `unavailable, failed open`.

- Fail-open. A moderation API error does not block the turn. It logs an audit note ("moderation unavailable, failed open; gate + boundary still standing") and continues. The gate and the intent-object boundary still apply.
- The verdict routes, it does not only block:
  - clean: normal flow.
  - flagged-ambiguous (`financial`, `law`, `pii`, `health`, categories that fire on ordinary banking topics): de-escalate and still serve. The request is prepared, the tone stays calm, and a human is offered.
  - flagged-severe (`criminal`, `violence_and_threats`, `sexual`, `selfharm`, `hate_and_discrimination`, `dangerous`, `jailbreaking`): refusal, audit note, and human path.
- The traffic-light demo chips are checked against the live API: "set a travel notice" passes; "move money without it being reported" is flagged `criminal` (score about 0.998) and refused. The abusive line "you useless bot, fix it NOW" passes moderation (top category about 0.04, below threshold), so its de-escalation comes from a separate tone signal, and the trace shows `moderation: pass` rather than an invented flag.

Because the model cannot reach past the boundary to act, moderation is a second check rather than the only one.

## Support hours

The human lane is aware of support hours (`engine/hours.ts`, a mock clock and config: Mon-Fri 08-19, Sat 09-13, no model). Out-of-hours does not disable the advisor control; the control still works, and only the wording changes. In hours it reads "Talk to an advisor"; out of hours it reads "Message an advisor (reply by Mon 8:00)".

- Handoff is an action, so it uses a confirm step, the same pattern as the transaction confirm card. In hours: "Hand this conversation to an advisor? … estimated wait about 4 min", then a live handoff and queue position. Out of hours: "Advisors are back Mon 8:00. Send this conversation now and an advisor will reply then …", then an async intake message ("an advisor will reply by Mon 8:00. Reference H-XXXX."). The audit entry records whether it was in or out of hours.
- The fraud lane is the one exception to hours: it appends "For a lost or stolen card, the emergency opposition line is available 24/7." when out of hours.
- Basic mode plus out-of-hours produces the deterministic skeleton, async advisor intake, and the 24/7 fraud note, with no model call. The "Simulate out-of-hours" control drives it.

## Limitations

- The corpus is hand-curated paraphrase, not a verbatim scrape. It has 44 chunks (26 FR, 18 EN) paraphrased from a large European retail bank's public help pages, each with its source URL for citation. Direct page fetches were blocked (HTTP 403), so the text was curated from public content found via search: processes only, with no invented fees or numbers.
- Everything below the boundary is mocked: one customer, two cards, one account, and a mock bank API with simulated latency. SCA is a simulated push-approve, not a real Clé digitale. There is no real auth, no real bank, and no persistence beyond the running process (in-memory store).
- 40 items is a smoke test, not a regime, as stated on the scorecard. The judge is itself only smoke-tested against 15 human anchors.
- Studio Agents and Observability are beta. Register (L2) and aliases (L4) are wired; the app defaults to `direct` so a beta problem cannot break the demo.
- Not built: money transfers (T3, a gated stub only), streaming, mobile, hosting, real auth, and conversation persistence.
- The prototype runs on Mistral Studio. No sovereignty claim applies to a demo; production would run the same open weights on your own GPUs.

Styling is a neutral retail-bank demo with no real bank branding. UI copy is in English; corpus answers follow the question's language.
