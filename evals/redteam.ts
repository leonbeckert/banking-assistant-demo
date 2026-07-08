// Engine-level red-team harness. Exercises the DETERMINISTIC boundary directly
// (no LLM, no API key, no network) so it is instant, free, and reproducible.
// Attacks the capability model: forged/stolen requestIds, unconfirmed execution,
// forged card ids, cross-session isolation, idempotency, SCA-timeout ret/safety,
// audit integrity, the degradation skeleton, and the pure routing policy.
//
// Run: npx tsx evals/redteam.ts   (does NOT call Mistral - safe to run anytime)
import {
  createPending,
  confirmPending,
  executeAction,
  resolveCards,
  readBalance,
  getCardById,
} from "@/engine/bank";
import { getAudit } from "@/engine/audit";
import { getSession, resetSession } from "@/engine/store";
import { routeFor, humanOfferAdvised, shouldClarify } from "@/engine/policy";
import { skeletonFaqList, skeletonAnswer } from "@/engine/skeleton";
import type { GateDecision, Intent, PendingAction } from "@/engine/types";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(id: string, ok: boolean, detail: string) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${id} - ${detail}`);
  } else {
    fail++;
    failures.push(`${id} - ${detail}`);
    console.log(`  FAIL  ${id} - ${detail}`);
  }
}

// Convenience: build + optionally confirm a pending lock/unlock in a session.
function seedPending(
  sessionId: string,
  requestId: string,
  intent: "lock_card" | "unlock_card",
  cardId = "card-4471",
  requiresSca = intent === "unlock_card",
): PendingAction {
  const p: PendingAction = {
    requestId,
    sessionId,
    intent,
    tier: intent === "unlock_card" ? "T2" : "T1",
    cardId,
    requiresSca,
    createdAt: new Date().toISOString(),
    confirmed: false,
  };
  createPending(p);
  return p;
}

async function main() {
  // ══ A. CAPABILITY / BOUNDARY ATTACKS ═════════════════════════════════════
  console.log("\n[A] Capability & boundary attacks");

  // A1 - forged requestId with no pending must never execute.
  {
    resetSession("a1");
    const r = await executeAction("a1", "req_forged_nonexistent");
    check("A1 forged-requestId", r.status === "failed" && /no pending/i.test(r.message),
      `status=${r.status} msg="${r.message}"`);
  }

  // A2 - unconfirmed execute (pending exists, confirmed=false) must be blocked.
  {
    resetSession("a2");
    seedPending("a2", "req_a2", "lock_card");
    const r = await executeAction("a2", "req_a2");
    const audited = getAudit("a2").some((e) => e.type === "confirm_bypass_blocked");
    const cardUntouched = getCardById("a2", "card-4471")?.status === "active";
    check("A2 unconfirmed-execute-blocked",
      r.status === "failed" && audited && cardUntouched,
      `status=${r.status} bypassAudited=${audited} cardStatus=${getCardById("a2", "card-4471")?.status}`);
  }

  // A3 - THE STOLEN-REQUESTID FINDING: confirm is a separate open call. An actor
  // holding the requestId can flip confirm THEN execute (two calls). Does the
  // T1 lock commit with no auth token / nonce binding the confirm to a user?
  {
    resetSession("a3");
    seedPending("a3", "req_a3", "lock_card"); // T1, requiresSca=false
    confirmPending("a3", "req_a3");            // attacker flips the flag (open endpoint)
    const r = await executeAction("a3", "req_a3");
    check("A3 stolen-requestId confirm+execute (EXPECT it commits - documents the gap)",
      r.status === "success",
      `status=${r.status} - confirm flag is not auth/nonce-bound; a requestId-holder can lock in 2 calls (fail-safe: own card, protective action)`);
  }

  // A4 - forged card id at execute must be ignored; the real pending card is used.
  {
    resetSession("a4");
    seedPending("a4", "req_a4", "lock_card", "card-4471");
    confirmPending("a4", "req_a4");
    const r = await executeAction("a4", "req_a4", { selectedCardId: "card-DOES-NOT-EXIST" });
    const locked4471 = getCardById("a4", "card-4471")?.status === "locked";
    check("A4 forged-cardId-ignored",
      r.status === "success" && locked4471 && r.card?.id === "card-4471",
      `status=${r.status} committedCard=${r.card?.id} (forged id rejected server-side)`);
  }

  // A5 - valid card re-selection (the customer's OTHER real card) is honoured.
  {
    resetSession("a5");
    seedPending("a5", "req_a5", "lock_card", "card-4471");
    confirmPending("a5", "req_a5");
    const r = await executeAction("a5", "req_a5", { selectedCardId: "card-8832" });
    check("A5 valid-card-reselection",
      r.status === "success" && r.card?.id === "card-8832" && getCardById("a5", "card-8832")?.status === "locked",
      `committedCard=${r.card?.id} (real alternate card accepted)`);
  }

  // A6 - cross-session: session B replays A's requestId. B has no such pending.
  {
    resetSession("a6a");
    resetSession("a6b");
    seedPending("a6a", "req_shared", "lock_card");
    confirmPending("a6a", "req_shared");
    const r = await executeAction("a6b", "req_shared"); // different session, same id
    check("A6 cross-session-replay-isolated",
      r.status === "failed",
      `status=${r.status} - session B cannot act on session A's pending/id`);
  }

  // A7 - cross-session card integrity: A committing a lock must not mutate B's card.
  {
    resetSession("a7a");
    resetSession("a7b");
    seedPending("a7a", "req_a7", "lock_card", "card-4471");
    confirmPending("a7a", "req_a7");
    await executeAction("a7a", "req_a7");
    const bUntouched = getCardById("a7b", "card-4471")?.status === "active";
    check("A7 cross-session-card-integrity", bUntouched,
      `sessionB card-4471 status=${getCardById("a7b", "card-4471")?.status} (must stay active)`);
  }

  // ══ B. IDEMPOTENCY & FAILURE PATHS ════════════════════════════════════════
  console.log("\n[B] Idempotency & failure paths");

  // B1 - concurrent double-tap: two executes fired together = ONE lock.
  {
    resetSession("b1");
    seedPending("b1", "req_b1", "lock_card");
    confirmPending("b1", "req_b1");
    const [r1, r2] = await Promise.all([
      executeAction("b1", "req_b1"),
      executeAction("b1", "req_b1"),
    ]);
    const oneCommitted = [r1, r2].filter((r) => r.status === "success" && !r.idempotent).length;
    const execEvents = getAudit("b1").filter((e) => e.type === "bank_execute").length;
    check("B1 concurrent-double-tap-one-lock",
      execEvents === 1 && (r1.idempotent || r2.idempotent),
      `bank_execute events=${execEvents} committedNonIdem=${oneCommitted} (exactly one lock)`);
  }

  // B2 - sequential replay after commit returns the sealed result (idempotent).
  {
    resetSession("b2");
    seedPending("b2", "req_b2", "lock_card");
    confirmPending("b2", "req_b2");
    await executeAction("b2", "req_b2");
    const again = await executeAction("b2", "req_b2");
    check("B2 sequential-replay-idempotent",
      again.idempotent === true && again.status === "success",
      `idempotent=${again.idempotent} status=${again.status}`);
  }

  // B3 - SCA timeout on a T2 unlock: pending (not success), card untouched, retryable.
  {
    resetSession("b3");
    // put the card into 'locked' so an unlock is meaningful
    getSession("b3").cards[0].status = "locked";
    seedPending("b3", "req_b3", "unlock_card", "card-4471", true);
    confirmPending("b3", "req_b3");
    const timed = await executeAction("b3", "req_b3", { simulateScaTimeout: true });
    const stillLocked = getCardById("b3", "card-4471")?.status === "locked";
    const notSealed = !getSession("b3").executed.has("req_b3");
    check("B3 sca-timeout-safe",
      timed.status === "pending" && stillLocked && notSealed,
      `status=${timed.status} cardStillLocked=${stillLocked} notSealed=${notSealed}`);

    // B4 - retry after timeout succeeds (confirmed persists, ledger was not sealed).
    const retry = await executeAction("b3", "req_b3");
    check("B4 retry-after-timeout-succeeds",
      retry.status === "success" && getCardById("b3", "card-4471")?.status === "active",
      `retryStatus=${retry.status} cardStatus=${getCardById("b3", "card-4471")?.status}`);
  }

  // B5 - double confirm only records ONE 'confirmed' audit entry (no state churn).
  {
    resetSession("b5");
    seedPending("b5", "req_b5", "lock_card");
    confirmPending("b5", "req_b5");
    confirmPending("b5", "req_b5");
    const confirms = getAudit("b5").filter((e) => e.type === "confirmed").length;
    check("B5 double-confirm-idempotent", confirms === 1, `confirmed audit entries=${confirms}`);
  }

  // ══ C. AUDIT INTEGRITY ════════════════════════════════════════════════════
  console.log("\n[C] Audit integrity");

  // C1 - every committed mutation has a bank_execute; seq is strictly monotonic.
  {
    resetSession("c1");
    seedPending("c1", "req_c1", "lock_card");
    confirmPending("c1", "req_c1");
    await executeAction("c1", "req_c1");
    const audit = getAudit("c1");
    const seqs = audit.map((e) => e.seq);
    const monotonic = seqs.every((v, i) => i === 0 || v > seqs[i - 1]);
    const hasChain = ["confirm_issued", "confirmed", "bank_execute"].every((t) => audit.some((e) => e.type === t));
    const noStrayScaOnLock = !audit.some((e) => e.type === "sca_started");
    check("C1 audit-chain-and-seq",
      monotonic && hasChain && noStrayScaOnLock,
      `monotonic=${monotonic} chain(confirm_issued→confirmed→bank_execute)=${hasChain} noSCAonLock=${noStrayScaOnLock}`);
  }

  // C2 - a blocked bypass is itself audited (evidence trail on the attack).
  {
    resetSession("c2");
    seedPending("c2", "req_c2", "lock_card");
    await executeAction("c2", "req_c2"); // unconfirmed
    check("C2 bypass-attempt-audited",
      getAudit("c2").some((e) => e.type === "confirm_bypass_blocked"),
      `confirm_bypass_blocked present=${getAudit("c2").some((e) => e.type === "confirm_bypass_blocked")}`);
  }

  // ══ D. DEGRADATION SKELETON (the empty-grid concern, at the data layer) ════
  console.log("\n[D] Degradation skeleton");
  {
    const list = skeletonFaqList();
    const allResolve = list.every((f) => {
      const a = skeletonAnswer(f.chunkId);
      return a && a.text.length > 0 && a.citation.id === f.chunkId;
    });
    check("D1 skeleton-6-faqs-resolve",
      list.length === 6 && allResolve,
      `count=${list.length} allChunksResolveVerbatim=${allResolve} (data layer is sound; empty-grid risk is the HTTP GET only)`);
    const bad = skeletonAnswer("faq_does_not_exist");
    check("D2 skeleton-bad-chunk-graceful", bad === null, `badChunk=${bad === null ? "null (graceful)" : "non-null"}`);
  }

  // ══ E. PURE ROUTING POLICY (deterministic, no gate LLM) ═══════════════════
  console.log("\n[E] Routing policy (pure function over synthetic gate decisions)");
  const g = (intent: Intent, riskFlags: string[] = []): GateDecision => ({
    intent, riskFlags, language: "en", model: "test",
  });
  const cases: [string, GateDecision, { level: number; tier: string | null; sca: boolean; action: string }][] = [
    ["balance→T0-no-sca", g("account_read"), { level: 2, tier: "T0", sca: false, action: "balance_read" }],
    ["lock→T1-no-sca", g("lock_card"), { level: 2, tier: "T1", sca: false, action: "card_action" }],
    ["unlock→T2-sca", g("unlock_card"), { level: 2, tier: "T2", sca: true, action: "card_action" }],
    ["transfer→T3-stub", g("transfer"), { level: 2, tier: "T3", sca: false, action: "transfer_stub" }],
    ["out_of_scope→refuse", g("out_of_scope"), { level: 1, tier: null, sca: false, action: "refuse" }],
    ["complaint→route", g("complaint"), { level: 3, tier: null, sca: false, action: "complaint_route" }],
    ["fraud→escalate", g("fraud_distress"), { level: 3, tier: null, sca: false, action: "escalate" }],
  ];
  for (const [label, gate, want] of cases) {
    const r = routeFor(gate);
    check(`E ${label}`,
      r.level === want.level && r.tier === want.tier && r.requiresSca === want.sca && r.action === want.action,
      `got route=${r.level} tier=${r.tier} sca=${r.requiresSca} action=${r.action}`);
  }

  // E8 - PRECEDENCE ATTACK: a lock_card intent carrying a fraud risk flag. Does the
  // fraud fast-lane override the action route? (A social-engineered "lock + panic".)
  {
    const r = routeFor(g("lock_card", ["fraud_distress"]));
    check("E8 fraud-flag-overrides-lock (fail-safe to human)",
      r.action === "escalate" && r.level === 3,
      `action=${r.action} route=${r.level} - a fraud signal on a lock routes to a human, not a silent auto-action`);
  }

  // E9 - PRECEDENCE NUANCE: a SOFT vulnerability cue on a PROTECTIVE lock must NOT
  // escalate - queuing a panicking customer behind a human makes them less safe.
  // The lock runs; a human offer rides alongside (humanOfferAdvised). This is the
  // correct, deliberate design - hard fraud still preempts (E8).
  {
    const r = routeFor(g("lock_card", ["vulnerability"]));
    const offer = humanOfferAdvised(g("lock_card", ["vulnerability"]));
    check("E9 soft-vulnerability-on-lock-runs-with-human-offer",
      r.action === "card_action" && offer === true,
      `action=${r.action} humanOfferAdvised=${offer} - protective action proceeds, human offered alongside (not queued)`);
  }

  // E10 - but a HARD fraud flag on a lock still preempts to a human (E8 confirms).
  // And a vulnerability cue on a NON-protective intent (e.g. transfer) escalates.
  {
    const rTransfer = routeFor(g("transfer", ["hardship"]));
    check("E10 vulnerability-on-non-protective-escalates",
      rTransfer.action === "escalate",
      `transfer+hardship action=${rTransfer.action} - soft cue escalates when the intent is NOT protective`);
  }

  // E11 - clarify branch: unclassified + no flags → clarify; but a risk flag
  // always wins (safety recall bias), never a clarify.
  {
    const otherNoFlags: GateDecision = { intent: "other", riskFlags: [], language: "en", model: "test" };
    const otherFlagged: GateDecision = { intent: "other", riskFlags: ["fraud_distress"], language: "en", model: "test" };
    check("E11a unclassified-clarifies", shouldClarify(otherNoFlags) === true, `shouldClarify(other,noflags)=${shouldClarify(otherNoFlags)}`);
    check("E11b flag-beats-clarify", shouldClarify(otherFlagged) === false, `shouldClarify(other,fraud)=${shouldClarify(otherFlagged)} (safety wins)`);
  }

  // E12 - fragment fail-safe: a <=2-word message the gate wants to ANSWER is
  // demoted to clarify (deterministic); real sentences and action intents are not.
  {
    const faqGate: GateDecision = { intent: "faq", riskFlags: [], language: "en", model: "test" };
    const lockGate: GateDecision = { intent: "lock_card", riskFlags: [], language: "en", model: "test" };
    const faqFlagged: GateDecision = { intent: "faq", riskFlags: ["fraud_distress"], language: "en", model: "test" };
    check("E12a fragment-faq-clarifies", shouldClarify(faqGate, "my card") === true, `shouldClarify(faq,"my card")=${shouldClarify(faqGate, "my card")}`);
    check("E12b sentence-faq-answers", shouldClarify(faqGate, "how do I lock my card?") === false, `full sentence stays on the answer route`);
    check("E12c fragment-action-untouched", shouldClarify(lockGate, "lock card") === false, `action intents keep their confirm-gated flow`);
    check("E12d flag-beats-fragment", shouldClarify(faqFlagged, "my card") === false, `a flagged fragment takes its protective route, never a clarify`);
  }

  // ══ SUMMARY ═══════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(60)}`);
  console.log(`RED-TEAM (engine layer): ${pass} passed, ${fail} failed of ${pass + fail}`);
  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  ✗ ${f}`));
  }
  console.log("Note: A3 is EXPECTED to 'commit' - it documents the confirm-not-auth-bound gap, not a test failure.");

  // Artifact for the scorecard page - the number on the page must come from a run,
  // never be hand-entered. Deterministic + offline, so re-running is free.
  const { writeFileSync, mkdirSync } = await import("fs");
  mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./results/redteam-results.json", import.meta.url),
    JSON.stringify({ generatedAt: new Date().toISOString(), passed: pass, failed: fail, total: pass + fail, failures }, null, 2),
  );
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
