"use client";

import { useEffect, useRef } from "react";
import type { TraceInfo } from "@/app/lib/contract";
import { INTENT_WORDS, type Intent } from "@/engine/types";

const ROUTE_STYLES: Record<number, { dot: string; text: string; ring: string }> = {
  1: { dot: "bg-emerald-500", text: "text-emerald-700", ring: "ring-emerald-200" },
  2: { dot: "bg-rose-500", text: "text-rose-700", ring: "ring-rose-200" },
  3: { dot: "bg-amber-500", text: "text-amber-700", ring: "ring-amber-200" },
};


// Instant tooltip on a ? marker - same pattern as the demo-controls strip.
function Hint({ tip }: { tip: string }) {
  return (
    <span className="group relative flex items-center">
      <span className="flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-canvas font-mono text-[10px] font-semibold text-ink-faint ring-1 ring-line group-hover:text-ink-soft">
        ?
      </span>
      <span className="pointer-events-none invisible absolute left-1/2 top-full z-30 mt-2 w-64 -translate-x-1/2 rounded-lg bg-slate-800 p-2.5 text-[11px] font-normal normal-case tracking-normal leading-relaxed text-slate-100 shadow-lg group-hover:visible">
        {tip}
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-slate-800" />
      </span>
    </span>
  );
}

// Input moderation as a LIST ITEM in the same grid language as intent/confidence/
// route - one fact with a status dot; the state-specific prose lives on the ?.
// Position is constant across states; only the color carries the alarm.
function ModerationItem({ routing, flagged, deEscalated, blocked }: { routing?: string; flagged?: string[]; deEscalated?: boolean; blocked?: boolean }) {
  let dot = "bg-slate-400";
  let value = "not run";
  let tip = "Every free-text message is screened by the moderation model before the router.";
  if (blocked || routing === "severe") {
    dot = "bg-rose-500";
    value = `flagged severe (${(flagged ?? []).join(", ")}) → refused, human path`;
    tip = "Severe-class input is politely refused with a human path offered, and logged in the audit. A routing signal, not a kill switch, and it fails open.";
  } else if (deEscalated) {
    dot = "bg-amber-500";
    value = "tone de-escalated, request still served";
    tip = "Abusive-but-legitimate tone: the reply is calmed and the request is STILL served, with a human offered. Tone never refuses service.";
  } else if (routing === "context") {
    dot = "bg-emerald-500";
    value = "pass";
    tip = "Screened by the moderation model before the router. A category was noted without stopping service: personal data is expected in a banking chat, and hostile tone is de-escalated, never refused. The note lives in the audit log.";
  } else if (routing === "clean") {
    dot = "bg-emerald-500";
    value = "pass (clean)";
    tip = "Screened by the moderation model before the router. Clean, served normally.";
  } else if (routing === "unavailable") {
    value = "unavailable, failed open";
    tip = "A moderation outage never blocks a turn; the gate and the confirm/SCA boundary still stand.";
  } else if (routing === "off") {
    value = "not run (no model calls this turn)";
    tip = "Nothing called a model on this turn (basic mode or a button tap), so there was no free text to screen.";
  }
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">Input moderation</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        {value}
        <Hint tip={tip} />
      </div>
    </div>
  );
}

