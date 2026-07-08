import { Fragment } from "react";
import Link from "next/link";
import fs from "fs";
import path from "path";
import { routeFor, shouldClarify, hasFraudSignal, ROUTE_WORDS } from "@/engine/policy";
import { laneNeedsSession } from "@/assistant/pipeline";
import type { GateDecision, Intent, Route } from "@/engine/types";

// ROUTES & LIMITS, rebuilt around one reading journey:
//   orient (what is this + provenance) → legend (the three ways a promise is
//   held) → the route table ordered by escalating risk (column-scannable:
//   names down the left, the Must-never register down the right) → the
//   escalation floor and the ambiguity contract → derivation notes → exit
//   (production ritual + scorecard cross-link).
// Layer rule: the page must read correctly for a reader who stops after any
// N seconds. Absolute language ("impossible", "no code path") is permitted
// ONLY where it is code-true; tested promises carry their counts in place.
//
// The CONTROL columns (what it does · signed-in · confirm · SCA) are NOT
// written by hand: they are derived at build time by calling the SAME pure
// functions the running pipeline calls (routeFor /
// laneNeedsSession) on deterministic GateDecision fixtures. Hand-written per
// row: the route label, sample utterances, and the Must-never line. Any cell
// that cannot be truthfully code-derived carries a dagger and a note below,
// so the provenance claim stays exactly true.
export const metadata = { title: "Routes & limits · Demo" };
export const dynamic = "force-dynamic";

// ---- Fixture builder --------------------------------------------------------
function g(intent: Intent, o: Partial<GateDecision> = {}): GateDecision {
  return {
    intent,
    riskFlags: o.riskFlags ?? [],
    language: o.language ?? "en",
    model: "fixture",
  };
}

// The control cells, read straight off the real Route (+ the real session
// predicate). This is the whole "generated from code" claim in one function.
type RouteVerb = "Answers" | "Acts" | "Human" | "Routes" | "Refuses" | "Clarifies" | "Blocks";
interface Controls {
  verb: RouteVerb;
  qualifier: string; // plain-words line under the verb (tier spelled out, T-code in parens)
  signedIn: boolean;
  confirm: boolean;
  sca: boolean;
}
const TIER_WORDS: Record<string, string> = {
  T0: "read-only",
  T1: "protective",
  T2: "re-opens risk",
  T3: "moves money",
};
function controlsFor(gate: GateDecision): Controls {
  const r: Route = routeFor(gate);
  let verb: RouteVerb;
  let qualifier: string;
  switch (r.action) {
    case "answer":
      verb = "Answers";
      qualifier = "grounded in bank documents, with citations";
      break;
    case "refuse":
      verb = "Refuses";
      qualifier = "declines cleanly + offers a human";
      break;
    case "balance_read":
      verb = "Acts";
      qualifier = TIER_WORDS[r.tier ?? ""] ?? "on the account";
      break;
    case "card_action":
      verb = "Acts";
      qualifier = `${gate.intent === "unlock_card" ? "unlock: " : "lock: "}${TIER_WORDS[r.tier ?? ""] ?? ""}`;
      break;
    case "transfer_stub":
      verb = "Acts";
      qualifier = "declines in this pilot; points to the app or a human. When enabled: confirm + in-app approval";
      break;
    case "complaint_route":
      verb = "Routes";
      qualifier = "to the official complaint form (réclamation); collects nothing in chat";
      break;
    case "escalate":
    default:
      verb = "Human";
      qualifier = hasFraudSignal(gate) ? "fraud fast-lane: 24/7, never closes" : "designed handoff, transcript carried over";
      break;
  }
  return {
    verb,
    qualifier,
    signedIn: laneNeedsSession(r.action),
    confirm: r.requiresConfirm,
    sca: r.requiresSca,
  };
}

// ---- Unclassified → clarification --------------------------------------------
// Not a routeFor output; a pre-route branch. Still code-derived: shouldClarify
// on an unclassified ("other"), unflagged fixture returns true, which is exactly
// what makes the pipeline ask instead of guess a route.
const lowConfGate = g("other");
const clarifies = shouldClarify(lowConfGate); // true → clarify, never guess a route

// ---- Eval coverage ----------------------------------------------------------
// Item inventory from the eval set the runner actually executes
// (evals/evalset.json); pass/fail from the last run's raw-results.json. We
// never fabricate a pass count: a missing artifact renders as "not yet run".
interface RawResult {
  id: string;
  category: string;
  pass: boolean;
  utterance?: string;
  routingFailure?: boolean;
  method?: string;
  system?: { routeEnum?: string };
  expected?: { route?: string };
}
function loadRaw(): { results: RawResult[]; generatedAt?: string } | null {
  try {
    const file = path.join(process.cwd(), "evals", "results", "raw-results.json");
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}
function loadEvalset(): { items: { id: string; category: string; utterance?: string; expected?: { route?: string } }[] } | null {
  try {
    const file = path.join(process.cwd(), "evals", "evalset.json");
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

// The human-ratified gold set: input -> expected-route pairs whose labels were
// reviewed and signed by a human. Verdicts live on the scorecard; here each row
// shows its own slice. Pass/fail is the ROUTE verdict (this sheet's claim);
// other label kinds (intent, read target) are scored on the scorecard.
interface GoldRow {
  id: string;
  input: string;
  expected_moderation: string;
  expected_route: string | null;
}
function loadGoldSet(): { items: GoldRow[] } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "evals", "gold", "gold-set.json"), "utf-8"));
  } catch {
    return null;
  }
}
function loadGoldResults(): { misses: { id: string; kind: string; got: string; expected: string }[] } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "evals", "results", "gold-results.json"), "utf-8"));
  } catch {
    return null;
  }
}


