// UNIT TESTS over the pure functions the Routes & limits state rows cite.
// No models, no network: laneNeedsSession (the session boundary predicate) and
// the hours model (states, not gates). Writes evals/results/unit-results.json;
// the Routes & limits page reads that artifact - the printed count is never
// hand-entered.
//
// Run: npm run unit
import fs from "fs";
import path from "path";
import { laneNeedsSession } from "../assistant/pipeline";
import { isOpen, nextOpening, mockNow, SUPPORT_HOURS } from "../engine/hours";
import { routeFor } from "../engine/policy";
import type { GateDecision } from "../engine/types";

interface Check {
  id: string;
  group: "signed_out" | "out_of_hours";
  name: string;
  pass: boolean;
}

const g = (intent: GateDecision["intent"], riskFlags: GateDecision["riskFlags"] = []): GateDecision => ({
  intent,
  riskFlags,
  language: "en",
  model: "fixture",
});

const checks: Check[] = [];
function check(id: string, group: Check["group"], name: string, pass: boolean) {
  checks.push({ id, group, name, pass });
}

// ---- Signed out: account lanes need a session, public + safety lanes don't ----
check("unit_s01", "signed_out", "balance/transactions read requires a session", laneNeedsSession("balance_read"));
check("unit_s02", "signed_out", "card lock/unlock requires a session", laneNeedsSession("card_action"));
check("unit_s03", "signed_out", "payment requires a session", laneNeedsSession("transfer_stub"));
check("unit_s04", "signed_out", "public FAQ answers without a session", !laneNeedsSession("answer"));
check("unit_s05", "signed_out", "refusal serves without a session", !laneNeedsSession("refuse"));
check("unit_s06", "signed_out", "human/fraud escalation serves without a session", !laneNeedsSession("escalate"));
check("unit_s07", "signed_out", "complaint routing serves without a session", !laneNeedsSession("complaint_route"));

// ---- Out of hours: hours are states, not gates --------------------------------
check("unit_h01", "out_of_hours", "the out-of-hours clock is out of hours (Sun 20:00)", !isOpen(mockNow(true)));
check("unit_h02", "out_of_hours", "the in-hours clock is in hours (Mon 10:00)", isOpen(mockNow(false)));
check(
  "unit_h03",
  "out_of_hours",
  "out of hours still yields a reply-by promise (nextOpening)",
  typeof nextOpening(mockNow(true)) === "string" && nextOpening(mockNow(true)).length > 0,
);
check("unit_h04", "out_of_hours", "Sunday is configured closed", SUPPORT_HOURS[0] === null);
check(
  "unit_h05",
  "out_of_hours",
  "a fraud signal routes to escalation regardless of any clock input",
  routeFor(g("fraud_distress")).action === "escalate" && routeFor(g("faq", ["fraud"])).action === "escalate",
);
check(
  "unit_h06",
  "out_of_hours",
  "routeFor takes no time input: routes cannot depend on hours",
  routeFor.length === 1,
);

const passed = checks.filter((c) => c.pass).length;
const failed = checks.length - passed;
const out = {
  generatedAt: new Date().toISOString(),
  total: checks.length,
  passed,
  failed,
  checks,
};
const file = path.join(process.cwd(), "evals", "results", "unit-results.json");
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`unit: ${passed}/${checks.length} pass${failed ? ` (${failed} FAILED)` : ""}`);
for (const c of checks.filter((c) => !c.pass)) console.log(`  FAIL ${c.id}: ${c.name}`);
