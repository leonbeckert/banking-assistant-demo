// Mock bank API - the deterministic transaction engine.
// This is the "not-an-agent" boundary: NO LLM call is EVER made here.
// It resolves the customer's real entities, enforces idempotency, and commits
// state changes only after SCA has completed. The model can never reach past it.
import { appendAudit } from "./audit";
import { getSession } from "./store";
import type { Account, Card, ExecutionResult, PendingAction, Transaction } from "./types";

const SCA_LATENCY_MS = 450; // simulated round-trip to the bank

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Reads -----------------------------------------------------------------

export function getCards(sessionId: string): Card[] {
  return getSession(sessionId).cards;
}

export function getCardById(sessionId: string, cardId: string): Card | undefined {
  return getSession(sessionId).cards.find((c) => c.id === cardId);
}

// Resolve the customer's REAL card list. The model selects from this - it never
// generates a card identifier. If the user named a "last 4" hint, we match it
// against the real list; a hint that matches nothing is ignored (no fabrication).
export function resolveCards(sessionId: string, hint?: string): { cards: Card[]; matchedId?: string } {
  const cards = getSession(sessionId).cards;
  let matchedId: string | undefined;
  if (hint) {
    const digits = hint.replace(/\D/g, "").slice(-4);
    const hit = cards.find((c) => c.last4 === digits);
    if (hit) matchedId = hit.id;
  }
  return { cards, matchedId };
}

// T0 authenticated read - no confirm step, fully logged.
export function readBalance(sessionId: string, requestId: string): Account {
  const acct = getSession(sessionId).account;
  appendAudit(sessionId, requestId, "balance_read", "account balance read - signed-in session, no confirmation needed", {
    tier: "T0",
    account: acct.id,
    balance: acct.balance,
    currency: acct.currency,
  });
  return acct;
}

// T0 authenticated read - recent transactions. Same tier as readBalance: account
// data, zero mutation, so no confirm step. Fully logged, like every account read.
export function readTransactions(sessionId: string, requestId: string): Transaction[] {
  const txns = getSession(sessionId).transactions;
  appendAudit(sessionId, requestId, "transactions_read", "recent transactions read - signed-in session, no confirmation needed", {
    tier: "T0",
    count: txns.length,
    currency: "EUR",
  });
  return txns;
}

// ---- Pending action lifecycle ---------------------------------------------

export function createPending(action: PendingAction): void {
  const s = getSession(action.sessionId);
  s.pending.set(action.requestId, action);
  appendAudit(action.sessionId, action.requestId, "confirm_issued", `confirmation card shown for the ${action.intent === "lock_card" ? "card lock" : "card unlock"} - nothing executes until the customer confirms`, {
    tier: action.tier,
    cardId: action.cardId,
    requiresSca: action.requiresSca,
  });
}

export function getPending(sessionId: string, requestId: string): PendingAction | undefined {
  return getSession(sessionId).pending.get(requestId);
}

// Server-side confirm transition. The confirm interaction (the "Confirm" / "Approve
// on device" tap) posts back here BEFORE any execute is allowed to run. This is the
// state gate that makes a stolen requestId inert: an execute on a pending that was
// never confirmed is refused (see doExecute), so a raw curl replay cannot commit.
export function confirmPending(sessionId: string, requestId: string): boolean {
  const s = getSession(sessionId);
  const pending = s.pending.get(requestId);
  if (!pending) return false;
  if (!pending.confirmed) {
    pending.confirmed = true;
    appendAudit(sessionId, requestId, "confirmed", `customer confirmed the ${pending.intent === "lock_card" ? "card lock" : "card unlock"}`, {
      tier: pending.tier,
      cardId: pending.cardId,
    });
  }
  return true;
}

// ---- Execution (idempotent, SCA-gated, never false-confirm) ----------------

// The synchronous reservation is the whole trick: a duplicate call sees either
// the sealed result (already committed) or the in-flight promise (still running)
// BEFORE the first call's first `await`, so two rapid taps can never both commit.
export function executeAction(
  sessionId: string,
  requestId: string,
  opts: { simulateScaTimeout?: boolean; selectedCardId?: string } = {},
): Promise<ExecutionResult> {
  const s = getSession(sessionId);

  // Honour the customer's card selection from the confirm step - but only if it
  // is one of THEIR real cards (validated against the retrieved list). The model
  // never generates an identifier; the engine never trusts one it didn't issue.
  const pendingForSelect = s.pending.get(requestId);
  if (pendingForSelect && opts.selectedCardId && !s.executed.has(requestId)) {
    const valid = s.cards.some((c) => c.id === opts.selectedCardId);
    if (valid) pendingForSelect.cardId = opts.selectedCardId;
  }

  // Already committed? Return the same result - three taps is still one lock.
  const prior = s.executed.get(requestId);
  if (prior) {
    appendAudit(sessionId, requestId, "idempotent_suppressed", "duplicate tap suppressed - idempotency key already used, the action ran exactly once", {
      priorStatus: prior.status,
    });
    return Promise.resolve({ ...prior, idempotent: true });
  }

  // Currently executing? Attach to the same in-flight promise; do not start a second.
  const running = s.inflight.get(requestId);
  if (running) {
    return running.then((r) => {
      appendAudit(sessionId, requestId, "idempotent_suppressed", "concurrent duplicate suppressed - the same action is already in flight", {
        priorStatus: r.status,
      });
      return { ...r, idempotent: true };
    });
  }

  const p = doExecute(s, sessionId, requestId, opts);
  s.inflight.set(requestId, p);
  return p.finally(() => s.inflight.delete(requestId));
}

