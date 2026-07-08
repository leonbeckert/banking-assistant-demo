// In-memory session store. Single-process demo => a module-level singleton is
// correct and keeps the "one process = whole demo" promise. Attached to
// globalThis so Next.js dev HMR does not wipe state between hot reloads.
import type { Account, AuditEntry, Card, ExecutionResult, PendingAction, Transaction } from "./types";

export interface SessionState {
  sessionId: string;
  account: Account;
  cards: Card[];
  transactions: Transaction[];
  audit: AuditEntry[];
  auditSeq: number;
  pending: Map<string, PendingAction>;
  executed: Map<string, ExecutionResult>; // idempotency ledger, keyed by requestId
  inflight: Map<string, Promise<ExecutionResult>>; // in-progress executes, for double-tap dedup
}

function freshState(sessionId: string): SessionState {
  return {
    sessionId,
    // Reconciled with prototype-assets/mock-fixtures.json (customer Camille Moreau).
    account: {
      id: "acc_current_001",
      holder: "Camille Moreau",
      iban: "FR76 •••• •••• •••• •••• 0071",
      balance: 2847.63,
      available: 2847.63,
      currency: "EUR",
    },
    cards: [
      { id: "card-4471", brand: "Visa", last4: "4471", label: "Visa •••• 4471", status: "active" },
      { id: "card-8832", brand: "Visa", last4: "8832", label: "Visa •••• 8832", status: "active" },
    ],
    // Reconciled with prototype-assets/mock-fixtures.json (transactions array, most
    // recent first). Read-only account data (T0) - surfaced, never mutated.
    transactions: [
      { id: "txn_0001", date: "2026-07-03", description: "SNCF Connect", amount: -68.40, currency: "EUR" },
      { id: "txn_0002", date: "2026-07-02", description: "Monoprix Paris 11", amount: -42.17, currency: "EUR" },
      { id: "txn_0003", date: "2026-07-01", description: "Virement reçu - Salaire", amount: 2650.00, currency: "EUR" },
      { id: "txn_0004", date: "2026-06-30", description: "EDF Prélèvement", amount: -74.90, currency: "EUR" },
      { id: "txn_0005", date: "2026-06-29", description: "Boulangerie Julien", amount: -8.30, currency: "EUR" },
    ],
    audit: [],
    auditSeq: 0,
    pending: new Map(),
    executed: new Map(),
    inflight: new Map(),
  };
}

type Store = { sessions: Map<string, SessionState> };

const g = globalThis as unknown as { __retailDemoStore?: Store };
if (!g.__retailDemoStore) {
  g.__retailDemoStore = { sessions: new Map() };
}
const store = g.__retailDemoStore;

export function getSession(sessionId: string): SessionState {
  let s = store.sessions.get(sessionId);
  if (!s) {
    s = freshState(sessionId);
    store.sessions.set(sessionId, s);
  }
  return s;
}

export function resetSession(sessionId: string): SessionState {
  const s = freshState(sessionId);
  store.sessions.set(sessionId, s);
  return s;
}
