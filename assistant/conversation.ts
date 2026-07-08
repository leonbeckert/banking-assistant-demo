// Conversation route (Mistral Large 3 + tools). Two jobs, both temperature 0:
//  1. Answer RouteLevel-1 questions ONLY from retrieved sources, with citations - or
//     say it cannot (grounded-or-refuse). The model never free-styles bank facts.
//  2. Emit a STRUCTURED INTENT OBJECT for card actions via a tool call. It never
//     generates a card identifier - the engine resolves the real card list.
import fs from "fs";
import path from "path";
import { MODELS, TEMPERATURE, mistral, recordUsage, withLimit } from "./client";
import type { RetrievalHit } from "./retrieval";

// ASSISTANT_MODE=studio-agent routes the grounded-answer call through the
// registered Studio agent (L2) instead of a direct chat-completion. Default is
// "direct" - the demo must never depend on the beta Agents API. Any failure in
// the studio path falls back to a direct call so the demo cannot break.
function studioAgentId(): string | undefined {
  if (process.env.STUDIO_AGENT_ID) return process.env.STUDIO_AGENT_ID;
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "studio-agent.json"), "utf-8")).agentId;
  } catch {
    return undefined;
  }
}
const useStudioAgent = () => process.env.ASSISTANT_MODE === "studio-agent";

// ---- Level 1: grounded answering -------------------------------------------

export interface GroundedAnswer {
  canAnswer: boolean;
  text: string;
  usedSourceIds: string[];
}

const ANSWER_SYSTEM = `You are a retail bank's customer assistant, answering in the answer route. Rules:
- Answer ONLY using the SOURCES provided. Never use outside knowledge about this bank's specific products, fees, or procedures.
- If the sources do not contain the answer, set "can_answer" to false and do not guess.
- Keep the answer concise and plain (2-4 sentences). Answer in the same language as the customer's question.
- You describe how things work; you never perform an action or claim to have done one.
- Return ONLY a JSON object: {"can_answer": boolean, "answer": string, "used_source_ids": string[]}. used_source_ids must be the ids of the sources you actually relied on.`;

const LANG_NAME: Record<string, string> = { en: "English", fr: "French", de: "German", other: "the customer's language" };

export async function answerFromSources(
  question: string,
  hits: RetrievalHit[],
  language = "en",
): Promise<GroundedAnswer> {
  const sourcesBlock = hits
    .map((h) => `[${h.chunk.id}] ${h.chunk.title}\n${h.chunk.text}`)
    .join("\n\n");
  const langInstruction = `\n\nRespond in ${LANG_NAME[language] ?? "English"}; the customer wrote in that language. Ignore the language of the SOURCES; translate the facts if needed.`;
  const userContent = `SOURCES:\n${sourcesBlock}\n\nCUSTOMER QUESTION:\n"${question}"`;

  try {
    const agentId = studioAgentId();
    let res;
    if (useStudioAgent() && agentId) {
      // L2 path: the versioned Studio agent embodies the same instructions; we pass
      // the JSON contract + sources in the turn. Falls back to direct on failure.
      try {
        res = await withLimit(() => mistral.agents.complete({
          agentId,
          responseFormat: { type: "json_object" },
          messages: [{ role: "user", content: ANSWER_SYSTEM + langInstruction + "\n\n" + userContent }],
        }));
      } catch (studioErr) {
        console.warn("[conversation] studio-agent path failed, falling back to direct:", studioErr);
        res = undefined;
      }
    }
    if (!res) {
      res = await withLimit(() => mistral.chat.complete({
        model: MODELS.conversation,
        temperature: TEMPERATURE,
        responseFormat: { type: "json_object" },
        messages: [
          { role: "system", content: ANSWER_SYSTEM + langInstruction },
          { role: "user", content: userContent },
        ],
      }));
    }
    recordUsage(MODELS.conversation, res.usage);
    const content = res.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : "";
    const parsed = JSON.parse(text || "{}");
    const usedSourceIds = Array.isArray(parsed.used_source_ids)
      ? parsed.used_source_ids.filter((s: unknown) => typeof s === "string")
      : [];
    return {
      canAnswer: Boolean(parsed.can_answer) && usedSourceIds.length > 0,
      text: typeof parsed.answer === "string" ? parsed.answer : "",
      usedSourceIds,
    };
  } catch (err) {
    console.error("[conversation] answer error:", err);
    return { canAnswer: false, text: "", usedSourceIds: [] };
  }
}

// ---- Level 2: structured intent object via tool call ------------------------

export interface CardIntent {
  action: "lock_card" | "unlock_card";
  cardHint?: string; // e.g. "4471" - a HINT the engine matches against the real list
  // A short phrase naming a DISTINCT additional request in the same message that is
  // NOT the card lock/unlock (e.g. "raising the payment limit", "sending €200 to Bob").
  // null when the message only asks to lock/unlock. Posture: SERVE the card action,
  // NAME the unserved one - never silently drop it (see pipeline card_action).
  unserved?: string | null;
}

const CARD_TOOL = {
  type: "function" as const,
  function: {
    name: "prepare_card_action",
    description:
      "Prepare a card lock/unlock for the customer. This does NOT execute anything; the deterministic engine resolves the customer's real cards and requires confirmation and strong authentication. Never invent a card number; only pass a card_hint if the customer explicitly mentioned last digits.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["lock_card", "unlock_card"] },
        card_hint: {
          type: "string",
          description: "Last 4 digits IF and ONLY IF the customer stated them. Omit otherwise.",
        },
        unserved: {
          type: "string",
          description:
            "A short noun phrase naming any DISTINCT additional request in the message that is NOT the card lock/unlock itself, e.g. 'raising the payment limit', 'sending €200 to Bob', 'a chequebook order'. Set to null (or omit) when the message ONLY asks to lock or unlock a card. Do not restate the lock/unlock here.",
        },
      },
      required: ["action"],
    },
  },
};

const CARD_SYSTEM = `You are a retail bank assistant preparing a card action. Call prepare_card_action with the correct action. Only include card_hint if the customer explicitly named card digits. You never generate or guess a card number; the engine will show the customer their real cards to choose from. If the customer's message ALSO asks for something distinct from the lock/unlock (a limit change, a transfer, a chequebook, etc.), name it briefly in "unserved"; if the message only asks to lock or unlock, set unserved to null.`;

// Returns the structured intent object. Falls back to the gate-provided action
// if the model does not emit a tool call.
export async function prepareCardIntent(
  message: string,
  fallbackAction: "lock_card" | "unlock_card",
): Promise<CardIntent> {
  try {
    const res = await withLimit(() => mistral.chat.complete({
      model: MODELS.conversation,
      temperature: TEMPERATURE,
      tools: [CARD_TOOL],
      toolChoice: "any",
      messages: [
        { role: "system", content: CARD_SYSTEM },
        { role: "user", content: message },
      ],
    }));
    recordUsage(MODELS.conversation, res.usage);
    const toolCalls = res.choices?.[0]?.message?.toolCalls;
    const call = toolCalls?.[0];
    if (call && call.function?.name === "prepare_card_action") {
      const argsRaw = call.function.arguments;
      const args = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw;
      const action = args.action === "unlock_card" || args.action === "lock_card" ? args.action : fallbackAction;
      const cardHint = typeof args.card_hint === "string" && args.card_hint.trim() ? args.card_hint : undefined;
      const unserved = typeof args.unserved === "string" && args.unserved.trim() ? args.unserved.trim() : null;
      return { action, cardHint, unserved };
    }
  } catch (err) {
    console.error("[conversation] card intent error:", err);
  }
  return { action: fallbackAction };
}
