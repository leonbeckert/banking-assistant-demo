"use client";

// Persistent audit column - the third act of the page's spatial story: the chat
// is what the customer sees, the trace is what the system decided, this is what
// got recorded. Chronological like the chat, auto-follows the newest entry.
import { useEffect, useRef } from "react";
import type { AuditEntry } from "@/engine/types";

const TYPE_COLOR: Record<string, string> = {
  gate_decision: "bg-slate-100 text-slate-700",
  route: "bg-slate-100 text-slate-700",
  retrieval: "bg-sky-50 text-sky-700",
  answer: "bg-emerald-50 text-emerald-700",
  refusal: "bg-amber-50 text-amber-700",
  escalation: "bg-amber-50 text-amber-700",
  de_escalation: "bg-orange-50 text-orange-700",
  moderation: "bg-emerald-50 text-emerald-700",
  complaint_route: "bg-indigo-50 text-indigo-700",
  session_boundary: "bg-amber-50 text-amber-700",
  balance_read: "bg-sky-50 text-sky-700",
  transactions_read: "bg-sky-50 text-sky-700",
  tool_call: "bg-violet-50 text-violet-700",
  confirm_issued: "bg-violet-50 text-violet-700",
  confirmed: "bg-violet-50 text-violet-700",
  confirm_bypass_blocked: "bg-rose-50 text-rose-700",
  sca_started: "bg-cyan-50 text-cyan-700",
  sca_approved: "bg-emerald-50 text-emerald-700",
  sca_timeout: "bg-amber-50 text-amber-700",
  bank_execute: "bg-rose-50 text-rose-700",
  idempotent_suppressed: "bg-orange-50 text-orange-700",
  transfer_stub: "bg-slate-100 text-slate-700",
};

export default function AuditPanel({ entries }: { entries: AuditEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-card">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Audit log</h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">Every decision, tool call, and SCA event - with request IDs.</p>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3" style={{ maxHeight: "560px" }}>
        {entries.length === 0 ? (
          <p className="mt-8 text-center text-xs text-ink-faint">No events yet. Send a message to populate the log.</p>
        ) : (
          <ol className="space-y-1.5">
            {entries.map((e) => (
              <li key={e.seq} className="rounded-lg border border-line bg-white p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${TYPE_COLOR[e.type] ?? "bg-slate-100 text-slate-700"}`}>
                    {e.type}
                  </span>
                  <span className="truncate font-mono text-[10px] text-ink-faint">{e.requestId}</span>
                </div>
                <div className="mt-1 text-xs leading-snug text-ink">{e.summary}</div>
                <div className="mt-0.5 flex items-center justify-between text-[10px] text-ink-faint">
                  <span className="font-mono">#{e.seq}</span>
                  <span>{new Date(e.ts).toLocaleTimeString()}</span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

    </div>
  );
}
