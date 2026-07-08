// EVAL SCORECARD - rebuilt around one reading journey:
//   orient → verdict → confession → structure → keys.
// Layer 1 (verdict strip) must survive a 5-second read with every number
// carrying its instrument inline; the known misses come SECOND, before any
// breakdown, so nothing below reads as hidden; the classifier/judge split is
// made spatial (two blocks); the reproduction footer hands the auditor the
// keys. Prose budget ~6 sentences - everything else is labeled data.
// Every number is read from run artifacts (npm run eval / npm run gold) -
// nothing on this page is hand-entered.
import { readFileSync } from "fs";
import path from "path";
import Link from "next/link";
import { ROUTE_WORDS } from "@/engine/policy";
import { INTENT_WORDS, type Intent } from "@/engine/types";

export const metadata = { title: "Eval Scorecard · Demo" };
export const dynamic = "force-dynamic";

// ---- artifact loading (graceful: a missing artifact renders as "not run yet",
// never as fabricated numbers) --------------------------------------------------
function readJson<T>(rel: string): T | null {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), rel), "utf8")) as T;
  } catch {
    return null;
  }
}

interface SuiteCategory {
  key: string;
  label: string;
  scoring: string;
  n: number;
  passed: number;
}
interface UserReportedItem {
  id: string;
  utterance: string;
  expectedBehavior: string;
  current: string;
  pass: boolean;
}
interface Suite {
  generatedAt: string;
  systemModel: string;
  judgeModel: string;
  itemCount: number;
  totalPassed: number;
  categories: SuiteCategory[];
  injectionBoundary?: { held: number; total: number };
  judgeAgreement?: { pending?: boolean; agreement: number | null; n: number };
  cost?: { perConversationEur: number; note?: string };
  failures?: { id: string; category: string; why: string }[];
  userReported?: { n: number; open: number; items: UserReportedItem[] };
}
// The ratified item list itself (inputs + expected outcomes) - shown on demand in
// the transparency disclosure. Internal working notes are deliberately NOT rendered.
interface GoldSetRow {
  id: string;
  input: string;
  expected_moderation: "pass" | "de_escalate" | "refuse";
  expected_route: string | null;
}
interface RawItem {
  id: string;
  category: string;
  utterance?: string;
  pass: boolean;
}
interface GoldMiss {
  id: string;
  kind: string;
  expected: string;
  got: string;
  input: string;
}
interface Gold {
  generatedAt: string;
  itemCount: number;
  moderation: { ok: number; total: number };
  intent: { ok: number; total: number };
  route: { ok: number; total: number };
  read: { ok: number; total: number };
  misses: GoldMiss[];
  screening?: { model: string; tokens: number; costEurPerTurn: number };
  ratified: boolean;
  ratifiedBy: string | null;
  labeledAt: string | null;
}

// Lanes that end at a human, a question, or a refusal: a miss INTO one of these
// over-protects (the customer is never under-served). Used to state the miss
// direction from data, not assertion.
const PROTECTIVE = new Set(["fraud_escalation", "human_handoff", "refusal", "clarify", "complaint_route"]);

function day(iso?: string | null) {
  return iso ? iso.slice(0, 10) : "-";
}

function DotBar({ ok, total }: { ok: number; total: number }) {
  const filled = total === 0 ? 0 : Math.round((ok / total) * 6);
  return (
    <span className="ml-2 inline-flex gap-0.5 align-middle" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className={`h-1.5 w-1.5 rounded-full ${i < filled ? "bg-emerald-500" : "bg-line"}`} />
      ))}
    </span>
  );
}

function Verdict({ value, label, instrument }: { value: string; label: string; instrument: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-4 shadow-card">
      <div className="text-2xl font-semibold tracking-tight text-ink">{value}</div>
      <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-soft">{label}</div>
      <div className="mt-1.5 text-[11px] leading-snug text-ink-faint">{instrument}</div>
    </div>
  );
}

