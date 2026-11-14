// Adapted from dsh-superagent (MIT)
/** What a worker is told: its ticket's execution, its inputs, and the extra limits of a proactively accepted ticket. */
import { join } from 'node:path'
import { WorktreeNameSchema } from '../app/assessment.js'
import { executionRoot } from '../app/execution-environment.js'
import type { Store } from '../app/store.js'
import type {
  AssessmentOutcome,
  Execution,
  Mandate,
  PolicyEffect,
  Ticket,
  TicketInput,
  Trigger,
} from '../core/index.js'
import type { Settings } from '../policy.js'

/** Looks up a ticket's origin trigger in Store. */
export const sourceTrigger = (
  host: { store: Pick<Store, 'triggers'> },
  ticket: Ticket,
): Trigger | undefined => host.store.triggers.get(ticket.origin.triggerId)
/** Returns the other triggers in a ticket's origin batch (excluding the primary `origin.triggerId`), oldest first. */
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] =>
  ticket.origin.triggerIds
    .filter((id) => id !== ticket.origin.triggerId)
    .flatMap((id) => host.store.triggers.get(id) ?? [])

/**
 * Additional instructions for a worker beyond the request: work accepted proactively under rules (`inferred`) is limited
 * to small internal changes within the rule scope; an explicit request adds none.
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred'
    ? 'This ticket has limited proactive authorization. Independently verify that it is a small change ' +
        'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product ' +
        'decisions or clarification, stop and report dropped; do not expand scope.'
    : ''
}
/** Appends a stable 12-character ticket ID suffix to a validated English worktree name. */
const ticketWorktreeName = (name: string, id: string): string =>
  `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** Builds a newly accepted ticket's Execution metadata: its short name, ticket directory, and assignment text. */
export function ticketExecution(
  ticket: Ticket,
  outcome: Extract<AssessmentOutcome, { kind: 'accept' }>,
  settings: Settings,
  stateDir: string,
): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules
    .filter((rule) => ruleIds?.includes(rule.id))
    .map((rule) => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`)
    .join('')
  const precedence = rules
    ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}`
    : ''
  // The origin trigger is delivered alongside the assignment, so `assignment` omits the trigger text.
  const assignment =
    ticket.mandate.strength === 'inferred' && ruleIds
      ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
      : note.trim()
  return { name, directory: join(executionRoot(settings, stateDir), name), assignment }
}

export const RESUMED =
  'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for ' +
  'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or ' +
  'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, ' +
  'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
export const RETRIED =
  'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
/** Formats a policy-change input for the worker; inputs recorded before `effect` existed fall back to a general notice. */
function policyMessage(effect?: PolicyEffect): string {
  if (!effect)
    return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return [
    'Policy change:',
    ...(effect.rules ?? []).map((rule) =>
      rule.change === 'disabled'
        ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
        : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`,
    ),
    ...(effect.proactive === false
      ? [
          'Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only ' +
            'what is in progress within the assignment, or report dropped, and take on nothing new.',
        ]
      : []),
    ...(effect.requesterAllowed === false
      ? [
          `The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`,
        ]
      : []),
  ].join('\n')
}
/**
 * Formats a ticket input for its worker: a `trigger` rendered via `trigger` (or by its ID and read path when absent), a
 * `policy-changed` notice, a `resumed` notice, an orchestrator `note`, or a `text` input as written; `undefined` for a
 * legacy `reopen` input.
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // Mark triggers arriving on context-only subscriptions so the worker knows they are not addressed to the ticket.
  if (input.kind === 'trigger')
    return JSON.stringify({
      ...(trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` }),
      ...(input.context ? { context: true } : {}),
    })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
/** True when an input comes from a person (a non-context human trigger or a direct text input such as a status request). */
export const fromPerson = (input?: TicketInput): boolean =>
  input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'

const PASSING = new RegExp(
  [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
    'UND_ERR',
    'socket hang up',
    'fetch failed',
    'network error',
    'overloaded',
    'rate limit',
    '\\b(?:408|429|50[0-4])\\b',
  ].join('|'),
  'i',
)
/** True for a passing network or model-provider failure: HTTP 408, 429 or 5xx, or a refused, reset or timed-out connection. */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text =
    error instanceof Error
      ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}`
      : String(error)
  return PASSING.test(text)
}
