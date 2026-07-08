// Degraded "basic mode" entry point (L1.5 - Telmi absorption / DORA resilience).
// This route imports ONLY the deterministic engine + corpus - NEVER /assistant,
// NEVER the Mistral client. When the LLM is out, the SAME chat surface calls this
// instead: verbatim FAQ answers, the existing card-lock flow, and human routing.
// The point being demoed: the front door never goes dark, and it's the same door.
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { skeletonAnswer, skeletonFaqList } from "@/engine/skeleton";
import { appendAudit, getAudit } from "@/engine/audit";
import { createPending, resolveCards } from "@/engine/bank";
import { mockNow, nextOpening } from "@/engine/hours";
import type { TraceInfo } from "@/app/lib/contract";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ faqs: skeletonFaqList() });
}

export async function POST(req: Request) {
  const body = await req.json();
  const sessionId: string = body.sessionId || "demo-session";
  const action: string = body.action;
  const requestId = `req_${randomUUID().slice(0, 8)}`;
  // This endpoint has no gate, so language comes from the customer-zone chrome.
  const lang: "en" | "fr" = body.lang === "fr" ? "fr" : "en";
  const lz = (en: string, fr: string) => (lang === "fr" ? fr : en);
  // Who pressed the button: the basic-mode panel or an action chip on a normal
  // answer. Same deterministic flow either way - only the audit wording differs.
  const source: string = body.source === "offer" ? "Action chip" : "Basic mode";

  if (action === "faq") {
    const ans = skeletonAnswer(body.chunkId);
    if (!ans) return NextResponse.json({ error: "unknown chunk" }, { status: 400 });
    appendAudit(sessionId, requestId, "answer", "basic mode → verbatim corpus chunk (no model)", {
      chunkId: body.chunkId,
      mode: "degraded_skeleton",
    });
    return NextResponse.json({
      requestId,
      assistant: { kind: "answer", text: ans.text, citations: [ans.citation] },
      audit: getAudit(sessionId),
    });
  }

  if (action === "lock" || action === "unlock") {
    const isLock = action === "lock";
    const { cards } = resolveCards(sessionId);
    // Lock targets an active card, unlock a locked one - fall back to the first.
    const selectedCardId =
      (isLock ? cards.find((c) => c.status === "active") : cards.find((c) => c.status === "locked"))?.id ?? cards[0].id;
    const intent = isLock ? "lock_card" : "unlock_card";
    // Same tiers as the routing code: lock = T1 one-tap; unlock re-opens risk = T2 + SCA.
    const tier = isLock ? "T1" : "T2";
    const requiresSca = !isLock;
    appendAudit(sessionId, requestId, "route", `${source} → card ${isLock ? "lock: one-tap confirm" : "unlock: confirm + in-app approval"} (deterministic, no model)`, {
      level: 2,
      tier,
      source,
    });
    appendAudit(sessionId, requestId, "tool_call", `button tap → deterministic ${isLock ? "lock" : "unlock"} intent (no model)`, {
      action: intent,
      note: "button-triggered flow; never needed the LLM",
    });
    createPending({
      requestId,
      sessionId,
      intent,
      tier,
      cardId: selectedCardId,
      requiresSca,
      language: lang,
      createdAt: new Date().toISOString(),
      confirmed: false,
    });
    const trace: TraceInfo = {
      deterministic: true,
      intent,
      riskFlags: [],
      language: lang,
      rationale: "button tap",
      level: 2,
      routeLabel: isLock
        ? "card lock: one-tap confirm, no fresh strong auth"
        : "card unlock: confirm + in-app approval",
      routeEnum: isLock ? "lock_card" : "unlock_card",
      tier,
      gateModel: "none (deterministic)",
      conversationModel: "none (deterministic)",
      moderation: { line: "moderation: not run (button tap, no free text to screen)", routing: "off", flagged: [] },
    };
    return NextResponse.json({
      requestId,
      trace,
      assistant: {
        kind: "action-confirm",
        text: isLock
          ? lz(
              "I've prepared a lock on your card. Confirm the card below. Nothing changes until you do.",
              "J'ai préparé le blocage de votre carte. Confirmez la carte ci-dessous. Rien ne change tant que vous n'avez pas confirmé.",
            )
          : lz(
              "I've prepared an unlock on your card. For your security, unlocking needs a quick approval in your banking app.",
              "J'ai préparé le déblocage de votre carte. Pour votre sécurité, le déblocage nécessite une validation rapide dans votre application bancaire.",
            ),
      },
      pendingAction: {
        requestId,
        action: intent,
        tier,
        actionLabel: isLock ? lz("Lock card", "Verrouiller la carte") : lz("Unlock card", "Déverrouiller la carte"),
        requiresSca,
        cards,
        selectedCardId,
      },
      audit: getAudit(sessionId),
    });
  }

  if (action === "advisor") {
    // The "Hand over / Send to advisor" tap from the handoff confirm card. A DETERMINISTIC
    // Level 3 handoff on an explicit customer ask - NO model call, so it works identically
    // in normal mode and during an LLM outage (same front door in both states). Support
    // hours are STATES, not GATES: out-of-hours never disables the route, it switches the
    // promise to async intake with a reply-by time.
    const outOfHours: boolean = body.outOfHours === true;
    const now = mockNow(outOfHours);

    if (outOfHours) {
      const next = nextOpening(now);
      const reference = `H-${requestId.slice(-4).toUpperCase()}`;
      appendAudit(sessionId, requestId, "escalation", "explicit ask → advisor handoff, async intake (out-of-hours, deterministic, no model)", {
        explicitAsk: true,
        outOfHours: true,
        nextOpening: next,
        reference,
        mode: "deterministic_handoff_async",
        note: "Level 3 handoff on an explicit ask, advisors offline: conversation sent, reply-by promise; no LLM in the loop",
      });
      const trace: TraceInfo = {
        deterministic: true,
        intent: "human_request",
          riskFlags: [],
        language: "en",
        rationale: "explicit customer ask · advisors offline",
        level: 3,
        routeLabel: "human advisor: explicit ask · async reply (out-of-hours)",
        routeEnum: "human_handoff",
        tier: null,
        gateModel: "none (deterministic)",
        conversationModel: "none (deterministic)",
        moderation: { line: "moderation: off (deterministic handoff, no model call)", routing: "off", flagged: [] },
      };
      return NextResponse.json({
        requestId,
        trace,
        assistant: {
          kind: "escalation",
          priority: false,
          text: lz(
            `Your conversation has been sent. An advisor will reply by ${next}. Reference ${reference}.`,
            `Votre conversation a été transmise. Un conseiller vous répondra avant ${next}. Référence ${reference}.`,
          ),
          transcriptCarry: lz(
            "Your conversation is shared with the advisor. Nothing to repeat.",
            "Votre conversation est partagée avec le conseiller. Rien à répéter.",
          ),
        },
        audit: getAudit(sessionId),
      });
    }

    const queuePosition = 2; // from the mock queue (in-hours)
    appendAudit(sessionId, requestId, "escalation", "explicit ask → advisor handoff (deterministic, no model)", {
      explicitAsk: true,
      outOfHours: false,
      queuePosition,
      mode: "deterministic_handoff",
      note: "Level 3 handoff on an explicit ask: no LLM in the loop; works during an outage too",
    });
    const trace: TraceInfo = {
      deterministic: true,
      intent: "human_request",
      riskFlags: [],
      language: "en",
      rationale: "explicit customer ask",
      level: 3,
      routeLabel: "human advisor: explicit ask",
      routeEnum: "human_handoff",
      tier: null,
      gateModel: "none (deterministic)",
      conversationModel: "none (deterministic)",
      moderation: { line: "moderation: off (deterministic handoff, no model call)", routing: "off", flagged: [] },
    };
    return NextResponse.json({
      requestId,
      trace,
      assistant: {
        kind: "escalation",
        priority: false,
        queuePosition,
        text: lz(
          "An advisor is taking over. They can see this conversation, so you won't have to repeat anything.",
          "Un conseiller prend le relais. Il peut voir cette conversation, vous n'aurez donc rien à répéter.",
        ),
        transcriptCarry: lz(
          "Your conversation is shared with the advisor. Nothing to repeat.",
          "Votre conversation est partagée avec le conseiller. Rien à répéter.",
        ),
      },
      audit: getAudit(sessionId),
    });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