async function doExecute(
  s: ReturnType<typeof getSession>,
  sessionId: string,
  requestId: string,
  opts: { simulateScaTimeout?: boolean },
): Promise<ExecutionResult> {
  const pending = s.pending.get(requestId);
  if (!pending) {
    return { status: "failed", requestId, idempotent: false, message: "No pending action for this request ID." };
  }

  // SERVER-SIDE CONFIRM ENFORCEMENT. Execution requires the confirm interaction to
  // have posted back and flipped `confirmed` (see confirmPending). An execute on an
  // unconfirmed pending - e.g. a stolen requestId replayed straight to /api/action -
  // is refused here, before any SCA or state change, and audited. The requestId
  // alone is not a capability; the confirm click is.
  if (!pending.confirmed) {
    appendAudit(sessionId, requestId, "confirm_bypass_blocked", "execute refused - the customer never confirmed this action", {
      tier: pending.tier,
      cardId: pending.cardId,
      note: "requestId replay without the confirm click - a stolen id cannot execute",
    });
    return {
      status: "failed",
      requestId,
      idempotent: false,
      message: "This action was not confirmed. Nothing was changed. Confirm the action in the app before it can run.",
    };
  }

  // SCA is ONLY run for actions that require it (security-increasing: unlock T2,
  // money-moving T3). A protective T1 lock is reached by a single one-tap confirm
  // and never touches the strong-auth surface - so it emits NO sca_* events, and
  // the audit for a lock shows: … → confirmed → bank_execute (no SCA pair). This
  // asymmetry is the whole point: lock reduces fraud risk (one confirm), unlock
  // increases it (fresh SCA).
  if (pending.requiresSca) {
    // SCA happens OUTSIDE the model, on the bank's native approval surface.
    appendAudit(sessionId, requestId, "sca_started", "in-app approval push sent to the registered device (Clé digitale)", {
      tier: pending.tier,
      cardId: pending.cardId,
    });

    await delay(SCA_LATENCY_MS);

    if (opts.simulateScaTimeout) {
      // Nothing changes until SCA completes. Explicit pending/failed - never a false success.
      appendAudit(sessionId, requestId, "sca_timeout", "in-app approval timed out - nothing changed, action left pending", {
        tier: pending.tier,
        cardId: pending.cardId,
      });
      const result: ExecutionResult = {
        status: "pending",
        requestId,
        idempotent: false,
        message: "Strong authentication timed out. Nothing was changed - you can retry.",
      };
      // NOT written to the idempotency ledger: a timed-out action may be retried.
      return result;
    }

    appendAudit(sessionId, requestId, "sca_approved", "in-app approval given on the device (mock biometric)", {
      tier: pending.tier,
      cardId: pending.cardId,
    });
  }

  // Commit the state change - for a lock, straight after the one-tap confirm;
  // for an unlock/transfer, only after SCA has completed.
  const card = s.cards.find((c) => c.id === pending.cardId);
  if (!card) {
    return { status: "failed", requestId, idempotent: false, message: "Card not found." };
  }
  card.status = pending.intent === "lock_card" ? "locked" : "active";

  // Receipt copy follows the customer's language (captured at prepare time);
  // audit lines stay English - they're the operator surface, not the customer's.
  const frR = pending.language === "fr";
  const receipt = {
    reference: `RB-${requestId.slice(-8).toUpperCase()}`,
    action:
      pending.intent === "lock_card" ? (frR ? "Carte bloquée" : "Card locked") : frR ? "Carte débloquée" : "Card unlocked",
    card: card.label,
    ts: new Date().toISOString(),
  };

  appendAudit(sessionId, requestId, "bank_execute", `${pending.intent === "lock_card" ? "Card locked" : "Card unlocked"}: ${card.label}`, {
    tier: pending.tier,
    cardId: card.id,
    newStatus: card.status,
    reference: receipt.reference,
  });

  const result: ExecutionResult = {
    status: "success",
    requestId,
    idempotent: false,
    message: `${receipt.action}: ${card.label}.`,
    card,
    receipt,
  };
  s.executed.set(requestId, result); // seal the idempotency ledger
  return result;
}
