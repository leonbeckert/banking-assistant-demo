// Deterministic policy gate. Maps the gate's classification onto a route, an
// action tier, and the required controls. This is the auditable routing
// decision - a pure function, NOT an LLM call. Routing accuracy is therefore a
// deterministic string comparison against labeled routes, never a judge.
import type { GateDecision, Route } from "./types";

// The routing route enum used by the eval set for DETERMINISTIC string comparison
// (never a judge). Derived from the gate decision + deterministic route - a pure
// function of the same policy the app runs, so the eval scores the real pipeline.
export type RouteEnum =
  | "faq"
  | "account_read"
  | "lock_card"
  | "unlock_card"
  | "payment"
  | "fraud_escalation"
  | "complaint_route"
  | "human_handoff" // explicit "talk to an advisor" ask - deterministic, no model call
  | "refusal";

// Human words for the route enums - panel-facing surfaces (scorecard misses,
// coverage tables) must not show t0_/t1_ shorthand without meaning.
export const ROUTE_WORDS: Record<RouteEnum | "clarify", string> = {
  faq: "answer from help content",
  account_read: "account data read",
  lock_card: "card lock",
  unlock_card: "card unlock",
  payment: "payment",
  fraud_escalation: "fraud fast-lane (human)",
  complaint_route: "complaint form",
  human_handoff: "human advisor",
  refusal: "refusal",
  clarify: "clarifying question",
};

export function routeEnumFor(gate: GateDecision, route: Route): RouteEnum {
  switch (route.action) {
    case "balance_read":
      return "account_read";
    case "refuse":
      return "refusal";
    case "transfer_stub":
      return "payment";
    case "complaint_route":
      return "complaint_route";
    case "card_action":
      return gate.intent === "unlock_card" ? "unlock_card" : "lock_card";
    case "escalate":
      // Fraud/distress fast-lane vs. designed human handoff.
      return hasFraudSignal(gate) ? "fraud_escalation" : "human_handoff";
    case "answer":
    default:
      return "faq";
  }
}

// Ambiguity is a routed outcome, not a fallthrough. The gate's own "other"
// verdict - its explicit "I could not classify this" - is the ambiguity signal
// (self-reported confidence was measured decorative and removed; a 3x sampling
// vote was measured never-splitting on the 14B gate and removed). An unclassified,
// unflagged message gets a clarifying question, never a guessed route. A risk flag
// always wins (safety recall bias): a flagged message takes its protective/human
// route, never a clarify.
// FRAGMENT FAIL-SAFE (deterministic): a message of <= 2 words carries too little
// signal to answer from generic help content - "my card" must never get a product
// FAQ. If the gate wants the ANSWER route for such a fragment, we demote to a
// clarifying question instead. Scope is deliberately narrow: only the faq intent
// (answering is the risk); action intents keep their confirm-gated flows, and a
// risk flag still beats everything. Certified against the gold set: every
// ratified <= 2-word row expects clarify; every 3-word row has a real intent.
const FRAGMENT_MAX_WORDS = 2;
export function isFragment(message: string): boolean {
  return message.trim().split(/\s+/).filter(Boolean).length <= FRAGMENT_MAX_WORDS;
}

export function shouldClarify(gate: GateDecision, message?: string): boolean {
  if (gate.riskFlags.length > 0 || hasFraudSignal(gate)) return false; // safety wins
  if (gate.intent === "other") return true; // unclassified, unflagged
  return gate.intent === "faq" && message !== undefined && isFragment(message);
}

// Hard fraud signals always preempt intent - a suspected scam or expressed fraud
// distress goes to a human, full stop.
const HARD_FRAUD_FLAGS = new Set(["fraud_distress", "fraud", "scam"]);
// Soft vulnerability cues escalate too - EXCEPT when the customer is asking for a
// protective action. Blocking "lock my card, I can't find it" behind a queue would
// make the vulnerable customer LESS safe; the protective action runs, and the
// human offer rides along with it (see humanOfferAdvised).
const SOFT_VULNERABILITY_FLAGS = new Set(["hardship", "vulnerability", "distress"]);
const PROTECTIVE_INTENTS = new Set(["lock_card"]);

export function hasFraudSignal(gate: GateDecision): boolean {
  if (gate.intent === "fraud_distress") return true;
  const flags = gate.riskFlags.map((f) => f.toLowerCase());
  if (flags.some((f) => HARD_FRAUD_FLAGS.has(f))) return true;
  return flags.some((f) => SOFT_VULNERABILITY_FLAGS.has(f)) && !PROTECTIVE_INTENTS.has(gate.intent);
}