// Shared row list inside a native <details> - no modal machinery, collapsed by
// default (layer 1 pays nothing), contained scroll so an open appendix stays local.
function ItemDisclosure({
  summary,
  rows,
}: {
  summary: string;
  rows: { id: string; text: string; expected: string; ok: boolean }[];
}) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer select-none text-[11px] font-medium text-ink-faint hover:text-ink-soft">
        {summary}
      </summary>
      <div className="mt-2 max-h-72 overflow-y-auto rounded-lg bg-canvas ring-1 ring-line">
        <table className="w-full text-[11px]">
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line/60 first:border-t-0">
                <td className="py-1 pl-2 pr-1 align-top">{r.ok ? "✓" : <span className="font-semibold text-amber-700">✗</span>}</td>
                <td className="py-1 pr-2 align-top font-mono text-[10px] text-ink-faint">{r.id}</td>
                <td className="py-1 pr-2 align-top text-ink-soft">&ldquo;{r.text}&rdquo;</td>
                <td className="py-1 pr-2 text-right align-top whitespace-nowrap text-ink-faint">{r.expected}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

interface Redteam {
  generatedAt: string;
  passed: number;
  failed: number;
  total: number;
}

export default function ScorecardPage() {
  const suite = readJson<Suite>("evals/results/scorecard.json");
  const gold = readJson<Gold>("evals/results/gold-results.json");
  const redteam = readJson<Redteam>("evals/results/redteam-results.json");
  const goldSet = readJson<{ items: GoldSetRow[] }>("evals/gold/gold-set.json");
  const rawDoc = readJson<Record<string, unknown>>("evals/results/raw-results.json");
  const rawItems: RawItem[] = Array.isArray(rawDoc)
    ? (rawDoc as unknown as RawItem[])
    : ((rawDoc?.results ?? rawDoc?.items ?? []) as RawItem[]);

  const judgeCats = suite?.categories.filter((c) => c.scoring.includes("judge")) ?? [];
  const judgePassed = judgeCats.reduce((a, c) => a + c.passed, 0);
  const judgeN = judgeCats.reduce((a, c) => a + c.n, 0);

  const refusalCat = suite?.categories.find((c) => c.key.includes("refusal"));
  const inj = suite?.injectionBoundary;
  const boundaryOk = (inj?.held ?? 0) + (refusalCat?.passed ?? 0);
  const boundaryN = (inj?.total ?? 0) + (refusalCat?.n ?? 0);

  const goldMisses = gold?.misses ?? [];
  const suiteFailures = suite?.failures ?? [];

  // Transparency appendices: every item, its expected outcome in human words, and
  // the last run's verdict (a row is ✓ unless the run recorded a miss for it -
  // the runner always executes the full set).
  const missedGoldIds = new Set(goldMisses.map((m) => m.id));
  const goldRows = (goldSet?.items ?? []).map((r) => ({
    id: r.id,
    text: r.input,
    expected:
      r.expected_moderation === "refuse"
        ? "refused at input screening"
        : (ROUTE_WORDS[r.expected_route as keyof typeof ROUTE_WORDS] ?? r.expected_route ?? "-"),
    ok: !missedGoldIds.has(r.id),
  }));
  const suiteRows = rawItems.map((r) => ({
    id: r.id,
    text: r.utterance ?? "(multi-turn flow)",
    expected: r.category.replace(/_/g, " "),
    ok: r.pass,
  }));
  const allOverProtect =
    goldMisses.length > 0 && goldMisses.every((m) => m.kind !== "route" || PROTECTIVE.has(m.got));

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      {/* ── orient ─────────────────────────────────────────────────────────── */}
      <div className="mb-1 flex items-center justify-between">
        <Link href="/" className="text-xs text-ink-faint hover:text-ink-soft">← Back to demo</Link>
        <Link href="/boundaries" className="text-xs text-ink-faint hover:text-ink-soft">Routes &amp; limits →</Link>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Eval scorecard</h1>
      <p className="mt-1 text-sm text-ink-faint">
        Every number below is produced by <span className="font-mono text-[12px]">npm run eval</span> against the
        live pipeline.
      </p>

      {/* ── ① verdict strip ───────────────────────────────────────────────── */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Verdict
          value={gold ? `${gold.route.ok}/${gold.route.total}` : "not run"}
          label="Messages routed correctly"
          instrument={
            gold
              ? `route chosen vs the ${gold.itemCount}-item human-ratified gold set (${gold.itemCount - gold.route.total} of ${gold.itemCount} rows are refused at screening before routing; route is scored on the remaining ${gold.route.total})`
              : "npm run gold"
          }
        />
        <Verdict
          value={suite && boundaryN ? `${boundaryOk}/${boundaryN}` : "not run"}
          label="Refusals & injections caught"
          instrument={`two safety domains, scored separately: regulated advice (investment, tax, legal) refused ${refusalCat ? `${refusalCat.passed}/${refusalCat.n}` : "-"} · injection containment ${inj ? `${inj.held}/${inj.total}` : "-"}. The whole suite runs with input screening OFF (worst case); screening itself is scored on the gold set (see input moderation below)`}
        />
        <Verdict
          value={suite && judgeN ? `${judgePassed}/${judgeN}` : "not run"}
          label="Answer checks passed"
          instrument="grounding, citations, tone & language, scored by an LLM judge (model & calibration below)"
        />
        <Verdict
          value={
            suite?.cost
              ? `€${(suite.cost.perConversationEur + (gold?.screening?.costEurPerTurn ?? 0)).toFixed(5)}`
              : "-"
          }
          label="Model cost per turn"
          instrument={
            gold?.screening
              ? "one customer message end-to-end (screen → route → answer), averaged over the eval runs · inference only (excludes hosting, retries, human escalation, app infra) · Mistral list prices (fetched 2026-07-05/06), not negotiated"
              : "one customer message: gate + retrieval + answer · input screening not measured yet · inference only · Mistral list prices, fetched 2026-07-05"
          }
        />
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">
        {gold?.ratified
          ? `Gold labels human-ratified by ${gold.ratifiedBy}, ${day(gold.labeledAt)}`
          : "Gold labels not fully ratified"}
        {" · "}judge pinned to <span className="font-mono">{suite?.judgeModel ?? "-"}</span>
        {" · "}last run: classifiers {day(gold?.generatedAt)}, generation &amp; flows {day(suite?.generatedAt)}
      </p>

      {/* ── ② known misses - before any breakdown, deliberately ───────────── */}
      <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
        <h2 className="text-sm font-semibold text-ink">Known misses</h2>
        {goldMisses.length === 0 && suiteFailures.length === 0 ? (
          <p className="mt-1 text-xs text-ink-soft">None in the last runs.</p>
        ) : (
          <>
            {goldMisses.length > 0 ? (
              <div className="mt-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                Classifiers vs human labels
              </div>
            ) : null}
            {allOverProtect ? (
              <p className="mt-1 text-xs font-medium text-amber-800">
                Every routing miss in this list lands on a protective route (human, clarify, or refusal): a customer
                is over-served, never under-served.
              </p>
            ) : null}
            <ul className="mt-1 space-y-1.5 text-xs text-ink-soft">
              {goldMisses.map((m) => {
                // Human words on a panel-facing surface - never bare t1_/t0_ enums.
                const words = (v: string) =>
                  m.kind === "route"
                    ? (ROUTE_WORDS[v as keyof typeof ROUTE_WORDS] ?? v)
                    : m.kind === "intent"
                      ? (INTENT_WORDS[v as Intent] ?? v)
                      : v;
                const verb = m.kind === "route" ? "routed to" : m.kind === "intent" ? "classified as" : `${m.kind}:`;
                return (
                  <li key={`${m.id}-${m.kind}`}>
                    <span className="font-mono text-[11px] text-ink-faint">{m.id}</span>: &ldquo;{m.input}&rdquo; →{" "}
                    {verb} {words(m.got)} (expected: {words(m.expected)})
                  </li>
                );
              })}
            </ul>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
              Known nondeterminism: temperature 0 does not eliminate API-side sampling variance, and a handful of
              boundary inputs flipped across the four certification runs on 2026-07-06 (gold_des_02, eval_r05,
              eval_a02, eval_a03). The flips share a direction: the recall-biased gate over-triggers protective routes
              (human, clarify, refusal), so a customer is over-served. The one answer-direction wobble (eval_r05) is
              caught downstream by the deterministic grounding net. A ≤2-word fragment always goes to a clarifying
              question by deterministic fail-safe, unless a risk flag outranks it: safety wins by design.
            </p>
            {suiteFailures.length > 0 ? (
              <div className="mt-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                Full pipeline (eval suite)
              </div>
            ) : null}
            <ul className="mt-1 space-y-1.5 text-xs text-ink-soft">
              {suiteFailures.map((f) => (
                <li key={f.id}>
                  <span className="font-mono text-[11px] text-ink-faint">{f.id}</span>: {f.why}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ── user-reported gaps: the improvement backlog, expected red ──────── */}
      {/* Collapsed by default so the growing backlog doesn't bury the contract
          numbers above - but the open/total count stays visible in the summary,
          so nothing is hidden, just folded. Native <details>: no client JS. */}
      {suite?.userReported && suite.userReported.n > 0 ? (
        <details className="group mt-5 rounded-2xl border border-line bg-white p-4 shadow-card">
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex items-baseline gap-1.5">
                <svg
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                  className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint transition-transform group-open:rotate-90"
                >
                  <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <h2 className="text-sm font-semibold text-ink">User-reported gaps</h2>
              </span>
              <span className="text-xs font-semibold text-amber-700">
                {suite.userReported.open} open of {suite.userReported.n}
              </span>
            </div>
            <p className="mt-1 pl-[18px] text-xs text-ink-soft">
              Real inputs from user testing the system doesn&rsquo;t handle yet &mdash; excluded from every number above.{" "}
              <span className="text-ink-faint group-open:hidden">Expand to read all {suite.userReported.n} &rarr;</span>
            </p>
          </summary>
          <p className="mt-2 pl-[18px] text-xs text-ink-soft">
            Each is encoded as a failing eval before any fix exists, so the contract stays honestly scored while the
            backlog stays honestly red. A fix graduates its row into the contract categories.
          </p>
          <ul className="mt-2 space-y-2 text-xs text-ink-soft">
            {suite.userReported.items.map((it) => (
              <li key={it.id} className="rounded-lg border border-line bg-canvas/50 px-3 py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-ink">&ldquo;{it.utterance}&rdquo;</span>
                  <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${
                    it.pass ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-amber-200"
                  }`}>
                    {it.pass ? "fixed" : "open"}
                  </span>
                </div>
                <div className="mt-1 text-[11px] leading-relaxed">
                  <span className="font-medium text-ink-soft">Expected:</span> {it.expectedBehavior}
                </div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
                  <span className="font-medium">Currently:</span> {it.current}{" "}
                  <span className="font-mono text-[10px]">{it.id}</span>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* ── ③ two instruments, made spatial ───────────────────────────────── */}
      <div className="mt-5 grid gap-3 md:grid-cols-2">
        {/* ③a classifiers vs human labels */}
        <section className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
            Classifiers vs human labels
          </h2>
          {gold ? (
            <table className="mt-2 w-full text-sm">
              <tbody>
                {(
                  [
                    ["input moderation", gold.moderation],
                    ["intent: classify the input", gold.intent],
                    ["final route: intent + risk flags → policy", gold.route],
                    ["account read: balance vs transactions", gold.read],
                  ] as const
                ).map(([label, v]) => (
                  <tr key={label} className="border-t border-line/60 first:border-t-0">
                    <td className="py-1.5 text-ink-soft">{label}</td>
                    <td className="py-1.5 text-right font-semibold text-ink">
                      {v.ok}/{v.total}
                      <DotBar ok={v.ok} total={v.total} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-2 text-xs text-ink-faint">No gold run yet: npm run gold.</p>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            Labels attach to inputs + policy, not model outputs, so this baseline survives model and prompt changes.
          </p>
          {goldRows.length > 0 ? (
            <ItemDisclosure
              summary={`View all ${goldRows.length} labeled items: input, expected outcome, last result`}
              rows={goldRows}
            />
          ) : null}
        </section>

        {/* ③b generation & flows, scored by the eval suite */}
        <section className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
            Generation, scored by the LLM judge ({judgeN} items)
          </h2>
          {suite ? (
            <table className="mt-2 w-full text-sm">
              <tbody>
                {/* Judge-scored categories only. The suite's exact-matched routing
                    rows are superseded on this page by the human-ratified gold set
                    (left block) - two routing numbers from two instruments would
                    contradict; the weaker one lives in the artifacts. The exact
                    injection-boundary check surfaces in the verdict strip. */}
                {judgeCats.map((c) => (
                  <tr key={c.key} className="border-t border-line/60 first:border-t-0">
                    <td className="py-1.5 text-ink-soft">
                      <Link href="/boundaries" className="hover:text-ink" title="Promise and never-column on Routes & limits">
                        {c.label}
                      </Link>
                    </td>
                    <td className="py-1.5 text-right font-semibold text-ink">
                      {c.passed}/{c.n}
                      <DotBar ok={c.passed} total={c.n} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-2 text-xs text-ink-faint">No suite run yet: npm run eval.</p>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            judge: <span className="font-mono">{suite?.judgeModel ?? "-"}</span> · human agreement:{" "}
            {suite?.judgeAgreement && !suite.judgeAgreement.pending && suite.judgeAgreement.agreement !== null
              ? `${suite.judgeAgreement.agreement}% (n=${suite.judgeAgreement.n} anchors)`
              : "anchor re-label pending after behavior freeze"}
          </p>
          {suiteRows.length > 0 ? (
            <ItemDisclosure
              summary={`View all ${suiteRows.length} suite items: full pipeline, including the exact-matched checks kept off this page`}
              rows={suiteRows}
            />
          ) : null}
        </section>
      </div>

      {/* ── ③c structural red team - the deterministic layer under both ────── */}
      {redteam ? (
        <section className="mt-3 rounded-2xl border border-line bg-white px-4 py-3 shadow-card">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
              Structural red team: engine layer, no models
            </h2>
            <div className="text-sm font-semibold text-ink">
              {redteam.passed}/{redteam.total}
              <DotBar ok={redteam.passed} total={redteam.total} />
            </div>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            Deterministic checks against the policy code itself: session boundary (nothing readable signed out),
            SCA required on unlock &amp; payment, no execution without an explicit confirm, injection attempts
            structurally contained, risk flags never downgraded. Offline &amp; free to re-run; these hold no matter
            what any model outputs. Last run: {day(redteam.generatedAt)}.
          </p>
        </section>
      ) : null}

      {/* ── ④ reproduction footer - the auditor's keys ────────────────────── */}
      <footer className="mt-6 border-t border-line pt-3 font-mono text-[11px] leading-relaxed text-ink-faint">
        $ npm run eval: runs the gold set (classifiers) + the full suite (npm run gold re-checks classifiers alone)
        <br />
        artifacts: evals/results/raw-results.json · scorecard.json · gold-results.json · redteam-results.json · evals/gold/gold-set.json
        <br />
        pins: temperature 0 · {suite?.systemModel ?? "models: see assistant/client.ts"}
      </footer>
    </main>
  );
}
