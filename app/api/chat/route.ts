// Per-turn HTTP entry point. All orchestration lives in assistant/pipeline.ts so
// the offline eval runner scores the EXACT same pipeline. This route just relays.
import { NextResponse } from "next/server";
import { runTurn } from "@/assistant/pipeline";
import type { ChatResponse } from "@/app/lib/contract";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json();
  const sessionId: string = body.sessionId || "demo-session";
  const message: string = (body.message || "").toString();
  const history: { role: string; content: string }[] = Array.isArray(body.history) ? body.history : [];
  const signedOut: boolean = body.signedOut === true;
  const moderationEnabled: boolean = body.moderationEnabled === true;
  const outOfHours: boolean = body.outOfHours === true;

  try {
    const turn = await runTurn(sessionId, message, history, { signedOut, moderationEnabled, outOfHours });
    // One line per turn so the demo is diagnosable from `docker logs`: intent,
    // route, outcome kind, and citation count. Without this, a run of identical
    // refusals (e.g. retrieval degraded) leaves NO trace - refusals only write to
    // the in-memory audit, never to stdout.
    const cites = turn.assistant.citations?.length ?? 0;
    console.log(
      `[chat] intent=${turn.trace.intent} route=${turn.trace.routeEnum} kind=${turn.assistant.kind}${cites ? ` cites=${cites}` : ""}`,
    );
    const response: ChatResponse = {
      requestId: turn.requestId,
      trace: turn.trace,
      assistant: turn.assistant,
      pendingAction: turn.pendingAction,
      audit: turn.audit,
    };
    return NextResponse.json(response);
  } catch (err: unknown) {
    // A live upstream failure - most often a 429 token-burst that outlasts the
    // client's own retries in withLimit() - must NOT surface as a raw 500 and the
    // dev-facing "check your API key" catch in the UI. Degrade to a calm, VALID
    // ChatResponse the UI renders like any other turn.
    const status = (err as { statusCode?: number })?.statusCode;
    const rateLimited = status === 429;
    console.error(`[chat] turn failed${status ? ` (${status})` : ""}:`, err);
    const degraded: ChatResponse = {
      requestId: `req_unavailable_${Date.now().toString(36)}`,
      trace: {
        intent: "unavailable",
        riskFlags: [],
        language: "en",
        level: 1,
        routeLabel: rateLimited
          ? "assistant busy: model rate-limited (retried, then degraded)"
          : "assistant unavailable: upstream error (degraded)",
        routeEnum: "refusal",
        tier: null,
        gateModel: "none (unavailable)",
        conversationModel: "none (unavailable)",
        routeNote: rateLimited ? "upstream 429 after retries" : "upstream error",
      },
      assistant: {
        kind: "info",
        text: rateLimited
          ? "I'm handling a lot of requests right now and couldn't finish that one in time. Please try again in a few seconds."
          : "I'm temporarily unable to reach the assistant service. Please try again in a moment.",
      },
      audit: [],
    };
    return NextResponse.json(degraded);
  }
}
