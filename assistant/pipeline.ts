// The one per-turn orchestration, shared by the app (app/api/chat/route.ts) and
// the offline eval runner (evals/*). The GATE runs on every message first; a
// DETERMINISTIC policy maps its classification to a route/tier; then the right route
// runs. The engine (mock bank, audit, idempotency) is imported from /engine and
// makes NO LLM calls. Keeping this in one place is what lets the evals score the
// EXACT pipeline the app runs, rather than a re-implementation.
import { randomUUID } from "crypto";
import { runGate } from "./gate";
import { moderateInput, moderationOff, frustrationSignal, type ModerationVerdict } from "./moderation";
import { answerFromSources, prepareCardIntent } from "./conversation";
import { retrieve } from "./retrieval";
import { MODELS, resetUsage, snapshotUsage, type UsageLedger } from "./client";
import { hasFraudSignal, routeFor, shouldClarify, humanOfferAdvised } from "@/engine/policy";
import { appendAudit, getAudit } from "@/engine/audit";
import { mockNow, nextOpening } from "@/engine/hours";
import { createPending, readBalance, readTransactions, resolveCards } from "@/engine/bank";
import type { AssistantMessage, ChatResponse, PendingActionPayload, TraceInfo } from "@/app/lib/contract";
import { buildTrace } from "@/app/lib/contract";
import type { GateDecision, Route } from "@/engine/types";
import { INTENT_WORDS } from "@/engine/types";

const RETRIEVAL_THRESHOLD = 0.62; // secondary guard; the model's grounded-or-refuse check is primary

// Deterministic FALLBACK for the T0 read split (balance vs transactions). The
// primary decision is the gate's read_target field (semantic, same call, gold-
// set-labeled); this regex only decides when that field is absent.
const TRANSACTIONS_RE = /transaction|statement|history|payment|activity|op[ée]ration|relev[ée]|mouvement/i;

export interface TurnResult extends ChatResponse {
  gate?: GateDecision; // absent when input screening stopped the turn before the router
  route?: Route;
  usage: UsageLedger; // per-turn token usage by model - the eval's cost basis
  retrieved?: { id: string; title: string; text: string; score: number }[]; // sources the answer route saw (for eval groundedness judging)
}

export interface TurnOptions {
  signedOut?: boolean; // session flag passed with the request; when true the chat has NO inherited app login
  moderationEnabled?: boolean; // gear toggle (default off) - run input moderation (Moderation 2) before the gate
  outOfHours?: boolean; // gear toggle - advisors offline; the fraud fast-lane appends the 24/7 opposition line
}

// Lanes that need an inherited banking-app session. A signed-out session is
// stopped HERE - after the gate classifies and the deterministic policy routes,
// but BEFORE the engine touches any account. Safety routes (fraud escalation,
// complaint intake, human handoff) never require sign-in.
export function laneNeedsSession(action: Route["action"]): boolean {
  return (
    action === "balance_read" || // T0 authenticated read
    action === "card_action" || // T1/T2 protective / security-touching
    action === "transfer_stub" // T3 money-moving
  );
}

