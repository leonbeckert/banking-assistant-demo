// Shared types for the deterministic engine and the assistant layer.
// NOTE: this file (and everything in /engine) is PLAIN DETERMINISTIC CODE.
// No LLM call is ever made from /engine. That boundary is the whole point.

export type RouteLevel = 1 | 2 | 3;
export type Tier = "T0" | "T1" | "T2" | "T3";

export type Intent =
  | "faq"
  | "account_read"
  | "lock_card"
  | "unlock_card"
  | "transfer"
  | "fraud_distress"
  | "complaint"
  | "human_request"
  | "out_of_scope"
  | "other";

// Human-facing names for the intents - the audit log and trace panel must be
// readable without background knowledge (enum values stay in detail objects).
export const INTENT_WORDS: Record<Intent, string> = {
  faq: "product / how-to question",
  account_read: "account balance or transactions request",
  lock_card: "card lock request",
  unlock_card: "card unlock request",
  transfer: "money transfer request",
  fraud_distress: "possible fraud / distress",
  complaint: "formal complaint (réclamation) filing",
  human_request: "explicit ask for a human",
  out_of_scope: "advice topic the assistant must not attempt",
  other: "unclassified",
};

export interface GateDecision {
  intent: Intent;
  // Only when intent === "account_read": which T0 read the customer wants.
  // A route-internal display choice (identical controls either way), decided by
  // the same gate call - no extra model call, gold-set-labeled like the intent.
  readTarget?: "balance" | "transactions";
  riskFlags: string[]; // e.g. ["fraud_distress", "vulnerability"]
  language: "en" | "fr" | "de" | "other";
  rationale?: string;
  model: string; // gate model id - shown in trace
}

// Deterministic routing derived from the gate decision by /engine/policy.ts
export interface Route {
  level: RouteLevel;
  routeLabel: string;
  tier: Tier | null;
  action: "answer" | "refuse" | "escalate" | "balance_read" | "card_action" | "transfer_stub" | "complaint_route";
  requiresConfirm: boolean;
  requiresSca: boolean;
}

export interface Card {
  id: string;
  brand: string; // "Visa"
  last4: string; // "4471"
  label: string; // "Visa •••• 4471"
  status: "active" | "locked";
}

export interface Account {
  id: string;
  holder: string;
  iban: string;
  balance: number; // EUR
  currency: "EUR";
  available: number;
}

// A booked transaction on the current account. Read-only account data (T0):
// surfaced by readTransactions, never mutated. Reconciled with the customer's
// balance in prototype-assets/mock-fixtures.json.
export interface Transaction {
  id: string;
  date: string; // ISO date, e.g. "2026-07-03"
  description: string;
  amount: number; // EUR - negative = debit, positive = credit (e.g. salary)
  currency: "EUR";
}

export type AuditType =
  | "moderation"
  | "gate_decision"
  | "route"
  | "session_boundary"
  | "retrieval"
  | "answer"
  | "refusal"
  | "escalation"
  | "de_escalation"
  | "complaint_route"
  | "balance_read"
  | "transactions_read"
  | "tool_call"
  | "confirm_issued"
  | "confirmed"
  | "confirm_bypass_blocked"
  | "sca_started"
  | "sca_approved"
  | "sca_timeout"
  | "bank_execute"
  | "idempotent_suppressed"
  | "transfer_stub";

export interface AuditEntry {
  seq: number;
  ts: string; // ISO
  requestId: string;
  sessionId: string;
  type: AuditType;
  summary: string;
  detail: Record<string, unknown>;
}

// A confirmed-but-not-yet-executed action, keyed by requestId (idempotency anchor).
export interface PendingAction {
  requestId: string;
  sessionId: string;
  intent: Extract<Intent, "lock_card" | "unlock_card">;
  tier: Tier;
  cardId: string; // selected from the REAL list - never generated
  requiresSca: boolean;
  language?: "en" | "fr" | "de" | "other"; // customer language at prepare time - receipts follow it
  createdAt: string;
  confirmed: boolean; // server-side state: an execute is refused until the confirm
                      // interaction has posted back and flipped this to true. A raw
                      // execute on an unconfirmed pending (e.g. a stolen requestId
                      // replayed via curl) never runs.
}

export interface ExecutionResult {
  status: "success" | "pending" | "failed";
  requestId: string;
  idempotent: boolean; // true if this requestId was already executed (dedup)
  message: string;
  card?: Card;
  receipt?: {
    reference: string;
    action: string;
    card: string;
    ts: string;
  };
}
