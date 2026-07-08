// Confirm + execute a pending action. This calls ONLY the deterministic engine -
// no LLM. Two phases, both server-side:
//   phase "confirm"  - the confirm interaction posts back and flips the pending to
//                      CONFIRMED. Nothing executes yet.
//   phase "execute"  - runs the action, but ONLY if the pending was confirmed first.
// A raw execute on an unconfirmed pending (a stolen requestId replayed via curl) is
// refused inside the engine (confirm_bypass_blocked) and never commits. Idempotency
// (double-tap => one lock) and SCA-gating (never a false success) live in engine/bank.ts.
import { NextResponse } from "next/server";
import { confirmPending, executeAction } from "@/engine/bank";
import { getAudit } from "@/engine/audit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json();
  const sessionId: string = body.sessionId || "demo-session";
  const requestId: string = body.requestId;
  const phase: string = body.phase === "confirm" ? "confirm" : "execute";
  const simulateScaTimeout: boolean = Boolean(body.simulateScaTimeout);
  const selectedCardId: string | undefined = body.selectedCardId;

  if (!requestId) {
    return NextResponse.json({ error: "Missing requestId" }, { status: 400 });
  }

  if (phase === "confirm") {
    // The confirm click. Marks the pending CONFIRMED server-side; does NOT execute.
    const ok = confirmPending(sessionId, requestId);
    if (!ok) {
      return NextResponse.json({ error: "No pending action for this request ID." }, { status: 400 });
    }
    return NextResponse.json({ confirmed: true, audit: getAudit(sessionId) });
  }

  const result = await executeAction(sessionId, requestId, { simulateScaTimeout, selectedCardId });
  return NextResponse.json({ result, audit: getAudit(sessionId) });
}