// True when a soft vulnerability cue accompanies a protective action: the action
// proceeds, and the response should explicitly offer a human alongside it.
export function humanOfferAdvised(gate: GateDecision): boolean {
  const flags = gate.riskFlags.map((f) => f.toLowerCase());
  return PROTECTIVE_INTENTS.has(gate.intent) && flags.some((f) => SOFT_VULNERABILITY_FLAGS.has(f)) && !flags.some((f) => HARD_FRAUD_FLAGS.has(f));
}

export function routeFor(gate: GateDecision): Route {
  // Exclusion #1 - fraud/distress is fast-laned to a human. Detected, never resolved.
  if (hasFraudSignal(gate)) {
    return {
      level: 3,
      routeLabel: "human specialist, front of queue: fraud signals present",
      tier: null,
      action: "escalate",
      requiresConfirm: false,
      requiresSca: false,
    };
  }

  switch (gate.intent) {
    case "complaint":
      // Exclusion #3 - réclamation. Two verbs IN (detect · route), everything
      // else OUT. The regulated complaint process is the system of record - a
      // chatbot collecting complaint text creates acknowledgment-clock and
      // verbatim-custody ambiguity a bank can't have. So the bot recognizes the
      // intent and routes to the official form; it never collects, never
      // assesses fault, never resolves. Only an EXPLICIT filing ask lands here
      // (gate definition) - venting/frustration stays in its serving route.
      return {
        level: 3,
        routeLabel: "official complaint form (réclamation): nothing collected in chat",
        tier: null,
        action: "complaint_route",
        requiresConfirm: false,
        requiresSca: false,
      };

    case "human_request":
      return {
        level: 3,
        routeLabel: "human advisor: designed handoff",
        tier: null,
        action: "escalate",
        requiresConfirm: false,
        requiresSca: false,
      };

    case "account_read":
      // T0 - authenticated read. Account data, but zero mutation => no confirm.
      return {
        level: 2,
        routeLabel: "account data read: signed-in session, no confirmation needed",
        tier: "T0",
        action: "balance_read",
        requiresConfirm: false,
        requiresSca: false,
      };

    case "lock_card":
      // T1 - PROTECTIVE (risk-REDUCING). Session auth + a single explicit confirm.
      // NO fresh SCA: locking a card can only shrink the attack surface, so we do
      // not make the customer pay the strong-auth cost to reduce their own risk.
      // One tap → engine executes → receipt. (The asymmetry with unlock is the point.)
      return {
        level: 2,
        routeLabel: "card lock: one-tap confirm, no fresh strong auth",
        tier: "T1",
        action: "card_action",
        requiresConfirm: true,
        requiresSca: false,
      };

    case "unlock_card":
      // T2 - SECURITY-INCREASING (risk-increasing) => fresh SCA step-up. Unlocking
      // re-opens the card, so it MUST cost a fresh strong authentication. This is
      // where the Clé digitale modal lives: one action reduces fraud risk (lock,
      // one confirm), the other increases it (unlock, fresh SCA).
      return {
        level: 2,
        routeLabel: "card unlock: confirm + in-app approval",
        tier: "T2",
        action: "card_action",
        requiresConfirm: true,
        requiresSca: true,
      };

    case "transfer":
      // T3 - money-moving. Not enabled in this pilot scope (honest phasing).
      return {
        level: 2,
        routeLabel: "payment: confirm + in-app approval",
        tier: "T3",
        action: "transfer_stub",
        requiresConfirm: false,
        requiresSca: false,
      };

    case "out_of_scope":
      // Walled topic (tax/legal/creditworthiness/investment advice) => refuse + handoff.
      return {
        level: 1,
        routeLabel: "refusal: advice topic the assistant won't attempt; human offered",
        tier: null,
        action: "refuse",
        requiresConfirm: false,
        requiresSca: false,
      };

    case "faq":
    case "other":
    default:
      // Grounded answering route. Low retrieval confidence resolves to refusal
      // downstream (handled by the chat route after retrieval).
      return {
        level: 1,
        routeLabel: "answer from approved help content, with sources",
        tier: null,
        action: "answer",
        requiresConfirm: false,
        requiresSca: false,
      };
  }
}
