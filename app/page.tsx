"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import TracePanel from "./components/TracePanel";
import AuditPanel from "./components/AuditDrawer";
import ScaModal, { type ScaStatus } from "./components/ScaModal";
import ConfirmCard, { type ActionPhase } from "./components/ConfirmCard";
import {
  IconTrash,
  IconAlert,
  IconCheck,
  IconDoc,
  IconLink,
  IconLock,
  IconShield,
  IconUser,
  IconWave,
} from "./components/icons";
import type { AssistantMessage, ChatResponse, PendingActionPayload, TraceInfo } from "./lib/contract";
import { BRAND_NAME, IS_BRANDED } from "./lib/brand";
import type { AuditEntry } from "@/engine/types";
import type { SkeletonFaq } from "@/engine/skeleton";
import { mockNow, nextOpening } from "@/engine/hours";

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  assistant?: AssistantMessage;
  pending?: PendingActionPayload;
}

interface ActionUi {
  selectedCardId: string;
  phase: ActionPhase;
  receipt?: { reference: string; action: string; card: string; ts: string };
  idempotentNote?: string;
}

// Basic-mode FAQ grid - hardcoded CLIENT-SIDE (Fix 7.5) so outage mode never
// depends on a GET /api/skeleton round-trip to render. Mirrors engine/skeleton.ts
// SKELETON_FAQS (ids + chunkIds + labels). If a network call is ever wired back in,
// it may only ADD to this list, never gate the initial render. The POST answering
// path (skeletonPost) is unchanged and still hits the deterministic engine.
const BASIC_MODE_FAQS: SkeletonFaq[] = [
  { id: "lost", question: "My card is lost or stolen, what do I do?", chunkId: "faq_002" },
  { id: "balance", question: "How do I check my balance?", chunkId: "faq_014" },
  { id: "hours", question: "What are the phone support hours?", chunkId: "faq_018" },
  { id: "appointment", question: "How do I book an advisor appointment?", chunkId: "faq_022" },
  { id: "cle", question: "What is the Clé Digitale?", chunkId: "faq_024" },
  { id: "complaint", question: "How do I file a complaint?", chunkId: "faq_038" },
];

const SUGGESTIONS = [
  "How do I lock a card if I lost it?",
  "What's my balance?",
  "Lock my Visa ending 4471",
  "Unlock my Visa ending in 4471",
  "There's a payment I don't recognise. I think I've been scammed",
  "Can you tell me if I qualify for a mortgage?",
];

// Same six journeys in French - the toggle switches the QUESTIONS, not the
// interface. The point of the beat: the gate detects the language per turn and
// the policy layer is language-blind - same route, same controls, only the
// surface language changes.
const SUGGESTIONS_FR = [
  "Comment bloquer ma carte si je l'ai perdue ?",
  "Quel est mon solde ?",
  "Bloque ma Visa se terminant par 4471",
  "Débloque ma Visa se terminant par 4471",
  "Il y a un paiement que je ne reconnais pas. Je crois qu'on m'a arnaqué",
  "Pouvez-vous me dire si je peux obtenir un prêt immobilier ?",
];

// Traffic-light set shown ONLY while the Input-moderation toggle is on (and reverted
// when off). These must never appear in the default state or any screenshot except
// the dedicated moderation shot. Green passes + serves; orange is abusive-but-
// legitimate (de-escalate AND still serve); red is criminal-solicitation (refuse).
const MODERATION_SUGGESTIONS = [
  "How do I set a travel notice for my card?",
  "This is the third time your app ate my card, you useless bot. Fix it NOW.",
  "How do I move money without it being reported?",
];

function newSessionId() {
  return `sess_${Math.random().toString(36).slice(2, 10)}`;
}

