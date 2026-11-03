import { redactEvidence, type WorkspaceSaveRequest } from '@agnes/core'
import type { SaveRefusal } from '@agnes/host-infrastructure/refinement-registry'

/** Longest title and content a saved entry may have: what a refinement edit may carry. */
const MAX_TITLE = 256
const MAX_CONTENT = 2000
const MAX_EVIDENCE = 64
/** The longest command or run id: what a memory write records as its maintenance id. */
const MAX_ID = 128

/**
 * Credentials the file memory provider refuses to store (its `validateContent` check), restated here so
 * the source rules refuse them before any memory provider is asked, whichever provider is selected.
 */
export const SECRET_LIKE =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*["']?[^\s"']{8,}/i

/** The text a saved memory or prompt entry becomes in workspace memory: its title, a line break, its content. */
export const paragraphText = (entry: Pick<WorkspaceSaveRequest['entry'], 'title' | 'content'>): string =>
  `${entry.title}\n${entry.content}`

/**
 * The source and safety rules every save meets, whoever asked:
 * - it comes from a top-level session, never a child or a fork (`child-session`);
 * - its command id and run id are 1 to 128 characters;
 * - the entry holds for the session, not for one task;
 * - it cites evidence, every piece a row of this session (a seq in `[1, lastSeq]` of its ledger);
 * - its title and content come through credential redaction unchanged, and hold nothing the memory
 *   module treats as a credential.
 * Returns the refusal, or undefined when every rule holds.
 */
export function sourceRuleProblem(request: WorkspaceSaveRequest): SaveRefusal | undefined {
  if (request.session.child) return 'child-session'
  const { entry, evidenceSeqs, session } = request
  const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID
  if (!id(request.commandId) || (request.runId !== undefined && !id(request.runId))) return 'source-rules'
  if (entry.applicability !== 'session') return 'source-rules'
  if (!Array.isArray(evidenceSeqs) || evidenceSeqs.length === 0 || evidenceSeqs.length > MAX_EVIDENCE)
    return 'source-rules'
  if (!evidenceSeqs.every((seq) => Number.isSafeInteger(seq) && seq >= 1 && seq <= session.lastSeq))
    return 'source-rules'
  if (typeof entry.title !== 'string' || entry.title.length === 0 || entry.title.length > MAX_TITLE)
    return 'source-rules'
  if (typeof entry.content !== 'string' || entry.content.length === 0 || entry.content.length > MAX_CONTENT)
    return 'source-rules'
  if (redactEvidence(entry.title) !== entry.title || redactEvidence(entry.content) !== entry.content)
    return 'source-rules'
  if (SECRET_LIKE.test(paragraphText(entry))) return 'source-rules'
  return undefined
}
