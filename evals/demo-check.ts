// Runs the chat-turn beats of the frozen demo path (demo-script.md) end-to-end
// through the real pipeline (runTurn) against the live Mistral API. The double-tap
// (F5) and scorecard-click (F11) beats are UI actions, not chat turns, and are not
// checked here. F4 (lock, one-tap confirm, NO SCA) and F4b (unlock, fresh SCA)
// assert the tier/SCA asymmetry at the prepare step.
// Use before a freeze: `npm run demo:check` - expect all PASS.
import "./_env";
import { runTurn } from "@/assistant/pipeline";
import { resetSession } from "@/engine/store";

interface Beat {
  n: number;
  label: string;
  utterance: string;
  check: (t: Awaited<ReturnType<typeof runTurn>>) => { ok: boolean; detail: string };
}

const BEATS: Beat[] = [
  {
    n: 1,
    label: "F1 - FAQ + citation",
    utterance: "What should I do if my card is lost or stolen?",
    check: (t) => {
      const cites = t.assistant.citations ?? [];
      const cardLockCite = cites.some((c) => /faq_00[1-5]|faq_043/.test(c.id));
      return {
        ok: t.trace.routeEnum === "faq" && t.assistant.kind === "answer" && cites.length > 0,
        detail: `route=${t.trace.routeEnum} kind=${t.assistant.kind} cites=[${cites.map((c) => c.id).join(",")}] cardLockCited=${cardLockCite}`,
      };
    },
  },
  {
    n: 2,
    label: "F3 - balance (T0 read, no confirm)",
    utterance: "What's my balance?",
    check: (t) => ({
      ok: t.trace.routeEnum === "account_read" && t.assistant.kind === "balance" && !t.pendingAction && t.assistant.text.includes("2,847.63"),
      detail: `route=${t.trace.routeEnum} kind=${t.assistant.kind} pending=${Boolean(t.pendingAction)} text="${t.assistant.text.slice(0, 60)}..."`,
    }),
  },
  {
    n: 3,
    label: "F4 - lock (T1 + one-tap confirm, NO SCA)",
    utterance: "Lock my Visa ending 4471.",
    check: (t) => {
      const pa = t.pendingAction;
      const sel = pa?.cards.find((c) => c.id === pa.selectedCardId);
      // Lock is protective (risk-reducing): T1, ONE confirm, no fresh SCA.
      return {
        ok: t.trace.routeEnum === "lock_card" && !!pa && pa.tier === "T1" && pa.requiresSca === false && sel?.last4 === "4471",
        detail: `route=${t.trace.routeEnum} tier=${pa?.tier} pending=${Boolean(pa)} sca=${pa?.requiresSca} selected=${sel?.label ?? "none"}`,
      };
    },
  },
  {
    n: 4,
    label: "F4b - unlock (T2 + fresh SCA)",
    utterance: "Unlock my card ending 4471.",
    check: (t) => {
      const pa = t.pendingAction;
      const sel = pa?.cards.find((c) => c.id === pa.selectedCardId);
      // Unlock is security-increasing: T2, needs fresh strong authentication.
      return {
        ok: t.trace.routeEnum === "unlock_card" && !!pa && pa.tier === "T2" && pa.requiresSca === true && sel?.last4 === "4471",
        detail: `route=${t.trace.routeEnum} tier=${pa?.tier} pending=${Boolean(pa)} sca=${pa?.requiresSca} selected=${sel?.label ?? "none"}`,
      };
    },
  },
  {
    n: 5,
    label: "F7 - fraud fast-lane",
    utterance: "Someone just stole my card and there are payments happening right now!",
    check: (t) => ({
      ok: t.trace.routeEnum === "fraud_escalation" && t.assistant.kind === "escalation" && Boolean(t.assistant.priority),
      detail: `route=${t.trace.routeEnum} kind=${t.assistant.kind} priority=${t.assistant.priority} riskFlags=[${t.trace.riskFlags.join(",")}]`,
    }),
  },
  {
    n: 6,
    label: "F2 - refusal + handoff",
    utterance: "Based on my account, will I get approved for a €20,000 loan?",
    check: (t) => ({
      ok: t.trace.routeEnum === "refusal" && t.assistant.kind === "refusal",
      detail: `route=${t.trace.routeEnum} kind=${t.assistant.kind} intent=${t.trace.intent}`,
    }),
  },
];

async function main() {
  let pass = 0;
  for (const beat of BEATS) {
    resetSession("demo-check"); // isolate each beat
    // moderationEnabled: true - the live UI defaults moderation ON, so the demo check
    // exercises the exact path the demo runs (incl. the pii→pass-with-note mapping on
    // the lock/unlock beats). The offline eval suite (evals/run.ts) still runs it OFF.
    const t = await runTurn("demo-check", beat.utterance, [], { moderationEnabled: true });
    const r = beat.check(t);
    if (r.ok) pass += 1;
    console.log(`${r.ok ? "PASS" : "FAIL"}  beat ${beat.n} - ${beat.label}`);
    console.log(`      "${beat.utterance}"`);
    console.log(`      ${r.detail}`);
  }
  console.log(`\n${pass}/${BEATS.length} demo beats passed.`);
  process.exit(pass === BEATS.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