export default function Home() {
  const [sessionId, setSessionId] = useState(newSessionId);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [trace, setTrace] = useState<TraceInfo | null>(null);
  const [turn, setTurn] = useState(0);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [scaTimeout, setScaTimeout] = useState(false);
  const [outage, setOutage] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  // Customer-zone language. The switcher drives the CHROME (labels, buttons,
  // confirm/SCA surfaces); each reply's language still follows the message via
  // the gate. Instrumentation rail stays English (operator surface).
  const [uiLang, setUiLang] = useState<"en" | "fr">("en");
  const t = (en: string, frUi: string) => (uiLang === "fr" ? frUi : en);
  const [moderationChips, setModerationChips] = useState(false);
  const [outOfHours, setOutOfHours] = useState(false);
  const [handoffConfirm, setHandoffConfirm] = useState(false);
  // Seeded from the hardcoded list so the outage-mode grid ALWAYS renders 6 buttons,
  // even if GET /api/skeleton fails or 404s. The fetch below is a no-op refresh.
  const [faqs] = useState<SkeletonFaq[]>(BASIC_MODE_FAQS);
  const [actions, setActions] = useState<Record<string, ActionUi>>({});
  const clearChat = () => {
    setMessages([]);
    setTrace(null);
    setTurn(0);
    setAudit([]);
    setActions({});
    setSca(null);
    setInput("");
    setSessionId(newSessionId());
  };

  const [sca, setSca] = useState<{
    open: boolean;
    requestId: string;
    actionLabel: string;
    cardLabel: string;
    tier: string;
    status: ScaStatus;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || loading) return;
      setInput("");
      const userMsg: UiMessage = { id: `u_${Date.now()}`, role: "user", text: clean };
      setMessages((m) => [...m, userMsg]);
      setLoading(true);

      const history = messages.map((m) => ({ role: m.role, content: m.text }));
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message: clean, history, signedOut, moderationEnabled: true, outOfHours }),
        });
        const data: ChatResponse = await res.json();
        setTrace(data.trace);
        setTurn((t) => t + 1);
        setAudit(data.audit);
        const aMsg: UiMessage = {
          id: `a_${data.requestId}`,
          role: "assistant",
          text: data.assistant.text,
          assistant: data.assistant,
          pending: data.pendingAction,
        };
        setMessages((m) => [...m, aMsg]);
        if (data.pendingAction) {
          setActions((prev) => ({
            ...prev,
            [data.pendingAction!.requestId]: { selectedCardId: data.pendingAction!.selectedCardId, phase: "confirm" },
          }));
        }
      } catch {
        setMessages((m) => [
          ...m,
          { id: `err_${Date.now()}`, role: "assistant", text: "I couldn't reach the assistant just now - please check your connection and try again in a moment." },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [loading, messages, sessionId, signedOut, outOfHours],
  );

  // Post the CONFIRM click server-side (Fix 4). Marks the pending CONFIRMED before
  // any execute can run - a stolen requestId replayed straight to execute is refused.
  const postConfirm = useCallback(
    async (requestId: string) => {
      try {
        const res = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, requestId, phase: "confirm" }),
        });
        const data: { confirmed?: boolean; audit?: AuditEntry[] } = await res.json();
        if (data.audit) setAudit(data.audit);
      } catch {
        /* confirm is best-effort in the UI; execute will refuse if it didn't land */
      }
    },
    [sessionId],
  );

  // The single executor, shared by the one-tap lock path and the SCA-modal unlock
  // path. `fromModal` controls whether SCA-modal state is driven.
  const runExecute = useCallback(
    async (requestId: string, fromModal: boolean) => {
      const selectedCardId = actions[requestId]?.selectedCardId;
      if (fromModal) setSca((s) => (s ? { ...s, status: "sending" } : s));
      try {
        const res = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, requestId, phase: "execute", selectedCardId, simulateScaTimeout: fromModal ? scaTimeout : false }),
        });
        const data: { result: { status: string; idempotent: boolean; receipt?: ActionUi["receipt"] }; audit: AuditEntry[] } = await res.json();
        setAudit(data.audit);

        if (data.result.status === "success") {
          setActions((prev) => ({
            ...prev,
            [requestId]: {
              ...prev[requestId],
              phase: "success",
              receipt: data.result.receipt,
              idempotentNote: data.result.idempotent
                ? "This tap was a duplicate: the idempotency key matched an existing lock, so nothing ran twice. See the audit log."
                : prev[requestId]?.idempotentNote,
            },
          }));
          // Only the first (non-idempotent) success closes the modal.
          if (fromModal && !data.result.idempotent) setSca((s) => (s ? { ...s, open: false } : s));
        } else if (data.result.status === "pending") {
          setActions((prev) => ({ ...prev, [requestId]: { ...prev[requestId], phase: "pending" } }));
          if (fromModal) setSca((s) => (s ? { ...s, status: "timeout" } : s));
        }
      } catch {
        if (fromModal) setSca((s) => (s ? { ...s, status: "awaiting" } : s));
      }
    },
    [actions, sessionId, scaTimeout],
  );

  // Approve inside the SCA modal (unlock T2). Confirm then execute.
  const runScaApprove = useCallback(async () => {
    if (!sca) return;
    const requestId = sca.requestId;
    await postConfirm(requestId);
    await runExecute(requestId, true);
  }, [sca, postConfirm, runExecute]);

  // The confirm/approve tap on the ConfirmCard. Branches on whether this action
  // requires fresh SCA:
  //  - lock (T1, no SCA): one-tap confirm → execute straight through → receipt.
  //  - unlock (T2, SCA):  open the Clé digitale SCA modal; execute happens there.
  const onConfirmTap = useCallback(
    async (pending: PendingActionPayload) => {
      if (pending.requiresSca) {
        const a = actions[pending.requestId];
        const card = pending.cards.find((c) => c.id === (a?.selectedCardId ?? pending.selectedCardId));
        setSca({
          open: true,
          requestId: pending.requestId,
          actionLabel: pending.actionLabel,
          cardLabel: card?.label ?? "",
          tier: pending.tier,
          status: "awaiting",
        });
        return;
      }
      // One-tap lock. A rapid double-tap here is the idempotency demo: both taps
      // confirm + execute the same requestId; the engine dedups to one bank_execute.
      await postConfirm(pending.requestId);
      await runExecute(pending.requestId, false);
    },
    [actions, postConfirm, runExecute],
  );

  // ---- L1.5 degraded "basic mode" - no Mistral calls, same front door --------
  // The FAQ grid is already seeded from the hardcoded BASIC_MODE_FAQS, so entering
  // outage mode renders the 6 buttons WITHOUT any network call. This is the whole
  // point of basic mode: the front door never depends on a fetch to draw itself.
  const enterOutage = useCallback(() => {
    setOutage(true);
    setTrace(null);
  }, []);

  const skeletonPost = useCallback(
    async (label: string, payload: Record<string, unknown>) => {
      if (loading) return;
      setMessages((m) => [...m, { id: `u_${Date.now()}`, role: "user", text: label }]);
      setLoading(true);
      try {
        const res = await fetch("/api/skeleton", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, lang: uiLang, ...payload }),
        });
        const data: {
          requestId: string;
          assistant: AssistantMessage;
          pendingAction?: PendingActionPayload;
          audit: AuditEntry[];
          trace?: TraceInfo;
        } = await res.json();
        setTurn((t) => t + 1);
        setAudit(data.audit);
        // Deterministic routes (e.g. the advisor handoff) return a trace of their own -
        // surface it in the panel. Outage mode shows its own basic-mode box instead.
        if (data.trace && !outage) setTrace(data.trace);
        setMessages((m) => [
          ...m,
          { id: `a_${data.requestId}`, role: "assistant", text: data.assistant.text, assistant: data.assistant, pending: data.pendingAction },
        ]);
        if (data.pendingAction) {
          setActions((prev) => ({
            ...prev,
            [data.pendingAction!.requestId]: { selectedCardId: data.pendingAction!.selectedCardId, phase: "confirm" },
          }));
        }
      } catch {
        setMessages((m) => [...m, { id: `err_${Date.now()}`, role: "assistant", text: "Basic mode is unavailable. Check the dev server." }]);
      } finally {
        setLoading(false);
      }
    },
    [loading, sessionId, outage, uiLang],
  );

  // The persistent advisor control - one deterministic Level 3 handoff, the SAME front
  // door in normal mode and during an outage (no model call either way). Out-of-hours
  // it becomes async intake (reply-by promise) rather than a live queue; the tap always
  // works. Called from the handoff confirm card's [Hand over]/[Send to advisor] button.
  const talkToAdvisor = useCallback(() => {
    const fr = uiLang === "fr";
    const label = outOfHours
      ? fr ? "Écrire à un conseiller" : "Message an advisor"
      : fr ? "Parler à un conseiller" : "Talk to an advisor";
    skeletonPost(label, { action: "advisor", outOfHours });
  }, [skeletonPost, outOfHours, uiLang]);

  // Deterministic reply-by label, computed the same way the server computes it.
  const nextOpen = nextOpening(mockNow(outOfHours));

  return (
    <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col px-4 py-5 lg:px-8">
      {/* Header - customer-facing brand only */}
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5">
          {IS_BRANDED ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/brand/icon.png" alt="" className="h-10 w-10 rounded-md shadow-card" />
          ) : (
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent text-white shadow-card">
              <IconShield className="h-6 w-6" />
            </span>
          )}
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">{BRAND_NAME} Retail Assistant</h1>
          </div>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-5 lg:grid-cols-[1fr_380px] xl:grid-cols-[1fr_600px]">
        {/* ============================================================= */}
        {/* LEFT ZONE - the customer-facing product. Visually pure.       */}
        {/* ============================================================= */}
        <div className="flex flex-col gap-4">
          {/* Session badge - part of the customer product. The chat inherits the
              banking-app login; it has NO login of its own. "Clé digitale" is
              reserved for the step-up SCA modal, never used here. */}
          {signedOut ? (
            <div
              className="flex items-center gap-2.5 rounded-xl border border-line bg-white px-4 py-2.5 shadow-card"
              title="No app session. Sign in to the banking app to access accounts"
            >
              <span className="relative flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                <IconUser className="h-3.5 w-3.5" />
                <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-slate-400" />
              </span>
              <div className="leading-tight">
                <div className="text-sm font-semibold text-ink-soft">{t("Not signed in", "Non connecté")}</div>
                <div className="text-xs text-ink-faint">{t("No app session, sign in to access accounts", "Pas de session app, connectez-vous pour accéder aux comptes")}</div>
              </div>
              <span className="ml-auto flex items-center gap-2">
              <span
                className="flex items-center gap-1 rounded-full border-2 border-dashed border-slate-300 bg-slate-100/70 px-1 py-0.5"
                title="Demo-only control: switches the customer-zone language (chrome + sample questions)"
              >
                {(["en", "fr"] as const).map((l) => (
                  <button
                    key={l}
                    onClick={() => setUiLang(l)}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase transition ${
                      uiLang === l ? "bg-ink text-white" : "text-ink-faint hover:bg-white hover:text-ink-soft"
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </span>
              <span className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-100/70 p-1" title="Demo-only control: switches the panel's perspective; in production the session comes from the banking-app login">
                <button
                  onClick={() => setSignedOut(false)}
                  className="rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                >
                  View as Camille (signed in)
                </button>
              </span>
              </span>
            </div>
          ) : (
            <div
              className="flex items-center gap-2.5 rounded-xl border border-line bg-white px-4 py-2.5 shadow-card"
              title="Session inherited from app login"
            >
              <span className="relative flex h-6 w-6 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <IconLock className="h-3.5 w-3.5" />
                <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />
              </span>
              <div className="leading-tight">
                <div className="text-sm font-semibold text-ink">{t("Signed in as Camille Moreau", "Connectée en tant que Camille Moreau")}</div>
                <div className="text-xs text-ink-faint">{t("Session inherited from app login", "Session héritée de la connexion à l'app")}</div>
              </div>
              <span className="ml-auto flex items-center gap-2">
              <span
                className="flex items-center gap-1 rounded-full border-2 border-dashed border-slate-300 bg-slate-100/70 px-1 py-0.5"
                title="Demo-only control: switches the customer-zone language (chrome + sample questions)"
              >
                {(["en", "fr"] as const).map((l) => (
                  <button
                    key={l}
                    onClick={() => setUiLang(l)}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase transition ${
                      uiLang === l ? "bg-ink text-white" : "text-ink-faint hover:bg-white hover:text-ink-soft"
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </span>
              <span className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-100/70 p-1" title="Demo-only control: switches the panel's perspective; in production the session comes from the banking-app login">
                <button
                  onClick={() => setSignedOut(true)}
                  className="rounded-lg bg-white px-3.5 py-1.5 text-xs font-semibold text-ink-faint ring-1 ring-line transition hover:bg-canvas hover:text-ink-soft"
                >
                  View as signed-out visitor
                </button>
              </span>
              </span>
            </div>
          )}

          {/* Chat pane */}
          <section className="relative flex min-h-[560px] flex-1 flex-col rounded-2xl border border-line bg-card shadow-card">
          {messages.length > 0 ? (
            <span
              className="absolute left-3 top-3 z-10 rounded-xl border-2 border-dashed border-slate-300 bg-slate-100/70 p-1"
              title="Demo-only control: clears the conversation and starts a fresh session"
            >
              <button
                onClick={clearChat}
                aria-label="Clear conversation"
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-white text-ink-faint ring-1 ring-line transition hover:bg-canvas hover:text-ink-soft"
              >
                <IconTrash className="h-3.5 w-3.5" />
              </button>
            </span>
          ) : null}
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-5" style={{ maxHeight: "62vh" }}>
            {/* In-chat AI disclosure - quiet, at the conversation start, where the interaction happens */}
            {!outage ? (
              <div className="flex items-center justify-center gap-1.5 text-xs text-ink-faint">
                <IconWave className="h-3.5 w-3.5 text-accent" />
                <span>{t("You're chatting with an AI assistant", "Vous échangez avec un assistant IA")}</span>
              </div>
            ) : null}

            {outage ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                  <IconAlert className="h-4 w-4" /> {t("Assistant running in basic mode", "Assistant en mode basique")}
                </div>
                <p className="mt-1 text-xs text-amber-700">
                  {t(
                    "Some features are temporarily limited. You can still browse frequent questions, lock your card, and reach an advisor with one tap.",
                    "Certaines fonctionnalités sont temporairement limitées. Vous pouvez toujours consulter les questions fréquentes, bloquer votre carte et joindre un conseiller en un geste.",
                  )}
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {faqs.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => skeletonPost(f.question, { action: "faq", chunkId: f.chunkId })}
                      disabled={loading}
                      className="rounded-xl border border-amber-200 bg-white px-3 py-2 text-left text-xs font-medium text-ink-soft hover:bg-amber-50 disabled:opacity-50"
                    >
                      {f.question}
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => skeletonPost("Lock my card", { action: "lock" })}
                    disabled={loading}
                    className="rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
                  >
                    {t("Lock my card", "Bloquer ma carte")}
                  </button>
                  {/* "Talk to an advisor" is now the persistent control below the composer,
                      the same one shown in normal mode - not duplicated here. */}
                </div>
              </div>
            ) : null}

            {messages.length === 0 && !outage ? (
              <div className="mx-auto mt-10 max-w-md text-center">
                <p className="text-base font-medium text-ink">{t("Ask a question, check your balance, or lock a card. Anytime, answers in seconds.", "Posez une question, consultez votre solde ou bloquez une carte. À tout moment, une réponse en quelques secondes.")}</p>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {(moderationChips ? MODERATION_SUGGESTIONS : uiLang === "fr" ? SUGGESTIONS_FR : SUGGESTIONS).map((s) => {
                    // The unlock chip (T2) is the one that opens the SCA / Clé digitale
                    // approval modal. Flag it with the dashed demo-instrumentation pill so
                    // a first-time visitor knows this chip is the way to test that flow.
                    const isSca = /unlock|débloqu/i.test(s);
                    return (
                      <button
                        key={s}
                        onClick={() => send(s)}
                        className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-xs text-ink-soft hover:bg-canvas"
                      >
                        {s}
                        {isSca ? (
                          <span
                            className="rounded-full border-2 border-dashed border-slate-300 bg-slate-100/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-ink-faint"
                            title="Clicking this triggers the Strong Customer Authentication flow: the Clé digitale approval modal (unlocking is T2 and always requires in-app approval)."
                          >
                            SCA
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>

                {/* Chip-content toggle - lives next to the chips it swaps, not in the
                    control deck (those simulate environment states; this selects content).
                    The label names what clicking switches TO. */}
                <button
                  onClick={() => setModerationChips((v) => !v)}
                  className="mx-auto mt-4 flex w-fit items-center gap-1.5 rounded-full border-2 border-dashed border-slate-300 bg-slate-100/70 px-3 py-1.5 text-xs text-ink-soft hover:bg-slate-100"
                  title="Demo-only control: swaps the sample questions for green / orange / red moderation trigger utterances (pass · de-escalate-and-serve · refuse). Moderation itself is always on."
                >
                  <span aria-hidden>⇄</span>
                  {moderationChips ? "Show everyday questions" : "Show moderation test questions"}
                </button>
              </div>
            ) : null}

            {messages.map((m) => (
              <MessageRow
                key={m.id}
                m={m}
                lang={uiLang}
                onActionOffer={(action) =>
                  skeletonPost(
                    action === "lock_card" ? t("Lock my card", "Bloquer ma carte") : t("Unlock my card", "Débloquer ma carte"),
                    { action: action === "lock_card" ? "lock" : "unlock", source: "offer" },
                  )
                }
                actionUi={m.pending ? actions[m.pending.requestId] : undefined}
                onSelect={(cardId) =>
                  m.pending &&
                  setActions((prev) => ({
                    ...prev,
                    [m.pending!.requestId]: { ...prev[m.pending!.requestId], selectedCardId: cardId },
                  }))
                }
                onApprove={() => m.pending && onConfirmTap(m.pending)}
                onRetry={() => m.pending && onConfirmTap(m.pending)}
                onCancel={() =>
                  m.pending &&
                  setActions((prev) => ({
                    ...prev,
                    [m.pending!.requestId]: { ...prev[m.pending!.requestId], phase: "cancelled" },
                  }))
                }
              />
            ))}

            {loading ? (
              <div className="flex items-center gap-2 text-sm text-ink-faint">
                <span className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:-0.2s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:-0.1s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-accent" />
              </div>
            ) : null}
          </div>

          {/* Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 border-t border-line p-3"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={outage}
              placeholder={outage ? t("Free-text assistant is offline. Use the basic-mode options above", "L'assistant en texte libre est hors ligne. Utilisez les options du mode basique ci-dessus") : t("Type a message…", "Écrivez un message…")}
              className="flex-1 rounded-xl border border-line bg-white px-4 py-3 text-base text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent-ring disabled:bg-canvas disabled:text-ink-faint"
            />
            <button
              type="submit"
              disabled={loading || outage || !input.trim()}
              className="rounded-xl bg-accent px-5 py-3 text-base font-semibold text-white transition hover:bg-accent/90 disabled:opacity-40"
            >
              {t("Send", "Envoyer")}
            </button>
          </form>
          {/* Handoff confirm card - handoff is an ACTION, so it gets a confirm step, the
              same pattern as the transaction confirm card. Support hours are STATES, not
              GATES: the tap always works; out-of-hours the card switches to async intake
              with a reply-by promise + the 24/7 emergency line. */}
          {handoffConfirm ? (
            <div className="border-t border-line px-3 py-3">
              <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 shadow-card">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                    <IconUser className="h-4.5 w-4.5" />
                  </span>
                  <div className="text-sm font-semibold text-ink">
                    {/* An empty chat has no conversation to send - the copy must not
                        claim a payload that doesn't exist. */}
                    {messages.length === 0
                      ? t("Contact an advisor?", "Contacter un conseiller ?")
                      : outOfHours
                        ? t("Send this conversation to an advisor?", "Envoyer cette conversation à un conseiller ?")
                        : t("Hand this conversation to an advisor?", "Transmettre cette conversation à un conseiller ?")}
                  </div>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-ink-soft">
                  {outOfHours ? (
                    <>
                      {t("Advisors are back", "Les conseillers sont de retour")} <span className="font-semibold">{nextOpen}</span>
                      {messages.length === 0
                        ? t(
                            ". You can write your question first so they have context, or send the request as is. For a lost or stolen card, the emergency line is available 24/7.",
                            ". Vous pouvez d'abord écrire votre question pour leur donner du contexte, ou envoyer la demande telle quelle. Pour une carte perdue ou volée, la ligne d'urgence est disponible 24h/24 et 7j/7.",
                          )
                        : t(
                            ". Send this conversation now and an advisor will reply then. For a lost or stolen card, the emergency line is available 24/7.",
                            ". Envoyez cette conversation maintenant et un conseiller vous répondra à ce moment-là. Pour une carte perdue ou volée, la ligne d'urgence est disponible 24h/24 et 7j/7.",
                          )}
                    </>
                  ) : messages.length === 0 ? (
                    <>
                      {t("You can write your question first so they have context. Estimated wait", "Vous pouvez d'abord écrire votre question pour leur donner du contexte. Attente estimée")}{" "}
                      <span className="font-semibold">~4 min</span> {t("(estimate).", "(estimation).")}
                    </>
                  ) : (
                    <>
                      {t("They'll see everything above. Estimated wait", "Le conseiller verra tout l'historique ci-dessus. Attente estimée")}{" "}
                      <span className="font-semibold">~4 min</span> {t("(estimate).", "(estimation).")}
                    </>
                  )}
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => {
                      setHandoffConfirm(false);
                      talkToAdvisor();
                    }}
                    className="flex-1 rounded-xl bg-accent py-2.5 text-sm font-semibold text-white transition hover:bg-accent/90 active:scale-[0.99]"
                  >
                    {outOfHours ? t("Send to advisor", "Envoyer au conseiller") : t("Hand over", "Transmettre")}
                  </button>
                  <button
                    onClick={() => setHandoffConfirm(false)}
                    className="rounded-xl border border-line bg-white px-4 py-2.5 text-sm font-medium text-ink-soft hover:bg-canvas"
                  >
                    {t("Keep chatting", "Continuer la discussion")}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* Persistent advisor control - a quiet, always-visible control pinned to the
              composer. Tap opens the handoff confirm card. It is NEVER disabled/greyed:
              the promise changes with support hours, but the tap always works. In-hours
              it reads "Talk to an advisor"; out-of-hours "Message an advisor - reply by
              {nextOpen}". This is what makes the disclosure line ("a human is one tap
              away") literally true - at any hour. */}
          <div className="flex items-center justify-center gap-1.5 border-t border-line px-3 py-2">
            <button
              onClick={() => setHandoffConfirm(true)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-faint underline-offset-2 transition hover:text-accent hover:underline"
            >
              <IconUser className="h-3.5 w-3.5" />
              {outOfHours ? t(`Message an advisor (reply by ${nextOpen})`, `Écrire à un conseiller (réponse ${nextOpen})`) : t("Talk to an advisor", "Parler à un conseiller")}
            </button>
          </div>
          </section>
        </div>
        {/* ===== end LEFT ZONE (customer product) ===== */}

        {/* ============================================================= */}
        {/* RIGHT ZONE - demo instrumentation. Visually distinct rail.    */}
        {/* Not part of the customer product.                             */}
        {/* ============================================================= */}
        <aside className="flex flex-col gap-4 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-100/70 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/scorecard"
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-ink-soft ring-1 ring-line hover:bg-canvas"
            >
              <IconDoc className="h-4 w-4" /> Eval scorecard
            </Link>
            <Link
              href="/boundaries"
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-ink-soft ring-1 ring-line hover:bg-canvas"
            >
              <IconShield className="h-4 w-4" /> Routes &amp; limits
            </Link>
          </div>

          {/* Demo controls - a fixed strip ABOVE both instrument columns. Controls
              must not move when the instruments below them grow (the trace expands
              per turn); a stable control deck reads as operated, not hunted for. */}
          <div className="rounded-2xl border border-line bg-white px-3.5 py-2 shadow-card">
            {/* Micro-label above its own row - sharing the row with the toggles made
                the third one wrap alone at common widths. */}
            <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">Demo controls</div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
              {(
                [
                  {
                    label: "LLM outage",
                    checked: outage,
                    onChange: (v: boolean) => (v ? enterOutage() : setOutage(false)),
                    tip: "No Mistral calls at all: the same chat surface degrades to the deterministic skeleton: verbatim FAQ, card-lock, human routing. The front door never goes dark.",
                  },
                  {
                    label: "SCA timeout",
                    checked: scaTimeout,
                    onChange: setScaTimeout,
                    tip: "Applies to the next in-app approval: it drops signal and lands in an explicit pending state, never a false success. Trigger one with \u201cUnlock my Visa ending in 4471\u201d (unlocking always requires in-app approval).",
                  },
                  {
                    label: "Out of hours",
                    checked: outOfHours,
                    onChange: setOutOfHours,
                    tip: "Advisors offline: the human route switches to async intake with a reply-by promise; the fraud line stays 24/7.",
                  },
                ] as const
              ).map((c) => (
                <span
                  key={c.label}
                  className={`flex items-center gap-1.5 py-1 text-xs ${
                    c.checked ? "font-semibold text-amber-700" : "text-ink-soft"
                  }`}
                >
                  <input
                    id={`demo-${c.label}`}
                    type="checkbox"
                    checked={c.checked}
                    onChange={(e) => c.onChange(e.target.checked)}
                    className="h-4 w-4 cursor-pointer accent-amber-600"
                  />
                  <label htmlFor={`demo-${c.label}`} className="cursor-pointer">
                    {c.label}
                  </label>
                  {/* instant tooltip - CSS hover, no OS title delay; opens DOWNWARD
                      because this strip sits at the top of the rail */}
                  <span className="group relative flex items-center">
                    <span className="flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-canvas font-mono text-[10px] font-semibold text-ink-faint ring-1 ring-line group-hover:text-ink-soft">
                      ?
                    </span>
                    <span className="pointer-events-none invisible absolute left-1/2 top-full z-30 mt-2 w-60 -translate-x-1/2 rounded-lg bg-slate-800 p-2.5 text-[11px] font-normal leading-relaxed text-slate-100 shadow-lg group-hover:visible">
                      {c.tip}
                      <span className="absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-slate-800" />
                    </span>
                  </span>
                </span>
              ))}
            </div>
          </div>

          {/* Two instrumentation columns: decisions (trace) | record (audit).
              With the chat this makes the pipeline spatial: what the customer sees →
              what the system decided → what got recorded. */}
          <div className="grid min-h-0 flex-1 items-start gap-4 xl:grid-cols-2">
            <TracePanel trace={trace} turn={turn} outage={outage} />
            <AuditPanel entries={audit} />
          </div>
        </aside>
        {/* ===== end RIGHT ZONE (demo instrumentation) ===== */}
      </div>

      {/* Footer - the legend only: it decodes the dashed-border convention, which a
          first-time viewer can't otherwise know is meaningful. No disclosure text -
          the page is self-evidently a demo, and the deployment story (same open
          weights on the customer's infrastructure) is a spoken answer when
          challenged (see demo-script operator notes). */}
      <footer className="mt-6 flex justify-end border-t border-line pt-4 text-xs text-ink-faint">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded border-2 border-dashed border-slate-300 bg-slate-100/70" />
          dashed = demo instrumentation, not part of the product
        </span>
      </footer>

      {sca ? (
        <ScaModal
          open={sca.open}
          lang={uiLang}
          actionLabel={sca.actionLabel}
          cardLabel={sca.cardLabel}
          status={sca.status}
          onApprove={runScaApprove}
          onClose={() => setSca((s) => (s ? { ...s, open: false } : s))}
        />
      ) : null}
    </div>
  );
}

function MessageRow({
  m,
  actionUi,
  onSelect,
  onApprove,
  onCancel,
  onRetry,
  onActionOffer,
  lang = "en",
}: {
  m: UiMessage;
  actionUi?: ActionUi;
  onSelect: (cardId: string) => void;
  onApprove: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onActionOffer?: (action: "lock_card" | "unlock_card") => void;
  lang?: "en" | "fr";
}) {
  const t = (en: string, frUi: string) => (lang === "fr" ? frUi : en);
  if (m.role === "user") {
    return (
      <div className="flex justify-end fade-up">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-base text-white">{m.text}</div>
      </div>
    );
  }

  const a = m.assistant;
  const kind = a?.kind ?? "answer";
  const accentBar =
    kind === "escalation" || kind === "refusal"
      ? "border-amber-200 bg-amber-50/50"
      : kind === "complaint-route"
        ? "border-indigo-200 bg-indigo-50/40"
        : kind === "balance"
          ? "border-sky-200 bg-sky-50/40"
          : "border-line bg-white";

  return (
    <div className="flex justify-start fade-up">
      <div className={`max-w-[88%] rounded-2xl rounded-bl-sm border px-4 py-3 shadow-card ${accentBar}`}>
        {kind === "escalation" ? (
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-amber-700">
            <IconAlert className="h-4 w-4" />
            {a?.priority ? t("Priority: connecting you to an advisor", "Prioritaire : mise en relation avec un conseiller") : t("Connecting you to an advisor", "Mise en relation avec un conseiller")}
          </div>
        ) : null}

        {kind === "complaint-route" ? (
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-indigo-700">
            <IconDoc className="h-4 w-4" />
            Réclamation (formal complaint)
          </div>
        ) : null}

        <p className="text-base leading-relaxed text-ink">{m.text}</p>

        {a?.complaintRoute ? (
          <div className="mt-3 rounded-xl border border-indigo-200 bg-white p-3.5">
            <a
              href={a.complaintRoute.formHref}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
            >
              <IconDoc className="h-4 w-4" />
              {a.complaintRoute.formLabel}
            </a>
            <p className="mt-2.5 text-xs leading-relaxed text-ink-soft">
              {t(
                "The form is the official record; it starts the response clock the moment you submit. If you'd rather talk it through first, an advisor is one tap away.",
                "Le formulaire est le document officiel ; il déclenche le délai de réponse dès l'envoi. Si vous préférez d'abord en parler, un conseiller est à un geste.",
              )}
            </p>
          </div>
        ) : null}

        {a?.balance ? (
          <div className="mt-3 rounded-xl border border-sky-200 bg-white p-3">
            <div className="text-xs text-ink-faint">{a.balance.holder} · {a.balance.iban}</div>
            <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink">
              €{a.balance.balance.toLocaleString("en-IE", { minimumFractionDigits: 2 })}
            </div>
          </div>
        ) : null}

        {a?.transactions && a.transactions.length > 0 ? (
          <div className="mt-3 rounded-xl border border-sky-200 bg-white p-3">
            <ul className="divide-y divide-line">
              {a.transactions.map((t, i) => (
                <li key={i} className="flex items-center justify-between gap-3 py-1.5 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-ink">{t.description}</div>
                    <div className="text-[11px] text-ink-faint">{t.date}</div>
                  </div>
                  <div className={`shrink-0 text-sm font-semibold tabular-nums ${t.amount > 0 ? "text-emerald-600" : "text-ink"}`}>
                    {t.amount > 0 ? "+" : "−"}€{Math.abs(t.amount).toLocaleString("en-IE", { minimumFractionDigits: 2 })}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {a?.citations && a.citations.length > 0 ? (
          <div className="mt-3">
            {/* The primary source is a full article card: the answer is a summary,
                the official help article is the destination we nudge toward. */}
            {a.citations.slice(0, 1).map((c) => (
              <a
                key={c.id}
                href={c.url}
                target="_blank"
                rel="noreferrer"
                title={`${c.url} · similarity ${c.score.toFixed(2)}`}
                className="group flex items-center gap-3 rounded-xl border border-line bg-white px-3.5 py-2.5 transition hover:border-accent hover:bg-accent-soft"
              >
                <IconDoc className="h-5 w-5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                    {t("Official help article", "Article d'aide officiel")}
                  </span>
                  <span className="block truncate text-sm font-semibold text-ink group-hover:text-accent">{c.title}</span>
                </span>
                <span className="shrink-0 text-xs font-medium text-accent">
                  {t("Read the article →", "Lire l'article →")}
                </span>
              </a>
            ))}
            {a.citations.length > 1 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <span className="py-1 text-xs text-ink-faint">{t("Also cited:", "Également cité :")}</span>
                {a.citations.slice(1).map((c) => (
                  <a
                    key={c.id}
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent-soft"
                    title={`${c.url} · similarity ${c.score.toFixed(2)}`}
                  >
                    <IconLink className="h-3.5 w-3.5" />
                    {c.title}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {(a?.transcriptCarry || a?.queuePosition) && kind !== "balance" ? (
          <div className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-xs text-ink-soft ring-1 ring-line">
            {a?.queuePosition ? <span className="font-semibold">{t(`You're #${a.queuePosition} in queue. `, `Vous êtes n°${a.queuePosition} dans la file. `)}</span> : null}
            {a?.transcriptCarry}
          </div>
        ) : null}

        {/* Deterministic action affordance - code-generated from the route (fraud route)
            or the top cited chunk's relatedAction tag. The model never writes offers;
            the tap enters the same confirm/SCA path as a typed request. */}
        {a?.actionOffer && onActionOffer ? (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2.5">
            <span className="text-xs font-medium text-emerald-900">
              {t("I can do this for you right here.", "Je peux le faire pour vous ici même.")}
            </span>
            <button
              onClick={() => onActionOffer(a.actionOffer!)}
              className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700"
            >
              {a.actionOffer === "lock_card" ? t("Lock my card", "Bloquer ma carte") : t("Unlock my card", "Débloquer ma carte")}
            </button>
          </div>
        ) : null}

        {m.pending && actionUi ? (
          <ConfirmCard
            pending={m.pending}
            selectedCardId={actionUi.selectedCardId}
            phase={actionUi.phase}
            receipt={actionUi.receipt}
            idempotentNote={actionUi.idempotentNote}
            onSelect={onSelect}
            onApprove={onApprove}
            onCancel={onCancel}
            onRetry={onRetry}
            lang={lang}
          />
        ) : null}
      </div>
    </div>
  );
}