export async function runTurn(
  sessionId: string,
  message: string,
  history: { role: string; content: string }[] = [],
  options: TurnOptions = {},
): Promise<TurnResult> {
  resetUsage(); // single-flight demo: track tokens for THIS turn
  const requestId = `req_${randomUUID().slice(0, 8)}`;

  // 0) INPUT MODERATION (Moderation 2) - runs BEFORE the gate; always on in the app
  // (evals pass moderationEnabled explicitly). It is a ROUTING SIGNAL, not a kill
  // switch (see moderation.ts). FAIL-OPEN: any error here never blocks the turn.
  // A verdict only lands in the audit log when it actually ran.
  const moderation: ModerationVerdict = options.moderationEnabled ? await moderateInput(message) : moderationOff();
  if (moderation.ran && moderation.auditNote) {
    appendAudit(sessionId, requestId, "moderation", `${moderation.model ?? "moderation"} → ${moderation.auditNote}`, {
      routing: moderation.routing,
      flagged: moderation.flaggedCategories,
      top: moderation.topCategory ?? null,
      model: moderation.model ?? null,
    });
  }

  // 0.1) SEVERE input stops the turn HERE - before the router. Leon's rule:
  // once the screen says criminal-solicitation-class, no further model should
  // see the message; classifying it would be wasted spend and a confusing
  // audit ("refused, then kept processing?"). Fail-open still holds: a
  // moderation ERROR never lands here, only an actual severe verdict.
  if (moderation.routing === "severe") {
    const trace: TraceInfo = {
      stoppedAtModeration: true,
      intent: "out_of_scope",
      riskFlags: [],
      language: "en",
      rationale: "stopped at input screening; the router never ran",
      level: 1,
      routeLabel: "refusal: stopped at input screening",
      routeEnum: "refusal",
      tier: null,
      gateModel: "none (never ran)",
      conversationModel: "none (never ran)",
      moderation: {
        line: moderation.traceLine,
        routing: moderation.routing,
        flagged: moderation.flaggedCategories,
        blocked: true,
      },
    };
    const assistant: AssistantMessage = {
      kind: "refusal",
      // No gate ran, so no detected language - the moderation test utterances are
      // English; a severe refusal defaults to English rather than guessing.
      text: "I can't help with that. It falls outside what I'm able to do here, and I won't attempt it. If there's a legitimate banking need behind your question, I can connect you with an advisor.",
      transcriptCarry: "An advisor is taking over. They can see this conversation.",
    };
    appendAudit(sessionId, requestId, "refusal", "input screening flagged severe → refused before the router; no further model saw this message", {
      flagged: moderation.flaggedCategories,
      top: moderation.topCategory ?? null,
      note: "severe class stops the turn at the first net; the gate and every downstream model never run",
    });
    return {
      requestId,
      trace,
      assistant,
      pendingAction: undefined,
      audit: getAudit(sessionId),
      usage: snapshotUsage(),
    };
  }

  // 1) THE GATE - always runs on screened-or-clean input, always logged.
  const gate = await runGate(message, history);
  appendAudit(sessionId, requestId, "gate_decision", `${gate.model} → classified as ${INTENT_WORDS[gate.intent] ?? gate.intent}`, {
    intent: gate.intent,
    readTarget: gate.readTarget,
    riskFlags: gate.riskFlags,
    language: gate.language,
    model: gate.model,
  });

  // 2) Deterministic routing.
  const route = routeFor(gate);
  appendAudit(sessionId, requestId, "route", `policy (code, no model) → ${route.routeLabel}`, {
    level: route.level,
    tier: route.tier,
    action: route.action,
  });

  const trace: TraceInfo = buildTrace(gate, route, MODELS.conversation);
  // Moderation row is present in EVERY state (off / pass / flagged / unavailable).
  trace.moderation = {
    line: moderation.traceLine,
    routing: moderation.routing,
    flagged: moderation.flaggedCategories,
  };
  // Customer-language localization for the DETERMINISTIC routes. The LLM routes
  // already answer in the customer's language (conversation.ts); these fixed
  // strings must do the same or a French question gets an English confirm.
  // Interface chrome and audit lines stay English (operator/app surface).
  const lz = (en: string, frs: string) => (gate.language === "fr" ? frs : en);
  let assistant: AssistantMessage;
  let pendingAction: PendingActionPayload | undefined;
  let retrieved: TurnResult["retrieved"];


  // 2.4) CLARIFICATION - a routed outcome, not a fallthrough. The gate's "other"
  // verdict is its explicit "I could not classify this"; with no risk flags we
  // don't guess a route, we ASK. A risk flag always wins over this (safety recall
  // bias), which is why shouldClarify excludes any flagged/fraud message.
  if (shouldClarify(gate, message)) {
    const fragmentDemoted = gate.intent !== "other";
    trace.routeNote = fragmentDemoted
      ? "fragment fail-safe → clarification"
      : "unclassified → clarification";
    assistant = {
      kind: "info",
      text: lz(
        "Happy to help! Could you tell me a bit more about what you'd like to do? For example: a question about how something works, checking your account, or locking or unlocking a card.",
        "Avec plaisir ! Pouvez-vous préciser ce que vous souhaitez faire ? Par exemple : une question sur un fonctionnement, une consultation de votre compte, ou bloquer/débloquer une carte.",
      ),
    };
    appendAudit(sessionId, requestId, "route", fragmentDemoted ? `message too short to disambiguate (deterministic fail-safe, code) → asked a clarifying question instead of answering from help content` : `gate could not classify the request → asked a clarifying question instead of acting`, {
      level: 1,
      intent: gate.intent,
      note: "no risk flags; routed to the answer route to ask, not act",
    });
    trace.conversationModel = snapshotUsage()[MODELS.conversation] ? MODELS.conversation : "deterministic";
    return {
      requestId,
      trace,
      assistant,
      pendingAction: undefined,
      audit: getAudit(sessionId),
      gate,
      route,
      usage: snapshotUsage(),
      retrieved,
    };
  }

  // 2.5) SESSION BOUNDARY - the chat inherits the banking-app login; it has no
  // login of its own. If the request arrives signed out, any account read (T0)
  // or action route (T1/T2/T3) is refused HERE, before anything touches the
  // engine. The gate still classified it and the policy still routed it - the
  // session boundary is a separate, later stop. Safety routes (fraud / complaint
  // / human handoff) never require sign-in and pass through untouched. Level 1
  // (public FAQ) needs no session and passes through too.
  if (options.signedOut && laneNeedsSession(route.action)) {
    trace.sessionBlocked = true;
    trace.sessionNote = "session: none → blocked before engine";
    // A signed-out card request must not dead-end: the session boundary holds,
    // but a lost/stolen card is urgent, so the reply carries the 24/7 emergency
    // opposition line alongside the sign-in path.
    const cardEmergency =
      route.action === "card_action"
        ? lz(
            " If your card is lost or stolen, the emergency opposition line is available 24/7, no sign-in needed.",
            " Si votre carte est perdue ou volée, la ligne d'opposition d'urgence est disponible 24h/24, 7j/7, sans connexion.",
          )
        : "";
    assistant = {
      kind: "refusal",
      text: lz(
        "I can't access your accounts in this session. The chat is signed out, so I have no view of your balances or cards and can't run account actions. Please sign in to the app, then ask me again and I'll pick it right up. Public how-to questions I can still help with here.",
        "Je ne peux pas accéder à vos comptes dans cette session. Vous n'êtes pas connecté, je n'ai donc aucune vue sur vos soldes ou vos cartes. Connectez-vous à l'application, puis reposez-moi la question. Les questions générales restent possibles ici.",
      ) + cardEmergency,
    };
    appendAudit(sessionId, requestId, "session_boundary", "session boundary → blocked (signed out); nothing read: no account data, no cards, no confirm, no SCA", {
      level: route.level,
      routeEnum: trace.routeEnum,
      tier: route.tier,
      action: route.action,
      note: "gate classified + policy routed; session boundary stopped it before the engine touched any account: no data, no card list, no confirm, no SCA",
    });
    trace.conversationModel = snapshotUsage()[MODELS.conversation] ? MODELS.conversation : "deterministic";
    return {
      requestId,
      trace,
      assistant,
      pendingAction: undefined,
      audit: getAudit(sessionId),
      gate,
      route,
      usage: snapshotUsage(),
      retrieved,
    };
  }

  switch (route.action) {
    case "escalate": {
      const priority = hasFraudSignal(gate);
      const queuePosition = priority ? 1 : 3;
      // FRAUD NEVER CLOSES. Support hours gate the ordinary human route, but the
      // emergency card-opposition line runs 24/7 - so an out-of-hours fraud fast-lane
      // appends that promise (customer-zone wording; the 24/7 fact is in the corpus).
      const fraud247 =
        priority && options.outOfHours
          ? lz(
              " For a lost or stolen card, the emergency opposition line is available 24/7.",
              " En cas de carte perdue ou volée, la ligne d'opposition d'urgence est disponible 24h/24, 7j/7.",
            )
          : "";
      const asyncIntake = !priority && options.outOfHours;
      const nextOpen = asyncIntake ? nextOpening(mockNow(true)) : null;
      const intakeRef = asyncIntake ? `H-${requestId.slice(-4).toUpperCase()}` : null;
      // HONESTY GUARD: transcript delivery and reply-by promises require an
      // identity to deliver TO. A signed-out visitor has no session and no app
      // inbox, so the assistant must never claim "your conversation has been
      // sent" - it points to sign-in and the phone channels instead. Fraud
      // stays served either way (the fast-lane needs no session).
      const anonymous = Boolean(options.signedOut) && !priority;
      assistant = {
        kind: "escalation",
        priority,
        queuePosition: anonymous || asyncIntake ? undefined : queuePosition,
        text: priority
          ? `${lz(
              "I've flagged this as a possible fraud or security issue and moved you to the front of the queue for a specialist advisor. I can't resolve disputes myself; a human handles this. Your card lock is available instantly if you need it right now.",
              "J'ai signalé un possible problème de fraude ou de sécurité et je vous ai placé en priorité pour un conseiller spécialisé. Je ne traite pas les litiges moi-même. C'est un conseiller qui s'en charge. Le blocage de votre carte est disponible immédiatement si besoin.",
            )}${fraud247}`
          : anonymous
            ? asyncIntake
              ? lz(
                  `Advisors are offline right now, and this chat is signed out, so I can't attach our conversation to your account. Sign in to the app to message an advisor (reply by ${nextOpen}), or call customer service when lines open. For a lost or stolen card, the emergency opposition line is available 24/7.`,
                  `Les conseillers sont actuellement hors ligne, et cette session n'est pas connectée : je ne peux pas rattacher notre conversation à votre compte. Connectez-vous à l'application pour écrire à un conseiller (réponse avant ${nextOpen}), ou appelez le service client à l'ouverture. En cas de carte perdue ou volée, la ligne d'opposition d'urgence est disponible 24h/24, 7j/7.`,
                )
              : lz(
                  "I can put you through to an advisor, but this chat is signed out, so I can't attach our conversation or your account details. Sign in to the app for a handoff with full context, or call customer service directly.",
                  "Je peux vous mettre en relation avec un conseiller, mais cette session n'est pas connectée : je ne peux pas transmettre notre conversation ni vos informations de compte. Connectez-vous à l'application pour un transfert avec tout le contexte, ou appelez directement le service client.",
                )
            : asyncIntake
              ? lz(
                  `Advisors are offline right now. Your conversation has been sent. An advisor will reply by ${nextOpen}. Reference ${intakeRef}.`,
                  `Les conseillers sont actuellement hors ligne. Votre conversation a été transmise. Un conseiller vous répondra avant ${nextOpen}. Référence ${intakeRef}.`,
                )
              : lz(
                  "I'll connect you with an advisor. I'm bringing them into this same conversation so you won't have to repeat anything.",
                  "Je vous mets en relation avec un conseiller. Il rejoint cette même conversation. Vous n'aurez rien à répéter.",
                ),
        transcriptCarry: anonymous
          ? undefined
          : asyncIntake
            ? lz(
                "Your conversation is shared with the advisor. Nothing to repeat.",
                "Votre conversation est partagée avec le conseiller. Rien à répéter.",
              )
            : lz(
                "Your conversation is shared with the advisor. You won't have to repeat yourself.",
                "Votre conversation est partagée avec le conseiller. Vous n'aurez pas à vous répéter.",
              ),
        // The one protective action whose worst case is milder than the risk it
        // mitigates - offered as a button, executed only through the same
        // deterministic confirm path (see boundaries sheet, lock/SCA defense).
        actionOffer: priority ? ("lock_card" as const) : undefined,
      };
      appendAudit(sessionId, requestId, "escalation", priority ? "fraud signals → human specialist, front of queue" : anonymous ? "human ask while signed out → no transcript promise (no session to attach it to); pointed to sign-in + phone channels" : asyncIntake ? `human handoff → async intake (out-of-hours), reply by ${nextOpen}` : "explicit ask → human advisor handoff", {
        priority,
        queuePosition,
        riskFlags: gate.riskFlags,
        outOfHours: Boolean(options.outOfHours),
        emergencyLine247: Boolean(fraud247),
      });
      break;
    }

    case "complaint_route": {
      // Exclusion #3 - two verbs IN (detect · route), everything else OUT. The
      // regulated réclamation process is the system of record: if the bot
      // collected complaint text in chat, the acknowledgment clock and the
      // verbatim custody of the complaint would be ambiguous. So this route is
      // DETERMINISTIC (no LLM call - the assistant literally cannot assess
      // fault, apologise for the substance, or offer goodwill): it DETECTS
      // (gate) and ROUTES to the official form, with an advisor one tap away.
      assistant = {
        kind: "complaint-route",
        text: lz(
          "Formal complaints (réclamations) go through the bank's dedicated process. It guarantees a response within the regulated timeframe, and what you write there goes directly on the record. I'll take you to the official complaint form, or an advisor can help you through it.",
          "Les réclamations suivent le processus dédié de la banque. Il garantit une réponse dans les délais réglementaires, et ce que vous y écrivez est directement enregistré. Je vous emmène au formulaire officiel de réclamation, ou un conseiller peut vous accompagner.",
        ),
        complaintRoute: { formLabel: lz("Open the complaint form", "Ouvrir le formulaire de réclamation"), formHref: "#complaint-form" },
      };
      appendAudit(sessionId, requestId, "complaint_route", "complaint intent → official réclamation form (nothing collected in chat)", {
        note: "detect → route; the chat never becomes the system of record for a regulated process: no intake, no fault assessment, escalation rights untouched",
      });
      break;
    }

    case "balance_read": {
      // One T0 route, two deterministic readouts. The gate's read_target field
      // (same call, no extra model round-trip) picks which; the regex is the
      // fallback if the field is missing. Both are authenticated reads - no
      // confirm, no SCA - and both are audited.
      const wantsTransactions = gate.readTarget
        ? gate.readTarget === "transactions"
        : TRANSACTIONS_RE.test(message);
      if (wantsTransactions) {
        const txns = readTransactions(sessionId, requestId);
        assistant = {
          kind: "balance",
          text: lz("Here are your latest transactions.", "Voici vos dernières opérations."),
          transactions: txns.map((t) => ({ date: t.date, description: t.description, amount: t.amount, currency: t.currency })),
        };
        break;
      }
      const acct = readBalance(sessionId, requestId);
      assistant = {
        kind: "balance",
        text: lz(
          `Your current balance is €${acct.balance.toLocaleString("en-IE", { minimumFractionDigits: 2 })}.`,
          `Votre solde actuel est de ${acct.balance.toLocaleString("fr-FR", { minimumFractionDigits: 2 })} €.`,
        ),
        balance: { holder: acct.holder, iban: acct.iban, balance: acct.balance, currency: acct.currency },
      };
      break;
    }

    case "refuse": {
      assistant = {
        kind: "refusal",
        text: lz(
          "That's outside what I can advise on. It needs a qualified advisor rather than a guess from me. Let me get one for you. I won't attempt an answer here.",
          "Cela dépasse ce sur quoi je peux me prononcer. Il faut un conseiller qualifié plutôt qu'une supposition de ma part. Je vous mets en relation. Je ne tenterai pas de répondre ici.",
        ),
        transcriptCarry: lz(
        "An advisor is taking over. They can see this conversation, so you won't have to repeat yourself.",
        "Un conseiller prend le relais - il peut voir cette conversation, vous n'aurez donc pas à vous répéter.",
      ),
      };
      appendAudit(sessionId, requestId, "refusal", "regulated advice topic → refused + human offered", { intent: gate.intent });
      break;
    }

    case "answer": {
      const hits = await retrieve(message, 3);
      retrieved = hits.map((h) => ({ id: h.chunk.id, title: h.chunk.title, text: h.chunk.text, score: h.score }));
      const top = hits[0]?.score ?? 0;
      appendAudit(sessionId, requestId, "retrieval", `${MODELS.embed} → retrieved ${hits.length} help-content chunks (best match ${top.toFixed(3)})`, {
        top,
        ids: hits.map((h) => h.chunk.id),
      });

      if (top < RETRIEVAL_THRESHOLD) {
        assistant = {
          kind: "refusal",
          text: lz(
            "I don't have a grounded source for that, so I won't guess. Let me connect you with an advisor who can help.",
            "Je n'ai pas de source fiable pour cela, donc je ne vais pas deviner. Je vous mets en relation avec un conseiller qui pourra vous aider.",
          ),
          transcriptCarry: lz(
        "An advisor is taking over. They can see this conversation.",
        "Un conseiller prend le relais - il peut voir cette conversation.",
      ),
        };
        appendAudit(sessionId, requestId, "refusal", "low retrieval confidence → refused + human offered", { top });
        break;
      }

      const answer = await answerFromSources(message, hits, gate.language);
      if (!answer.canAnswer) {
        assistant = {
          kind: "refusal",
          text: lz(
            "I couldn't ground that in our help content, so I won't guess. I'll bring in an advisor.",
            "Je n'ai pas pu appuyer cette réponse sur notre contenu d'aide, donc je ne vais pas deviner. Je fais appel à un conseiller.",
          ),
          transcriptCarry: lz(
        "An advisor is taking over. They can see this conversation.",
        "Un conseiller prend le relais - il peut voir cette conversation.",
      ),
        };
        appendAudit(sessionId, requestId, "refusal", `${MODELS.conversation} could not ground the answer → refusal + handoff`, {});
        break;
      }

      const citations = hits
        .filter((h) => answer.usedSourceIds.includes(h.chunk.id))
        .map((h) => ({ id: h.chunk.id, title: h.chunk.title, url: h.chunk.url, score: h.score }));
      const offer = hits.find((h) => h.chunk.id === citations[0]?.id)?.chunk.relatedAction;
      assistant = { kind: "answer", text: answer.text, citations, actionOffer: offer };
      // The generation step is an auditable event in its own right: which model,
      // what it consumed/produced - the model-pinning/lineage story, per turn.
      const gen = snapshotUsage()[MODELS.conversation];
      appendAudit(
        sessionId,
        requestId,
        "answer",
        `${MODELS.conversation} → grounded answer · ${citations.length} ${citations.length === 1 ? "citation" : "citations"}${
          gen ? ` · ${gen.promptTokens} in → ${gen.completionTokens} out tokens` : ""
        }`,
        { citedIds: answer.usedSourceIds, model: MODELS.conversation, usage: gen ?? null, actionOffer: offer ?? null },
      );
      break;
    }

    case "card_action": {
      const fallback = gate.intent === "unlock_card" ? "unlock_card" : "lock_card";
      const intent = await prepareCardIntent(message, fallback);
      appendAudit(sessionId, requestId, "tool_call", `${MODELS.conversation} → intent object: ${intent.action}`, {
        action: intent.action,
        cardHint: intent.cardHint ?? null,
        note: "model selects from real list - never generates a card number",
      });

      const { cards, matchedId } = resolveCards(sessionId, intent.cardHint);
      const selectedCardId = matchedId ?? cards[0].id;
      const tier = route.tier ?? "T1";
      const requiresSca = route.requiresSca;

      createPending({
        requestId,
        sessionId,
        intent: intent.action,
        tier,
        cardId: selectedCardId,
        requiresSca,
        language: gate.language,
        createdAt: new Date().toISOString(),
        confirmed: false,
      });

      const actionLabel = intent.action === "lock_card" ? lz("Lock card", "Verrouiller la carte") : lz("Unlock card", "Déverrouiller la carte");
      const selected = cards.find((c) => c.id === selectedCardId)!;
      const humanOffer = humanOfferAdvised(gate)
        ? lz(
            " And if you'd rather talk this through with someone, an advisor is one tap away.",
            " Et si vous préférez en parler avec quelqu'un, un conseiller est disponible en un clic.",
          )
        : "";
      // SERVE what you can, NAME what you can't. If the message carried a distinct
      // second request the assistant can't act on here (a limit change, a transfer…),
      // we never silently drop it: we serve the card action and name the rest, with a
      // path to a human. Generic across whatever "unserved" phrase the model named.
      const unservedNote = intent.unserved
        ? lz(
            ` ${intent.unserved.charAt(0).toUpperCase()}${intent.unserved.slice(1)} isn't something I can do here yet, but an advisor can help with that right after.`,
            ` « ${intent.unserved} » n'est pas encore possible ici, mais un conseiller peut vous aider juste après.`,
          )
        : "";
      assistant = {
        kind: "action-confirm",
        text:
          (intent.action === "lock_card"
            ? lz(
                `I've prepared a lock on ${selected.label}. One tap to confirm and it's done. You can unlock again any time.`,
                `J'ai préparé le blocage de ${selected.label}. Une validation et c'est fait. Vous pourrez débloquer à tout moment.`,
              ) + humanOffer
            : lz(
                `I've prepared an unlock on ${selected.label}. For your security, unlocking needs a quick approval in your banking app. Confirm the card, then approve on your device.`,
                `J'ai préparé le déblocage de ${selected.label}. Pour votre sécurité, le déblocage nécessite une validation rapide dans votre application bancaire. Confirmez la carte, puis validez sur votre appareil.`,
              )) +
          unservedNote,
      };
      pendingAction = {
        requestId,
        action: intent.action,
        tier,
        actionLabel,
        requiresSca,
        cards,
        selectedCardId,
      };
      break;
    }

    case "transfer_stub":
    default: {
      appendAudit(sessionId, requestId, "transfer_stub", "payment request → declined (not enabled in pilot scope)", {});
      assistant = {
        kind: "info",
        text: lz(
          "Transfers aren't available in the assistant yet. You can make transfers in your app as usual, or I can connect you with an advisor.",
          "Les virements ne sont pas encore disponibles dans l'assistant. Vous pouvez faire vos virements dans l'application comme d'habitude, ou je peux vous mettre en relation avec un conseiller.",
        ),
      };
      break;
    }
  }

  // 3) MODERATION - DE-ESCALATE AND STILL SERVE. An abusive-but-legitimate turn is
  // never refused for tone: the route above already prepared the customer's request
  // (lock, answer, intake…); this adds a calm acknowledgement and makes sure a human
  // is offered. This is a TONE signal ONLY - driven by the deterministic frustration
  // detector, NOT by any moderation category. The Moderation model honestly PASSES a
  // vent like "you useless bot" (top category ~0.04, below threshold), and the CONTEXT
  // categories (pii/financial/law/health) are ordinary banking content that must NEVER
  // trigger an apology - so "Lock my Visa ending 4471" (a pii hit) stays a clean lock.
  // Gated by the toggle, so the eval - which runs with moderation off - is unperturbed.
  // (severe already returned above, so routing here is clean/context/unavailable/off)
  // De-escalation enhances any SERVING outcome - including an escalation (a served
  // human-handoff): the recall-biased gate often reads a frustrated vent like
  // "your app ate my card, fix it NOW" as fraud_distress and fast-lanes it to a human.
  // That IS still serving (priority advisor + instant card-lock offer); we just add the
  // calm acknowledgement. Only a hard refusal stays firm.
  const deEscalate =
    Boolean(options.moderationEnabled) &&
    frustrationSignal(message) &&
    assistant.kind !== "refusal";
  if (deEscalate) {
    trace.moderation!.deEscalated = true;
    appendAudit(sessionId, requestId, "de_escalation", "frustration signal (deterministic) → tone de-escalated, request still served", {
      note: "response transformation, not a refusal - driven by frustrationSignal(), never by a moderation category",
    });
    assistant = {
      ...assistant,
      text: `${lz(
        "I'm sorry this has been so frustrating - I want to get it sorted for you.",
        "Je suis désolé que ce soit aussi frustrant - je veux régler cela pour vous.",
      )} ${assistant.text}`,
      transcriptCarry:
        assistant.transcriptCarry ??
        lz(
          "If you'd rather not deal with this alone, an advisor can take over - they'll see everything so far.",
          "Si vous préférez ne pas gérer cela seul, un conseiller peut prendre le relais - il verra tout l'historique.",
        ),
    };
    appendAudit(sessionId, requestId, "moderation", "abusive-but-legitimate turn → served with calm tone + human offered (never refused for tone)", {
      routing: moderation.routing,
      flagged: moderation.flaggedCategories,
      frustrationSignal: frustrationSignal(message),
      level: route.level,
      note: "verdict is a routing signal - tone never refuses service; the customer's request was still prepared",
    });
  }

  trace.conversationModel = snapshotUsage()[MODELS.conversation] ? MODELS.conversation : "deterministic";
  return {
    requestId,
    trace,
    assistant,
    pendingAction,
    audit: getAudit(sessionId),
    gate,
    route,
    usage: snapshotUsage(),
    retrieved,
  };
}
