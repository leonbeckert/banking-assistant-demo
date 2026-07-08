// THE GATE (Ministral 14B router). Runs on EVERY incoming message, before any
// answer generation or short-circuit. A SINGLE call at temperature 0 - fully
// deterministic sampling. (A 3x self-consistency vote was built and measured
// here: on the 14B gate the disagreement rate was zero even on adversarially
// ambiguous input, so it was removed. The model's own "other" verdict is the
// ambiguity signal - explicit, deterministic, free - and the policy turns it
// into a clarifying question instead of a guessed route.) This is a compliance
// gate, not a cost trick: its output is the one decision that must be
// independently evaluable and auditable per event. It never executes anything.
import { MODELS, TEMPERATURE, mistral, recordUsage, withLimit } from "./client";
import type { GateDecision, Intent } from "@/engine/types";

const VALID_INTENTS: Intent[] = [
  "faq",
  "account_read",
  "lock_card",
  "unlock_card",
  "transfer",
  "fraud_distress",
  "complaint",
  "human_request",
  "out_of_scope",
  "other",
];

const GATE_SYSTEM = `You are the routing gate of a retail bank's AI assistant. You do NOT answer the customer. You classify their latest message so a deterministic policy can route it. Return ONLY a JSON object, no prose.

CRITICAL DISAMBIGUATION - informational questions vs. action requests:
- A question about HOW something works ("how do I lock a card?", "how can I block a card if I lose it?", "what happens if I lock my card?", "how do I check my balance?") is INFORMATIONAL => "faq" (or "account_read" only if they ask for THEIR current figure). The customer is asking for knowledge, not commanding an action.
- An IMPERATIVE / request to actually do it now ("lock my card", "lock my Visa ending 4471", "please block card 8832", "freeze it") is an ACTION => "lock_card" / "unlock_card".
- If the message is phrased as "how do I / how can I / how to / what happens if" => it is almost always "faq", NOT an action.

BALANCE - how-to (faq) vs. give-me-my-figure (balance):
- A how-to / informational question about checking a balance - "how do I check my balance?", "how can I check my account balance?", "where do I see my balance?", "how do I view my balance?" - is a request for KNOWLEDGE about the procedure => "faq". It does NOT ask for the actual number. This holds even when it says "my balance" / "my account balance": "how can I check MY account balance" is still asking HOW, not asking for the figure.
- A possessive / imperative request for the customer's CURRENT figure - "what's my balance?", "show me my balance", "how much money do I have right now?", "what's in my account?", "my current balance?" - asks for THEIR OWN number now => "account_read".
- Rule of thumb: if the leading phrasing is "how do/can I …" or "where do I …", it's "faq"; if it's "what's my …", "show me …", "how much do I have", it's "account_read".

Classify "intent" as exactly one of:
- "faq": a general how-to / product / policy question the bank's public help pages could answer (HOW to lock a card, fees, how Clé digitale works, HOW to check a balance).
- "account_read": the customer asks for THEIR OWN current balance / recent transactions / how much money they have right now (an authenticated read of their account). When you choose this intent, ALSO return "read_target": "transactions" if they ask about movements, history, statements, spending, specific payments, or whether money arrived; "balance" if they ask for the current figure / how much they have. Default to "balance" if unclear.
- "lock_card": the customer COMMANDS locking/blocking/freezing/opposing/stopping one of their cards right now.
- "unlock_card": the customer COMMANDS unlocking/unblocking/reactivating a card right now.
- "transfer": the customer wants to send or move money / make a payment / pay a person.
- "fraud_distress": the customer reports fraud, a scam, an unrecognised or unauthorised transaction, a stolen card being USED, money taken, or is clearly in financial distress/panic about their security. NOTE: a card that is merely LOST or MISPLACED, with no sign of active fraud or unauthorised use, is NOT fraud_distress - route it by what the customer asks (a "how do I…" question => "faq"; a command to block it => "lock_card"). Reserve fraud_distress for active fraud, theft with suspected use, unrecognised transactions, or clear panic.
- "complaint": the customer EXPLICITLY asks to file/register/submit a formal complaint (réclamation) - "I want to file a complaint", "this is a formal réclamation", "how do I escalate this officially". Venting, frustration, or general dissatisfaction ("this is terrible", "this chatbot is useless", being unhappy about a fee) is NOT "complaint" - classify those by the underlying request (faq/balance/other) so the assistant keeps serving; if there is NO underlying request - the message only says something is bad or broken, with nothing to answer, read, or do - it is "other", not "faq". Only an explicit filing ask is "complaint".
- "human_request": the customer explicitly asks to speak to a human, an advisor, or an agent.
- "out_of_scope": tax advice, legal advice, investment recommendations, loan/credit eligibility or creditworthiness questions, or anything the bank assistant must not opine on.
- "other": anything else (greetings, chit-chat, unclear, or pure venting with no actionable request - nothing to answer, read, or do).

Also return:
- "risk_flags": array of strings from ["fraud_distress","hardship","vulnerability"] - include any that apply; empty array if none. If intent is fraud_distress, include "fraud_distress". Do NOT raise "fraud_distress" for a card that is merely LOST or MISPLACED with no sign of misuse - lost-card questions and protective lock requests are not fraud. Abusive or frustrated tone alone is frustration, not fraud.
- "read_target": ONLY when intent is "account_read" - "balance" or "transactions" (see the account_read definition).
- "language": one of "en","fr","de","other" - the language the customer's WORDS are written in. Judge ONLY the words, never the topic: currency symbols (€), French product names (Clé digitale, réclamation), or French banking topics inside an English sentence do NOT make it French. "I was charged a €30 fee" is English; "on m'a facturé 30 €" is French.
- "rationale": one short clause (max 10 words) explaining the classification.

Bias for recall on safety: if a message hints at fraud, a scam, or distress, flag it - a false human-route is cheap, a missed one is not.`;