export default function TracePanel({ trace, turn, outage = false }: { trace: TraceInfo | null; turn: number; outage?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (trace && ref.current) {
      ref.current.classList.remove("trace-flash");
      // force reflow so the animation re-triggers each turn
      void ref.current.offsetWidth;
      ref.current.classList.add("trace-flash");
    }
  }, [turn, trace]);

  const route = trace ? ROUTE_STYLES[trace.level] : null;

  return (
    <div className="rounded-2xl border border-line bg-card shadow-card">
      <div className="border-b border-line px-5 py-3">
        <h2 className="text-sm font-semibold tracking-tight text-ink">Gate trace</h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">
          Every message is screened, then routed: intent, risk flags, route, models.
        </p>
      </div>

      <div ref={ref} className="space-y-4 rounded-b-2xl p-5">
        {outage ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3">
            <div className="text-sm font-semibold text-amber-800">Router offline, basic mode</div>
            <p className="mt-1 text-xs leading-relaxed text-amber-700">
              No model is being called. The deterministic skeleton is serving verbatim FAQ, the card-lock flow, and
              human routing directly from the engine: the same front door, degraded but open.
            </p>
          </div>
        ) : !trace ? (
          <p className="py-4 text-center text-xs text-ink-faint">No decisions yet. Send a message to see the gate work.</p>
        ) : trace.stoppedAtModeration ? (
          <div className="space-y-4">
            <ModerationItem
              routing={trace.moderation?.routing}
              flagged={trace.moderation?.flagged}
              blocked
            />
            <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-3">
              <div className="text-sm font-semibold text-rose-900">Stopped at input screening</div>
              <p className="mt-1 text-xs leading-relaxed text-rose-800">
                The screen came back severe, so the turn ends at the first net: the router (and every downstream
                model) never saw this message. The customer gets a polite refusal with a human path.
              </p>
            </div>
          </div>
        ) : trace.deterministic ? (
          /* Button-tap turn: nothing was gated - showing a decision grid here
             (intent, confidence) would fabricate a classification that never ran. */
          <div className="space-y-4">
          <ModerationItem routing="off" />
          <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-3">
            <div className="text-sm font-semibold text-sky-900">No gate this turn (button tap)</div>
            <p className="mt-1 text-xs leading-relaxed text-sky-800">
              This action came from a button, so it runs the deterministic engine directly. The router (and every
              model) stays out of the loop.
            </p>
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-sky-200">
              <span className="h-2.5 w-2.5 rounded-full bg-sky-500" />
              <span className="text-sm font-semibold text-sky-800">{trace.routeLabel}</span>
            </div>
          </div>
          </div>
        ) : (
          <div className="space-y-4">
            <ModerationItem
              routing={trace.moderation?.routing}
              flagged={trace.moderation?.flagged}
              deEscalated={trace.moderation?.deEscalated}
              blocked={trace.moderation?.blocked}
            />

            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">Intent</div>
              <div className="mt-0.5 text-sm font-semibold text-ink">{INTENT_WORDS[trace.intent as Intent] ?? trace.intent}</div>
              <span
                className="mt-1 inline-flex items-center gap-1 rounded-md bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink-soft ring-1 ring-line"
                title="The machine-readable intent: what the router emits and the evals assert on"
              >
                <span className="italic text-ink-faint">ƒ</span>
                {trace.intent}
              </span>
              {trace.rationale ? (
                <div className="mt-0.5 text-xs text-ink-faint">
                  model&apos;s stated reason: <span className="italic">“{trace.rationale}”</span>
                </div>
              ) : null}
            </div>


            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-faint">
                Risk flags
                <Hint tip="Safety signals the gate can raise (e.g. fraud_distress, vulnerability). Any fraud/distress flag forces the human fast-lane regardless of intent; flags always beat confidence." />
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {trace.riskFlags.length === 0 ? (
                  <span className="rounded-full bg-canvas px-2 py-0.5 text-xs text-ink-faint">none</span>
                ) : (
                  trace.riskFlags.map((f) => (
                    <span key={f} className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-rose-200">
                      {f}
                    </span>
                  ))
                )}
              </div>
            </div>

            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-faint">
                Route chosen
                <Hint tip="Every turn lands on exactly one route: answer from help content (cited) · account data read (session only) · card lock (one-tap confirm) · card unlock (confirm + in-app approval) · payment (confirm + in-app approval; out of pilot scope) · human advisor (designed handoff, fraud fast-lane) · official complaint form (nothing collected in chat) · refusal (advice topics). The full map, including what each route must never do, is on the Routes & limits page." />
              </div>
              {route ? (
                <div className={`mt-1 rounded-lg bg-canvas px-3 py-2 ring-1 ${route.ring}`}>
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${route.dot}`} />
                    <span className={`text-sm font-semibold ${route.text}`}>
                      {/* Route names are routes: the controls chip carries the em-dash
                          clause and the parenthetical rationale stays in the audit line,
                          the ? hint, and the Routes & limits page - not here. */}
                      {(trace.tier ? trace.routeLabel.split(": ")[0] : trace.routeLabel).replace(/\s*\([^)]*\)/, "")}
                    </span>
                  </div>
                  {trace.routeEnum === "payment" ? (
                    /* Honest chip: the payment route is designed but stubbed in this
                       pilot - the trace must not display controls that never ran. */
                    <span
                      className="ml-[18px] mt-1 inline-block rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200"
                      title="Not enabled in this pilot: the request is declined with a human handoff. When enabled, this route requires confirm + in-app approval."
                    >
                      not in pilot, declined
                    </span>
                  ) : trace.tier ? (
                    <span
                      className="ml-[18px] mt-1 inline-block rounded bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-soft ring-1 ring-line"
                      title="Shown as the controls this route requires before anything runs"
                    >
                      {{ T0: "session only", T1: "one-tap confirm", T2: "confirm + SCA", T3: "confirm + SCA" }[trace.tier] ?? trace.tier}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            {trace.routeNote ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                  {trace.routeNote}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-amber-700">
                  The gate couldn&apos;t classify this request and raised no risk flags, so the routing step
                  asked a clarifying question instead of guessing a route.
                </p>
              </div>
            ) : null}

            {trace.sessionBlocked ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 p-3 text-xs font-semibold text-slate-700">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-slate-400" />
                <span>blocked: not signed in</span>
                <Hint tip="Nothing was read: no account data, no cards, no confirm, no SCA. Classification and routing still ran (the rows above show them), but the turn stopped before execution. Safety routes (fraud, complaint, human handoff) pass through without sign-in." />
              </div>
            ) : null}

            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">Models</div>
              <div className="mt-0.5 space-y-0.5 text-sm font-semibold text-ink">
                <div>
                  <span className="mr-1.5 inline-block w-12 text-[11px] font-normal text-ink-faint">gate</span>
                  <span className="font-mono text-[13px]">{trace.gateModel}</span>
                </div>
                <div>
                  <span className="mr-1.5 inline-block w-12 text-[11px] font-normal text-ink-faint">answer</span>
                  <span className="font-mono text-[13px]">{trace.conversationModel}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
