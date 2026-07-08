// Shared request/response contract between the API routes and the UI.
import type { AuditEntry, Card, GateDecision, RouteLevel, Route, Tier } from "@/engine/types";
import { routeEnumFor, type RouteEnum } from "@/engine/policy";

export interface TraceInfo {
  // True when the turn came from a button tap running the deterministic engine
  // directly - no gate, no model. The trace panel renders a "no gate this turn"
  // notice instead of the decision grid (a fabricated confidence would be a lie).
  deterministic?: boolean;
  // True when severe input screening stopped the turn BEFORE the router - the
  // gate and every downstream model never ran this message.
  stoppedAtModeration?: boolean;
  intent: string;
  riskFlags: string[];
  language: string;
  rationale?: string;
  level: RouteLevel;
  routeLabel: string;
  routeEnum: RouteEnum; // the routing enum scored deterministically by the evals
  tier: Tier | null;
  gateModel: string;
  conversationModel: string; // shown when the answer route runs
  sessionBlocked?: boolean; // signed-out session stopped this before the engine ran
  sessionNote?: string; // panel narration for the session boundary, e.g. "session: none → blocked before engine"
  routeNote?: string; // routing-step narration, e.g. "low confidence → clarification"
  // Input-moderation row - present in EVERY state (off / pass / flagged / unavailable).
  moderation?: {
    line: string; // "moderation: pass" | "moderation: pass (pii noted)" | "moderation: flagged (criminal)" | "moderation: off (demo rate budget)"
    routing: string; // clean | context | severe | unavailable | off
    flagged: string[];
    deEscalated?: boolean; // abusive-but-legitimate tone → served with calm tone + human offered
    blocked?: boolean; // severe → refused + human path
  };
}

export interface Citation {
  id: string;
  title: string;
  url: string;
  score: number;
}

export type AssistantKind =
  | "answer"
  | "refusal"
  | "escalation"
  | "complaint-route"
  | "balance"
  | "action-confirm"
  | "info";

export interface AssistantMessage {
  kind: AssistantKind;
  text: string;
  citations?: Citation[];
  transcriptCarry?: string;
  // Deterministic action affordance (code-generated, never model-written):
  // rendered as an action card that enters the normal confirm/SCA path.
  actionOffer?: "lock_card" | "unlock_card"; // Level 3 handoff note
  queuePosition?: number;
  priority?: boolean;
  balance?: { holder: string; iban: string; balance: number; currency: string };
  transactions?: { date: string; description: string; amount: number; currency: string }[];
  complaintRoute?: { formLabel: string; formHref: string };
}

export interface PendingActionPayload {
  requestId: string;
  action: "lock_card" | "unlock_card";
  tier: Tier;
  actionLabel: string; // "Lock card" / "Unlock card"
  requiresSca: boolean;
  cards: Card[]; // the REAL list the customer selects from
  selectedCardId: string;
}

export interface ChatResponse {
  requestId: string;
  trace: TraceInfo;
  assistant: AssistantMessage;
  pendingAction?: PendingActionPayload;
  audit: AuditEntry[];
}

export function buildTrace(gate: GateDecision, route: Route, conversationModel: string): TraceInfo {
  return {
    intent: gate.intent,
    riskFlags: gate.riskFlags,
    language: gate.language,
    rationale: gate.rationale,
    level: route.level,
    routeLabel: route.routeLabel,
    routeEnum: routeEnumFor(gate, route),
    tier: route.tier,
    gateModel: gate.model,
    conversationModel,
  };
}
