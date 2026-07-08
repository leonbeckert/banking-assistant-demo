// Immutable-append audit log. Every gate decision, tool call, confirm, SCA event
// and bank execution lands here with a request ID. Deterministic, no LLM.
import { getSession } from "./store";
import type { AuditEntry, AuditType } from "./types";

export function appendAudit(
  sessionId: string,
  requestId: string,
  type: AuditType,
  summary: string,
  detail: Record<string, unknown> = {},
): AuditEntry {
  const s = getSession(sessionId);
  s.auditSeq += 1;
  const entry: AuditEntry = {
    seq: s.auditSeq,
    ts: new Date().toISOString(),
    requestId,
    sessionId,
    type,
    summary,
    detail,
  };
  s.audit.push(entry);
  return entry;
}

export function getAudit(sessionId: string): AuditEntry[] {
  return getSession(sessionId).audit;
}