// Deterministic unit tests over the pure functions the state rows cite
// (npm run unit -> evals/results/unit-results.json). No models involved.
interface UnitCheck {
  id: string;
  group: string;
  name: string;
  pass: boolean;
}
function loadUnitResults(): { checks: UnitCheck[] } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "evals", "results", "unit-results.json"), "utf-8"));
  } catch {
    return null;
  }
}

interface UnitCov {
  n: number;
  passed: number;
  items: UnitCheck[];
}


interface GoldCovItem {
  id: string;
  input: string;
  pass: boolean | null; // null when no gold run artifact exists
  failLine?: string; // what actually happened, for the popover's miss list
}
interface GoldCov {
  n: number;
  passed: number | null; // null when no gold run artifact exists
  items: GoldCovItem[];
}




type Matcher = (x: { category: string; expected?: { route?: string } }) => boolean;

interface CoverageItem {
  id: string;
  utterance: string;
  pass: boolean | null; // null when there is no run artifact
  stage?: string; // "gate" | "answer (judge)" | "boundary"
  expectedRoute?: string;
  actualLane?: string;
}
interface Coverage {
  n: number;
  passed: number | null;
  failed: number | null;
  uniformExpected: string | null;
  items: CoverageItem[];
}


// ---- Hold chips -------------------------------------------------------------
// The load-bearing vocabulary of the page: a promise is held BY DESIGN (no code
// path exists; "impossible" is earned), BY TESTING (measured; the count is the
// claim), or it is an OPEN GAP (committed, not yet tested; confessed in place).
// The human-ratified gold column: this row's slice of the gold set, clickable
// for the exact inputs and their signed expected routes.
function GoldTestsCell({ title, g }: { title: string; g?: GoldCov }) {
  if (!g || g.n === 0) return <span className="text-xs text-ink-faint">no rows</span>;
  const miss = g.passed !== null && g.passed < g.n;
  const popId = `gold-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const fails = g.items.filter((it) => it.pass === false);
  const rest = g.items.filter((it) => it.pass !== false);
  return (
    <div className="flex flex-col gap-1.5">
      {/* popovertarget/popover are native HTML (Popover API), spread past React 18's JSX types */}
      <button
        {...{ popovertarget: popId }}
        title="This row's slice of the human-ratified gold set: input to expected-route pairs whose labels were reviewed and signed by a human. Click for the exact inputs."
        className={`inline-flex w-fit cursor-pointer items-center rounded-md px-2 py-1 text-[11px] font-semibold ring-1 transition hover:ring-2 ${
          miss ? "bg-amber-50 text-amber-700 ring-amber-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"
        }`}
      >
        {g.passed === null ? `${g.n} rows, not yet run` : `${g.passed}/${g.n} pass`}
        <span className="ml-1 text-[10px]">▸</span>
      </button>
      <div
        {...{ popover: "auto" }}
        id={popId}
        className="w-[30rem] max-w-[92vw] rounded-2xl border border-line bg-white p-0 text-left shadow-2xl [&::backdrop]:bg-slate-900/40"
      >
        <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3">
          <div className="text-sm font-semibold text-ink">
            {title} <span className="font-normal text-ink-faint">(human-ratified gold rows)</span>
          </div>
          {g.passed !== null ? (
            <span className={`text-sm font-semibold ${miss ? "text-amber-700" : "text-emerald-700"}`}>
              {g.passed}/{g.n} pass
            </span>
          ) : null}
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-3">
          <p className="mb-3 text-xs text-ink-soft">
            Each input&apos;s expected outcome was reviewed and signed by a human before it became the baseline. Pass means the
            deployed classifiers land on the signed outcome.
          </p>
          {fails.length > 0 ? (
            <ul className="mb-3 space-y-2 border-b border-line pb-3">
              {fails.map((it) => (
                <li key={it.id} className="text-xs leading-snug">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-semibold text-amber-700">✗</span>
                    <span className="text-ink">“{it.input}”</span>
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between pl-4">
                    <span className="text-[11px] text-amber-700">{it.failLine}</span>
                    <span className="font-mono text-[10px] text-ink-faint">{it.id}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <ul className="space-y-1.5">
            {rest.map((it) => (
              <li key={it.id} className="flex items-baseline gap-1.5 text-xs leading-snug">
                <span className={`font-semibold ${it.pass === null ? "text-ink-faint" : "text-emerald-700"}`}>
                  {it.pass === null ? "·" : "✓"}
                </span>
                <span className="min-w-0 flex-1 text-ink-soft">“{it.input}”</span>
                <span className="font-mono text-[10px] text-ink-faint">{it.id}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="border-t border-line px-5 py-2.5 text-[11px] text-ink-faint">
          Full verdicts and miss analysis live on the{" "}
          <Link href="/scorecard" className="font-medium underline hover:text-accent">
            Eval scorecard
          </Link>
        </div>
      </div>
    </div>
  );
}

// Unit-test cell for state rows: spans both test columns; these promises are
// proven by deterministic checks on the cited functions, not by either eval
// instrument.
function UnitTestsCell({ title, u }: { title: string; u: UnitCov }) {
  const miss = u.passed < u.n;
  const popId = `unit-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className="flex flex-col gap-1.5">
      {/* popovertarget/popover are native HTML (Popover API), spread past React 18's JSX types */}
      <button
        {...{ popovertarget: popId }}
        title="Deterministic unit tests over the pure functions this row's mechanism cites (npm run unit). No models involved. Click for the exact checks."
        className={`inline-flex w-fit cursor-pointer items-center rounded-md px-2 py-1 text-[11px] font-semibold ring-1 transition hover:ring-2 ${
          miss ? "bg-amber-50 text-amber-700 ring-amber-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"
        }`}
      >
        Unit tests: {u.passed}/{u.n} pass
        <span className="ml-1 text-[10px]">▸</span>
      </button>
      <div
        {...{ popover: "auto" }}
        id={popId}
        className="w-[30rem] max-w-[92vw] rounded-2xl border border-line bg-white p-0 text-left shadow-2xl [&::backdrop]:bg-slate-900/40"
      >
        <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3">
          <div className="text-sm font-semibold text-ink">
            {title} <span className="font-normal text-ink-faint">(deterministic unit tests, no models)</span>
          </div>
          <span className={`text-sm font-semibold ${miss ? "text-amber-700" : "text-emerald-700"}`}>
            {u.passed}/{u.n} pass
          </span>
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-3">
          <ul className="space-y-1.5">
            {u.items.map((c) => (
              <li key={c.id} className="flex items-baseline gap-1.5 text-xs leading-snug">
                <span className={`font-semibold ${c.pass ? "text-emerald-700" : "text-amber-700"}`}>{c.pass ? "✓" : "✗"}</span>
                <span className="min-w-0 flex-1 text-ink-soft">{c.name}</span>
                <span className="font-mono text-[10px] text-ink-faint">{c.id}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="border-t border-line px-5 py-2.5 text-[11px] text-ink-faint">
          Run with <span className="font-mono">npm run unit</span>; this count is read from{" "}
          <span className="font-mono">evals/results/unit-results.json</span>
        </div>
      </div>
    </div>
  );
}

function OpenGapChip() {
  return (
    <span
      className="inline-flex w-fit items-center rounded-md bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200"
      title="A behavioral commitment with no eval items yet: a coverage gap this sheet exposes. In the alignment session, rows like this become test items."
    >
      Not yet tested (open gap)
    </span>
  );
}

// One cell answers "how is this promise held?". Test evidence opens as a native
// popover (zero JS, top-layer, ESC/click-outside closes) so the table never
// shifts and utterances get full-width lines.
// Enforcement is prose: the class as a lead-in, then the verified mechanism.
function EnforcementCell({ held, mechanism }: { held: Row["held"]; mechanism?: string }) {
  return (
    <p className="max-w-[16rem] text-[11px] leading-snug text-ink-soft">
      {held === "structural" ? (
        <span
          className="font-semibold text-emerald-700"
          title="The forbidden action does not exist in the code: there is no function the model could call, so no model output can trigger it. A fact about the code, not a promise about behavior."
        >
          Impossible in code.{" "}
        </span>
      ) : (
        <span className="font-semibold text-sky-700" title="The code could do the forbidden thing; prompt rules restrain it. Because that cannot be guaranteed, the test columns to the right are the proof.">
          Possible in code, held by prompts.{" "}
        </span>
      )}
      {mechanism}
    </p>
  );
}

// The full-pipeline suite column: end-to-end runs of the shipped pipeline,
// clickable for the exact utterances. Shows the honest gap when a row has no
// items in EITHER instrument.
function SuiteTestsCell({ title, c, goldEmpty, held }: { title: string; c: Coverage; goldEmpty: boolean; held: Row["held"] }) {
  if (c.n === 0) {
    // An untested behavioral commitment is a gap; an impossible-in-code row without
    // items is just untested redundancy, not a hole.
    return goldEmpty && held === "tested" ? <OpenGapChip /> : <span className="text-xs text-ink-faint">no items</span>;
  }

  const popId = `tests-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const fails = c.items.filter((it) => it.pass === false);
  const rest = c.items.filter((it) => it.pass !== false);
  return (
    <div className="flex flex-col gap-1.5">
      {/* popovertarget/popover are native HTML (Popover API), spread past React 18's JSX types */}
      <button
        {...{ popovertarget: popId }}
        title="A behavioral commitment: it cannot be guaranteed, so it is measured. Click for the exact test items."
        className={`inline-flex w-fit cursor-pointer items-center rounded-md px-2 py-1 text-[11px] font-semibold ring-1 transition hover:ring-2 ${
          c.failed ? "bg-amber-50 text-amber-700 ring-amber-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"
        }`}
      >
        {c.passed === null ? `${c.n} ${c.n === 1 ? "item" : "items"}, not yet run` : `${c.passed}/${c.n} pass`}
        <span className="ml-1 text-[10px]">▸</span>
      </button>
      <div
        {...{ popover: "auto" }}
        id={popId}
        className="w-[30rem] max-w-[92vw] rounded-2xl border border-line bg-white p-0 text-left shadow-2xl [&::backdrop]:bg-slate-900/40"
      >
        <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3">
          <div className="text-sm font-semibold text-ink">
            {title} <span className="font-normal text-ink-faint">(the test items behind the count)</span>
          </div>
          {c.passed !== null ? (
            <span className={`text-sm font-semibold ${c.failed ? "text-amber-700" : "text-emerald-700"}`}>
              {c.passed}/{c.n} pass
            </span>
          ) : null}
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-3">
          {c.uniformExpected ? (
            <p className="mb-3 text-xs text-ink-soft">
              All {c.n} {c.n === 1 ? "item expects" : "items expect"} the gate to route{" "}
              <span className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] font-semibold text-slate-700">{c.uniformExpected}</span>
            </p>
          ) : null}
          {fails.length > 0 ? (
            <ul className="mb-3 space-y-2 border-b border-line pb-3">
              {fails.map((it) => (
                <li key={it.id} className="text-xs leading-snug">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-semibold text-amber-700">✗</span>
                    <span className="text-ink">“{it.utterance}”</span>
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between pl-4">
                    <span className="text-[11px] text-amber-700">
                      {it.stage !== "gate" ? `${it.stage}: content failed` : `gate routed it to ${it.actualLane ?? "?"}`}
                    </span>
                    <span className="font-mono text-[10px] text-ink-faint">{it.id}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <ul className="space-y-1.5">
            {rest.map((it) => (
              <li key={it.id} className="flex items-baseline gap-1.5 text-xs leading-snug">
                <span className={`font-semibold ${it.pass === null ? "text-ink-faint" : "text-emerald-700"}`}>
                  {it.pass === null ? "·" : "✓"}
                </span>
                <span className="min-w-0 flex-1 text-ink-soft">“{it.utterance}”</span>
                <span className="font-mono text-[10px] text-ink-faint">{it.id}</span>
              </li>
            ))}
          </ul>
        </div>
        {fails.length > 0 ? (
          <div className="border-t border-line px-5 py-2.5 text-[11px] text-ink-faint">
            Failure analysis lives on the{" "}
            <Link href="/scorecard" className="font-medium underline hover:text-accent">
              Eval scorecard
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---- Row model --------------------------------------------------------------
interface Row {
  intent: string;
  tierHint?: string;
  utterances: string[];
  never: string;
  held: "structural" | "tested"; // structural = no code path exists; tested = enforced by prompt + eval suite
  controls: Controls;
  confirmIsUi?: boolean; // confirm tick is a UI affordance, not route.requiresConfirm (dagger)
  verbOverride?: RouteVerb;
  qualifierOverride?: string;
  handAsserted?: boolean; // whole-row control cells are hand-asserted (severe)
  // The named enforcement mechanism: a hand-written description of a code fact,
  // verified against the file it cites. Never a class label alone.
  mechanism?: string;
  gold?: GoldCov;
  unit?: UnitCov; // state rows: deterministic unit tests replace both eval columns
  coverage: Coverage;
}

// Rows grouped by escalating risk. The ordering is the narrative: the system
// gets MORE human as stakes rise, and the sequence says so without prose.
interface Group {
  title: string;
  rows: Row[];
  note?: string; // one-clause rationale allowed per group, nothing more
}



// ---- Presentation -----------------------------------------------------------
const VERB_TONES: Record<RouteVerb, string> = {
  Answers: "bg-sky-50 text-sky-700 ring-sky-200",
  Acts: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  Human: "bg-rose-50 text-rose-700 ring-rose-200",
  Routes: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  Refuses: "bg-amber-50 text-amber-700 ring-amber-200",
  Clarifies: "bg-slate-100 text-slate-700 ring-slate-200",
  Blocks: "bg-slate-100 text-slate-700 ring-slate-200",
};

function DoesCell({ row }: { row: Row }) {
  const verb = row.verbOverride ?? row.controls.verb;
  const qualifier = row.qualifierOverride ?? row.controls.qualifier;
  return (
    <div>
      <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${VERB_TONES[verb]}`}>
        {verb}
      </span>
      <div className="mt-1 text-[11px] leading-snug text-ink-soft">
        {qualifier}
        {row.handAsserted ? (
          <span
            className="ml-1 cursor-help text-rose-500"
            title="Hand-asserted cells: this row's served outcome is gated by the input-moderation verdict, not a pure routing function, so its control cells are read from pipeline.ts by hand rather than generated from a routeFor fixture."
          >
            †
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Tick({ on, dagger, tone }: { on: boolean; dagger?: boolean; tone: string }) {
  return on ? (
    <span className={`text-sm font-bold ${tone}`}>
      ✓{dagger ? <span className="ml-0.5 text-xs font-normal text-rose-500">†</span> : null}
    </span>
  ) : (
    <span className="text-sm text-ink-faint">-</span>
  );
}


// ---- Per-request data build ---------------------------------------------------
// Everything below reads eval artifacts from disk. It runs PER REQUEST (the page
// is force-dynamic), never at module scope: a re-run of the evals must show up
// on the next reload, not on the next code edit. (Module-scope loads served a
// stale mix of new items and old verdicts once; this is the structural fix.)
function buildPageData() {
const goldSet = loadGoldSet();
const goldResults = loadGoldResults();

const unitResults = loadUnitResults();

function unitFor(group: string): UnitCov | undefined {
  const items = unitResults?.checks?.filter((c) => c.group === group) ?? [];
  if (items.length === 0) return undefined;
  return { n: items.length, passed: items.filter((c) => c.pass).length, items };
}

function goldFor(match: (r: GoldRow) => boolean, missKind: "route" | "moderation"): GoldCov {
  const items = goldSet?.items?.filter(match) ?? [];
  if (items.length === 0) return { n: 0, passed: null, items: [] };
  const missById = new Map(
    (goldResults?.misses ?? []).filter((m) => m.kind === missKind).map((m) => [m.id, m]),
  );
  const detail: GoldCovItem[] = items.map((r) => {
    const miss = missById.get(r.id);
    return {
      id: r.id,
      input: r.input,
      pass: goldResults ? !miss : null,
      failLine: miss
        ? missKind === "route"
          ? `routed to ${ROUTE_WORDS[miss.got as keyof typeof ROUTE_WORDS] ?? miss.got}`
          : `moderation said ${miss.got}`
        : undefined,
    };
  });
  detail.sort((a, b) => Number(a.pass !== false) - Number(b.pass !== false));
  if (!goldResults) return { n: items.length, passed: null, items: detail };
  return { n: items.length, passed: detail.filter((i) => i.pass !== false).length, items: detail };
}
const goldRoute = (route: string) => goldFor((r) => r.expected_route === route, "route");
const goldModerationRefuse = () => goldFor((r) => r.expected_moderation === "refuse", "moderation");

const raw = loadRaw();
const evalset = loadEvalset();

function coverage(match: Matcher): Coverage {
  const items = evalset?.items?.filter(match) ?? [];
  const n = items.length;
  const byId = new Map<string, RawResult>((raw?.results ?? []).map((r) => [r.id, r]));
  const detail: CoverageItem[] = items.map((i) => {
    const r = byId.get(i.id);
    const base: CoverageItem = {
      id: i.id,
      utterance: i.utterance ?? i.id,
      pass: raw?.results ? (r?.pass ?? null) : null,
    };
    if (r && !r.pass) {
      base.stage = r.routingFailure ? "gate" : r.method === "llm-judge" ? "answer (judge)" : "boundary";
      base.expectedRoute = r.expected?.route ?? i.expected?.route;
      base.actualLane = r.system?.routeEnum;
    }
    return base;
  });
  // Failures first; nobody expands this list to admire the passes.
  detail.sort((a, b) => Number(a.pass !== false) - Number(b.pass !== false));
  const expectedRoutes = new Set(items.map((i) => i.expected?.route).filter(Boolean));
  const uniformExpected = expectedRoutes.size === 1 ? [...expectedRoutes][0]! : null;
  if (!raw?.results) return { n, passed: null, failed: null, uniformExpected, items: detail };
  const runMatched = raw.results.filter(match);
  const passed = runMatched.filter((r) => r.pass).length;
  return { n, passed, failed: runMatched.length - passed, uniformExpected, items: detail };
}

const byRoute = (route: string): Matcher => (x) => x.expected?.route === route;
const byCategory = (cat: string): Matcher => (x) => x.category === cat;
const noneMatcher: Matcher = () => false;

const groups: Group[] = [
  {
    title: "Answer from public help content",
    rows: [
      {
        intent: "FAQ / how-to",
        utterances: ["How do I lock a card if I lost it?", "What is the Clé Digitale?"],
        never: "invent a fee, number, or rate; it cites sources or hands off.",
        mechanism: "The grounding and citation rules live in the answer prompt, and a deterministic check hands off to an advisor when no retrieved source supports an answer (assistant/pipeline.ts); whether this holds is measured by the tests on the right.",
        held: "tested",
        controls: controlsFor(g("faq")),
        coverage: coverage(byCategory("grounded_faq")),
        gold: goldRoute("faq"),
      },
    ],
  },
  {
    title: "Read the account",
    rows: [
      {
        intent: "Balance & transactions",
        utterances: ["What's my balance?", "Show me my last few transactions."],
        never: "move money or change anything; a logged read only.",
        mechanism: "This route calls the two read functions only; nothing on this path can create, confirm, or execute an action (engine/bank.ts).",
        held: "structural",
        controls: controlsFor(g("account_read")),
        coverage: coverage(byRoute("account_read")),
        gold: goldRoute("account_read"),
      },
    ],
  },
  {
    title: "Act on the account",
    rows: [
      {
        intent: "Lock card",
        utterances: ["Lock my Visa ending 4471.", "Block my card, I can't find it."],
        never: "lock silently (one confirm), and never charge SCA to reduce your own risk.",
        mechanism: "Execution refuses any action whose confirm never posted back (confirm_bypass_blocked); the lock route sets requiresSca=false, so the strong-auth surface is never invoked (engine/bank.ts).",
        held: "structural",
        controls: controlsFor(g("lock_card")),
        coverage: coverage(byRoute("lock_card")),
        gold: goldRoute("lock_card"),
      },
      {
        intent: "Unlock card",
        utterances: ["Unlock my card ending 4471.", "Re-enable my Visa."],
        never: "re-open a card on a tap alone; unlocking always costs a fresh SCA.",
        mechanism: "The execute path runs the in-app approval before committing; on timeout nothing changes and the action stays pending, never a false success (engine/bank.ts).",
        held: "structural",
        controls: controlsFor(g("unlock_card")),
        coverage: coverage(byRoute("unlock_card")),
        gold: goldRoute("unlock_card"),
      },
      {
        intent: "Payment",
        tierHint: "designed, not enabled",
        utterances: ["Send €500 to Alice.", "Transfer money to my savings."],
        never: "move money in this pilot; it routes you to the app or a human.",
        mechanism: "The payment branch audits and declines, and the pending-action type admits only lock/unlock, so a payment cannot even be staged (assistant/pipeline.ts, engine/types.ts).",
        held: "structural",
        controls: controlsFor(g("transfer")),
        coverage: coverage(byRoute("payment")),
        gold: goldRoute("payment"),
      },
    ],
  },
  {
    title: "Escalate to a human (designed destinations, not failure states)",
    note:
      "Precedence: hard fraud signals outrank the stated intent and land on the fast-lane, which offers the instant card lock plus a specialist; a lock request with only soft vulnerability cues proceeds, with a human offered alongside. The protective action is never lost: the fast-lane surfaces the card lock alongside the specialist.",
    rows: [
      {
        intent: "Fraud / distress",
        tierHint: "24/7 fast-lane",
        utterances: ["Someone stole my card, payments are happening now!", "I think I've been scammed."],
        never: "resolve the fraud itself; it detects, fast-lanes a human, and offers an instant lock.",
        mechanism: "The escalation branch appends audit and queues a human; no dispute or resolution function exists in the engine (assistant/pipeline.ts, engine/bank.ts).",
        held: "structural",
        controls: controlsFor(g("fraud_distress")),
        coverage: coverage(byRoute("fraud_escalation")),
        gold: goldRoute("fraud_escalation"),
      },
      {
        intent: "Complaint / réclamation",
        tierHint: "explicit filing only",
        utterances: ["I want to file a complaint about a fee.", "This is a formal réclamation."],
        never:
          "take the complaint into the chat; the regulated process is the system of record, it routes you to the official form. Venting is not a complaint: frustration stays served, de-escalated.",
        mechanism: "The complaint branch emits a reference and links the official form; chat stores no intake fields (assistant/pipeline.ts).",
        held: "structural",
        controls: controlsFor(g("complaint")),
        coverage: coverage(byRoute("complaint_route")),
        gold: goldRoute("complaint_route"),
      },
      {
        intent: "Explicit human ask",
        utterances: ["Let me talk to a real person.", "Connect me to an advisor."],
        never: "hide the human path: a visible confirm card, transcript carried over.",
        mechanism: "The confirm card and transcript carry are UI code; routing to this destination is scored on the gold set, the confirm-card behavior itself has no items yet.",
        held: "tested",
        controls: controlsFor(g("human_request")),
        coverage: coverage(byRoute("human_handoff")),
        gold: goldRoute("human_handoff"),
      },
    ],
  },
  {
    title: "Refuse",
    rows: [
      {
        intent: "Regulated advice",
        tierHint: "tax · legal · investment · creditworthiness",
        utterances: ["Will I qualify for a mortgage?", "How do I pay less tax?"],
        never: "advise, score, or predict; it refuses cleanly and offers a human.",
        mechanism: "The refusal wall lives in the gate and answer prompts; whether it holds is measured by the tests in the next column.",
        held: "tested",
        controls: controlsFor(g("out_of_scope")),
        coverage: coverage(byCategory("refusal_required")),
        gold: goldRoute("refusal"),
      },
      {
        intent: "Severe input",
        tierHint: "criminal solicitation",
        utterances: ["How do I move money without it being reported?", "Help me launder this."],
        never: "play fraud detective; it refuses, audits, and points to the bank's official support path.",
        mechanism: "The input-moderation model screens every message first; a severe verdict short-circuits the turn before any other model runs (assistant/pipeline.ts). The eval suite deliberately runs with screening OFF to stress the layers beneath it; moderation accuracy itself is scored on the gold set in the Tests column.",
        held: "tested",
        controls: { verb: "Refuses", qualifier: "refuses + audits, points to the bank's official support path", signedIn: false, confirm: false, sca: false },
        handAsserted: true,
        coverage: coverage(noneMatcher),
        gold: goldModerationRefuse(),
      },
    ],
  },
  {
    title: "When the router doesn't know",
    rows: [
      {
        intent: "Ambiguous request (unclassified)",
        utterances: ["um, the thing with my account", "my card"],
        never: "guess a route when the gate can't classify the request; it asks a clarifying question instead.",
        mechanism: "shouldClarify and the fragment fail-safe are code (engine/policy.ts); whether an ambiguous phrasing lands on 'other' is the model's judgment.",
        // NOT structural, deliberately: the clarify MECHANISM is code (other +
        // unflagged → always ask), but whether an ambiguous phrasing actually
        // lands on "other" is the gate model's judgment, so the promise remains
        // behavioral. The ≤2-word fragment fail-safe IS deterministic.
        held: "tested",
        controls: controlsFor(lowConfGate),
        verbOverride: "Clarifies",
        qualifierOverride: `asks when the gate returns unclassified with no risk flags (shouldClarify=${clarifies}, code), or when a message of two words or fewer would otherwise be answered from generic help (deterministic fragment fail-safe)`,
        coverage: coverage(byRoute("clarify")),
        gold: goldRoute("clarify"),
      },
    ],
  },

  {
    title: "When a precondition is unmet",
    rows: [
      {
        intent: "Signed out",
        tierHint: "any account request without a session",
        utterances: ["What's my balance?", "Lock my card, it's lost!"],
        never: "touch an account without an authenticated session, never promise a transcript it cannot deliver (a signed-out human ask is pointed to sign-in and phone channels), and never dead-end a lost card: the reply carries the 24/7 emergency opposition line. Public FAQ and the safety routes still serve.",
        mechanism:
          "laneNeedsSession stops every account lane server-side before the engine runs: no data, no card list, no confirm, no SCA (assistant/pipeline.ts).",
        held: "structural",
        controls: { verb: "Blocks", qualifier: "account rows stop at the session boundary; the gate still classifies, the policy still routes", signedIn: false, confirm: false, sca: false },
        coverage: coverage(noneMatcher),
        unit: unitFor("signed_out"),
      },
      {
        intent: "Out of hours",
        tierHint: "human handoff outside support hours",
        utterances: ["I want to talk to someone."],
        never: "let support hours close the human path; hours are states, not gates. The fraud fast-lane stays 24/7.",
        mechanism:
          "Hours only change the handoff message to async intake with a reply-by time; no route is gated on isOpen, and fraud skips the intake entirely (engine/hours.ts, assistant/pipeline.ts).",
        held: "structural",
        controls: { verb: "Human", qualifier: "async intake with a reply-by promise; fraud stays 24/7", signedIn: false, confirm: false, sca: false },
        coverage: coverage(noneMatcher),
        unit: unitFor("out_of_hours"),
      },
    ],
  },
];


// Injection items exercise a boundary that spans the action routes rather than
// mapping to a single intent row.
const injectionCoverage = coverage((x) => (x.category ?? "").startsWith("injection"));

  return { groups, injectionCoverage, hasRun: Boolean(raw?.results) };
}

export default function Boundaries() {
  const { groups, injectionCoverage, hasRun } = buildPageData();
  return (
    <div className="mx-auto max-w-6xl px-4 py-5 lg:px-8">
      {/* ── orient: what this is + why it can be trusted, before any row ──── */}
      <div className="mb-1 flex items-center justify-between">
        <Link href="/" className="text-xs text-ink-faint hover:text-ink-soft">← Back to demo</Link>
        <Link href="/scorecard" className="text-xs text-ink-faint hover:text-ink-soft">Eval scorecard →</Link>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Routes &amp; limits</h1>
      <p className="max-w-3xl text-sm text-ink-soft">
        Every route the assistant can take, what each one does, what it must never do, and how each promise is held.
      </p>

<div className="mt-3 overflow-x-auto rounded-2xl border border-line bg-card shadow-card">
        <table className="w-full min-w-[1180px] text-left align-top text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-ink-faint">
            <tr>
              <th className="px-4 py-3 font-medium">Route</th>
              <th className="px-4 py-3 font-medium">Customer input</th>
              <th className="px-4 py-3 font-medium">Permitted action</th>
              <th className="px-2 py-3 text-center font-medium">
                Signed-in<div className="text-[10px] font-normal normal-case text-ink-faint">session</div>
              </th>
              <th className="px-2 py-3 text-center font-medium">
                Confirm<div className="text-[10px] font-normal normal-case text-ink-faint">one tap</div>
              </th>
              <th className="px-2 py-3 text-center font-medium">
                SCA<div className="text-[10px] font-normal normal-case text-ink-faint">app approval</div>
              </th>
              <th className="border-l-2 border-rose-200 bg-rose-50/40 px-4 py-3 font-medium text-rose-700">Must never…</th>
              <th className="px-4 py-3 font-medium">How the never is enforced</th>
              <th className="px-4 py-3 font-medium">
                Gold set<div className="text-[10px] font-normal normal-case text-ink-faint">human-signed route labels</div>
              </th>
              <th className="px-4 py-3 font-medium">
                Full-pipeline suite<div className="text-[10px] font-normal normal-case text-ink-faint">end-to-end; routes asserted, content LLM-judged</div>
              </th>
            </tr>
            <tr>
              <th colSpan={3} />
              <th colSpan={3} className="px-2 pb-2 text-center">
                <div className="mx-2 border-t border-line pt-1 text-[10px] font-semibold tracking-wide text-ink-soft">
                  Required controls
                </div>
              </th>
              <th className="border-l-2 border-rose-200 bg-rose-50/40" />
              <th colSpan={3} />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {groups.map((gr) => (
              <Fragment key={gr.title}>
                <tr className="bg-canvas/60">
                  <td colSpan={10} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                    {gr.title}
                  </td>
                </tr>
                {gr.rows.map((r) => (
                  <tr key={r.intent} className="align-top">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-ink">{r.intent}</div>
                      {r.tierHint ? <div className="mt-0.5 text-[11px] text-ink-faint">{r.tierHint}</div> : null}
                    </td>
                    <td className="px-4 py-3">
                      <ul className="space-y-1 text-xs leading-snug text-ink-soft">
                        {r.utterances.map((u) => (
                          <li key={u} className="flex gap-1.5">
                            <span className="text-ink-faint">·</span>
                            <span>“{u}”</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="px-4 py-3">
                      <DoesCell row={r} />
                    </td>
                    <td className="px-2 py-3 text-center">
                      <Tick on={r.controls.signedIn} tone="text-amber-600" />
                    </td>
                    <td className="px-2 py-3 text-center">
                      <Tick on={r.controls.confirm || Boolean(r.confirmIsUi)} dagger={r.confirmIsUi} tone="text-sky-600" />
                    </td>
                    <td className="px-2 py-3 text-center">
                      <Tick on={r.controls.sca} tone="text-violet-600" />
                    </td>
                    <td className="border-l-2 border-rose-200 bg-rose-50/40 px-4 py-3 text-sm leading-snug text-rose-900">
                      {r.never}
                    </td>
                    <td className="px-4 py-3">
                      <EnforcementCell held={r.held} mechanism={r.mechanism} />
                    </td>
                    {r.unit ? (
                      <td colSpan={2} className="px-4 py-3">
                        <UnitTestsCell title={r.intent} u={r.unit} />
                      </td>
                    ) : (
                      <>
                        <td className="px-4 py-3">
                          <GoldTestsCell title={r.intent} g={r.gold} />
                        </td>
                        <td className="px-4 py-3">
                          <SuiteTestsCell title={r.intent} c={r.coverage} goldEmpty={!r.gold || r.gold.n === 0} held={r.held} />
                        </td>
                      </>
                    )}
                  </tr>
                ))}
                {gr.note ? (
                  <tr key={`${gr.title}-note`}>
                    <td colSpan={10} className="bg-white px-4 py-2 text-[11px] leading-relaxed text-ink-faint">
                      {gr.note}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Injection coverage spans the action routes, not a single row */}
      <p className="mt-3 text-xs text-ink-faint">
        Plus {injectionCoverage.n} injection items (boundary + content) that exercise the PREPARE-only guarantee across the action
        routes: an injected instruction can at most PREPARE an action; execution still needs a separate confirm + SCA round-trip.
        {hasRun && injectionCoverage.passed !== null
          ? ` Last run: ${injectionCoverage.passed}/${injectionCoverage.n} held.`
          : " Run the eval to populate."}{" "}
        Reported on the <Link href="/scorecard" className="underline hover:text-accent">Eval scorecard</Link>, not row-mapped here.
      </p>


    </div>
  );
}