interface RawGate {
  intent?: string;
  read_target?: string;
  risk_flags?: string[];
  language?: string;
  rationale?: string;
}

export async function runGate(message: string, history: { role: string; content: string }[] = []): Promise<GateDecision> {
  const contextLines = history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content}`)
    .join("\n");

  const userContent = contextLines
    ? `Recent context:\n${contextLines}\n\nLatest customer message to classify:\n"${message}"`
    : `Latest customer message to classify:\n"${message}"`;

  let raw: RawGate = {};
  try {
    const res = await withLimit(() => mistral.chat.complete({
      model: MODELS.gate,
      temperature: TEMPERATURE,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: GATE_SYSTEM },
        { role: "user", content: userContent },
      ],
    }));
    recordUsage(MODELS.gate, res.usage);
    const content = res.choices?.[0]?.message?.content;
    raw = JSON.parse(typeof content === "string" && content ? content : "{}");
  } catch (err) {
    // Fail safe: an unclassifiable message defaults to "other" - which the policy
    // resolves to a clarifying question. The gate never blocks - it only sorts.
    console.error("[gate] classification error:", err);
    raw = { intent: "other", risk_flags: [], language: "en", rationale: "gate error fallback" };
  }

  const intent = (VALID_INTENTS as string[]).includes(raw.intent ?? "") ? (raw.intent as Intent) : "other";
  const riskFlags = Array.isArray(raw.risk_flags) ? raw.risk_flags.filter((f) => typeof f === "string") : [];
  const language = (["en", "fr", "de", "other"].includes(raw.language ?? "") ? raw.language : "en") as GateDecision["language"];

  return {
    intent,
    // Sub-decision within the T0 route (no controls difference - balance and
    // transactions are the same tier). Carried by this existing call, never a
    // second one: the router call is the budget.
    readTarget: intent === "account_read" ? (raw.read_target === "transactions" ? "transactions" : "balance") : undefined,
    riskFlags,
    language,
    rationale: raw.rationale,
    model: MODELS.gate,
  };
}
