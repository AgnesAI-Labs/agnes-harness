// One runtime question or approval answered from the terminal. The request kind picks the route: a
// question is answered only through interaction respond and an approval only through approval respond,
// so a question's confirm field stays a business answer and never becomes an approval. Input is parsed
// locally from numbers and explicit yes or no, and no model is involved. A question's answers are echoed
// and confirmed before anything is sent; an approval choice is its own confirmation, except a permanent
// grant, which asks again. A question with a field this client cannot ask goes to the Web as a whole.
//
// Each submit intent has one response id, which the transport journals before sending. Nothing here
// resends on its own: while an outcome is unknown the id is kept, a new answer is refused, and the user
// either checks its status or sends the same request again.
import { randomUUID } from 'node:crypto'
import { jcs } from '@agnes/protocol'
import {
  type ApprovalRequest,
  type ApprovalRespondRequest,
  type ClientInteractionFormLinkInput,
  canonicalJsonDigest,
  type InteractionClientRespondRequest,
  type InteractionFormLink,
  type InteractionRecord,
  type InteractionResponseStatus,
  type JsonValue,
  type QuestionField,
  RuntimeApprovalIntentPolicy,
} from '@agnes/protocol/runtime'
import type { PendingCommand } from '@agnes/sdk'
import { escapeServerText } from '../component.js'
import { type LocaleKey, t } from '../locale.js'
import { linkUrl, type RuntimeCallResult } from './ports.js'

type Status = RuntimeCallResult<InteractionResponseStatus>
export type QuestionPorts = Readonly<{
  read(interactionId: string): Promise<RuntimeCallResult<InteractionRecord>>
  respond(input: InteractionClientRespondRequest): Promise<Status>
  respondApproval(input: ApprovalRespondRequest): Promise<Status>
  responseStatus(responseId: string): Promise<Status>
  formLink(input: ClientInteractionFormLinkInput): Promise<RuntimeCallResult<InteractionFormLink>>
  /** The runtime journal's pending commands, read after the transport's recover(). */
  pendingJournal(): Promise<readonly PendingCommand[]>
}>
export type QuestionPhase =
  | 'editing'
  | 'confirming'
  | 'submitting'
  | 'applied'
  | 'accepted'
  | 'handled-elsewhere'
  | 'unknown'
  | 'form-required'
  | 'read-only'
  | 'closed'

type Params = InteractionClientRespondRequest | ApprovalRespondRequest
type Attempt = { method: 'interaction.respond' | 'approval.respond'; params: Params }
type GrantScope = 'once' | 'session' | 'permanent'
type Decision = { decision: 'approve'; grantScope: GrantScope } | { decision: 'deny' }
type AnswerableField = Exclude<QuestionField, { kind: 'custom' }>
type Parsed = { value: JsonValue } | { error: LocaleKey; vars?: Record<string, number> }

// The transport's typed refusals before admission; it has already cleared their journal entries.
const REFUSED = new Set(['invalid_input', 'denied', 'incompatible', 'quota', 'conflict'])
const ANSWERABLE = new Set(['text', 'singleChoice', 'multiChoice', 'confirm'])
const GRANT: Record<GrantScope, LocaleKey> = {
  once: 'approval.allowOnce',
  session: 'approval.allowSession',
  permanent: 'approval.allowPermanent',
}
const lines = (text: string) => escapeServerText(text).split('\n')
const oneLine = (text: string) => escapeServerText(text).replace(/\n/g, ' ')
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A number from 1 to `max`, written as plain digits. */
function pick(text: string, max: number): number | undefined {
  const digits = text.trim()
  const n = /^[1-9][0-9]*$/.test(digits) ? Number(digits) : 0
  return n >= 1 && n <= max ? n : undefined
}

/** Only an explicit yes or no counts; an empty line is never a default. */
function yesNo(text: string): boolean | undefined {
  const word = text.trim().toLowerCase()
  return word === 'yes' ? true : word === 'no' ? false : undefined
}

/** The rules the interaction owner applies to each field, checked before anything is sent. */
function parse(field: AnswerableField, text: string): Parsed {
  if (field.kind === 'text') {
    if (!field.multiline && /[\r\n]/.test(text)) return { error: 'runtime.question.singleLine' }
    return text.length > field.maxLength
      ? { error: 'runtime.question.tooLong', vars: { max: field.maxLength } }
      : { value: text }
  }
  if (field.kind === 'confirm') {
    const answer = yesNo(text)
    return answer === undefined ? { error: 'runtime.question.yesNo' } : { value: answer }
  }
  const max = field.options.length
  if (field.kind === 'singleChoice') {
    const n = pick(text, max)
    return n === undefined
      ? { error: 'runtime.question.pickOne', vars: { max } }
      : { value: field.options[n - 1]?.id ?? '' }
  }
  const picked = text.trim() === '' ? [] : text.split(',').map((part) => pick(part, max))
  const numbers = picked.filter((n) => n !== undefined)
  if (numbers.length !== picked.length) return { error: 'runtime.question.pickMany', vars: { max } }
  if (new Set(numbers).size !== numbers.length) return { error: 'runtime.question.duplicate' }
  if (numbers.length < field.minItems || numbers.length > field.maxItems)
    return { error: 'runtime.question.count', vars: { min: field.minItems, max: field.maxItems } }
  return { value: numbers.map((n) => field.options[n - 1]?.id ?? '') }
}

/** One answered field as the user reads it: option labels, never option ids. */
function shown(field: QuestionField, given: JsonValue): string {
  const label = (id: JsonValue) =>
    ('options' in field ? field.options.find((option) => option.id === id)?.label : undefined) ?? String(id)
  if (field.kind === 'confirm') return given === true ? 'yes' : 'no'
  if (Array.isArray(given)) return given.map(label).join(', ')
  return field.kind === 'text' ? String(given) : label(given)
}

export class QuestionController {
  phase: QuestionPhase = 'closed'
  private current: InteractionRecord | undefined
  private answers: Record<string, JsonValue> = {}
  private field = 0
  /** What the user is confirming or may send again; the response id is assigned when it is sent. */
  private draft: Params | undefined
  private attempt: Attempt | undefined

  constructor(
    private readonly ports: QuestionPorts,
    private readonly options: Readonly<{ locale: string; baseUrl: string }>,
  ) {}

  /** Loads the interaction and any answer to it the journal still holds, and returns its screen. */
  async open(interactionId: string): Promise<string[]> {
    this.current = undefined
    this.attempt = undefined
    this.restart()
    this.phase = 'closed'
    const read = await this.ports.read(interactionId)
    if (read.state !== 'ok') return [this.t('runtime.question.unreadable')]
    const current = read.value
    this.current = current
    if (current.status !== 'pending') return [...this.heading(), ...this.outcome(current)]
    const saved = (await this.ports.pendingJournal()).find(
      (entry) =>
        (entry.method === 'interaction.respond' || entry.method === 'approval.respond') &&
        record(entry.params) &&
        entry.params.interactionId === interactionId,
    )
    if (saved) {
      this.attempt = { method: saved.method as Attempt['method'], params: saved.params as Params }
      this.draft = this.attempt.params
      this.phase = 'unknown'
      return [...this.heading(), this.t('runtime.question.unknown')]
    }
    const { request } = current
    if (
      request.kind === 'question' &&
      request.fields.some((field) => !ANSWERABLE.has(field.kind) || !field.required)
    ) {
      this.phase = 'form-required'
      return [...this.heading(), this.t('runtime.question.formRequired')]
    }
    this.phase = 'editing'
    return [...this.heading(), ...this.next()]
  }

  /** One line the user typed: a field answer, an approval choice, or yes or no to the echoed request. */
  async input(text: string): Promise<string[]> {
    const request = this.current?.request
    if (!request) return []
    if (this.phase === 'unknown') return [this.t('runtime.question.unknownBlocked')]
    if (this.phase === 'confirming') {
      const answer = yesNo(text)
      if (answer === undefined) return [this.t('runtime.question.yesNo')]
      if (answer) return this.submit()
      this.restart()
      this.phase = 'editing'
      return this.next()
    }
    if (this.phase !== 'editing') return []
    if (request.kind === 'approval') {
      const choices = this.choices(request)
      const n = pick(text, choices.length)
      const choice = n === undefined ? undefined : choices[n - 1]
      if (!choice) return [this.t('runtime.question.pickOne', { max: choices.length })]
      // The intent digest is the request's own, never recomputed here; a denial carries no grant scope.
      const { intentDigest } = request
      this.draft = this.params(
        choice.decision === 'approve'
          ? { decision: 'approve', grantScope: choice.grantScope, intentDigest }
          : { decision: 'deny', intentDigest },
      )
      // A permanent grant outlives this request, so it takes a second, explicit confirmation.
      if (choice.decision === 'approve' && choice.grantScope === 'permanent') return this.confirm()
      return this.submit()
    }
    const field = request.fields[this.field] as AnswerableField | undefined
    if (!field) return []
    const parsed = parse(field, text)
    if ('error' in parsed) return [this.t(parsed.error, parsed.vars)]
    this.answers[field.id] = parsed.value
    this.field++
    return this.next()
  }

  /** Asks the owner how the response whose outcome is unknown went. */
  async checkStatus(): Promise<string[]> {
    if (this.phase !== 'unknown' || !this.attempt) return []
    return this.settle(await this.ports.responseStatus(this.attempt.params.responseId), false)
  }

  /** Sends the response whose outcome is unknown again, with the same id and the same content. */
  async resubmit(): Promise<string[]> {
    return this.phase === 'unknown' && this.attempt ? this.send(this.attempt) : []
  }

  /** A form link for a question this client cannot ask; the question stays pending either way. */
  async requestFormLink(): Promise<string[]> {
    const current = this.current
    if (this.phase !== 'form-required' || !current) return []
    const link = await this.ports.formLink({
      interactionId: current.interactionId,
      expectedVersion: current.version,
    })
    const url = link.state === 'ok' ? linkUrl(this.options.baseUrl, link.value.url) : undefined
    if (link.state !== 'ok' || url === undefined) return [this.t('runtime.view.needsWeb')]
    return [
      this.t('runtime.question.formLink', { url: oneLine(url), expiresAt: oneLine(link.value.expiresAt) }),
    ]
  }

  private t(key: LocaleKey, vars: Readonly<Record<string, string | number>> = {}): string {
    return t(key, this.options.locale, vars)
  }

  private restart(): void {
    this.answers = {}
    this.field = 0
    this.draft = undefined
  }

  private heading(): string[] {
    const request = this.current?.request
    if (!request) return []
    const out = [oneLine(request.title), ...lines(request.body)]
    if (request.kind === 'question') return out
    const { kind, ...ids } = request.scope
    const scope = `${kind} (${Object.entries(ids)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ')})`
    // Everything the approval binds is shown in full; the terminal wraps it, nothing is cut.
    for (const [key, value] of [
      ['runtime.approval.action', request.actionRef],
      ['runtime.approval.inputDigest', request.inputDigest],
      ['runtime.approval.intentDigest', request.intentDigest],
      ['runtime.approval.scope', scope],
      ['runtime.approval.risk', request.risk],
    ] as const)
      out.push(this.t(key, { value: oneLine(value) }))
    return out
  }

  /** Grant scopes come only from the request, in its order; an absent list means the policy default. */
  private choices(request: ApprovalRequest): Decision[] {
    const scopes = request.allowedGrantScopes ?? RuntimeApprovalIntentPolicy.defaultAllowedGrantScopes
    return [
      ...scopes.map((grantScope) => ({ decision: 'approve' as const, grantScope })),
      { decision: 'deny' },
    ]
  }

  /** The prompt for the next unanswered field, or the echo once every field has an answer. */
  private next(): string[] {
    const request = this.current?.request
    if (request?.kind === 'approval') {
      const choices = this.choices(request).map((choice, index) => `[${index + 1}] ${this.decision(choice)}`)
      return [...choices, this.t('runtime.question.pickOne', { max: choices.length })]
    }
    if (!request) return []
    const field = request.fields[this.field] as AnswerableField | undefined
    if (!field) {
      const value = { ...this.answers }
      const bytes = new TextEncoder().encode(jcs(value)).length
      const answer = {
        kind: 'inline' as const,
        schema: request.answerSchema,
        value,
        digest: canonicalJsonDigest(value),
        bytes,
      }
      this.draft = this.params({ answer })
      return this.confirm()
    }
    const out = [oneLine(field.label)]
    if (field.kind === 'text') out.push(this.t('runtime.question.text', { max: field.maxLength }))
    else if (field.kind === 'confirm') out.push(oneLine(field.statement), this.t('runtime.question.yesNo'))
    else {
      out.push(...field.options.map((option, index) => `[${index + 1}] ${oneLine(option.label)}`))
      const max = field.options.length
      out.push(
        this.t(field.kind === 'singleChoice' ? 'runtime.question.pickOne' : 'runtime.question.pickMany', {
          max,
        }),
      )
    }
    return out
  }

  private params(body: object): Params {
    const current = this.current as InteractionRecord
    return {
      ...body,
      interactionId: current.interactionId,
      responseId: '',
      expectedVersion: current.version,
    } as Params
  }

  private confirm(): string[] {
    this.phase = 'confirming'
    const draft = this.draft
    const answer = draft && 'answer' in draft ? draft.answer : undefined
    const value = answer ? (answer.kind === 'inline' ? answer.value : undefined) : draft
    const out = [this.t('runtime.question.willSubmit'), ...this.describe(value)]
    if (draft && 'grantScope' in draft && draft.grantScope === 'permanent')
      out.push(this.t('runtime.question.permanent'))
    return [...out, this.t('runtime.question.confirmSubmit')]
  }

  private decision(choice: Decision): string {
    return this.t(choice.decision === 'approve' ? GRANT[choice.grantScope] : 'approval.reject')
  }

  /** What an approval decision or a question's answer value says, in the user's terms. */
  private describe(answer: unknown): string[] {
    const request = this.current?.request
    if (!request || !record(answer)) return []
    if (request.kind === 'approval') {
      const scope = answer.grantScope
      const approved =
        answer.decision === 'approve' && (scope === 'once' || scope === 'session' || scope === 'permanent')
      return [
        `  ${this.decision(approved ? { decision: 'approve', grantScope: scope } : { decision: 'deny' })}`,
      ]
    }
    return request.fields.flatMap((field) => {
      const given = answer[field.id] as JsonValue | undefined
      // A custom field answered on the Web has no terminal form; it is left out rather than guessed at.
      if (given === undefined || !ANSWERABLE.has(field.kind)) return []
      return [`  ${oneLine(field.label)}: ${oneLine(shown(field, given))}`]
    })
  }

  /** A closed record's final state. */
  private outcome(closed: InteractionRecord): string[] {
    if (closed.status === 'expired') return [this.t('runtime.question.expired')]
    if (closed.status === 'cancelled') return [this.t('runtime.question.cancelled')]
    return closed.status === 'answered'
      ? [this.t('runtime.question.answered'), ...this.resolution(closed)]
      : []
  }

  /** The answer an answered record holds; one kept outside the record as a blob is not fetched. */
  private resolution(closed: InteractionRecord | null): string[] {
    const answer = closed?.status === 'answered' ? closed.resolution.answer : undefined
    return answer?.kind === 'inline' ? this.describe(answer.value) : []
  }

  /** Reuses the id of the last request sent when the content is unchanged, so the owner sees one response. */
  private async submit(): Promise<string[]> {
    const draft = this.draft
    if (!draft) return []
    const kept = this.attempt
    const same =
      kept !== undefined && jcs({ ...kept.params, responseId: '' }) === jcs({ ...draft, responseId: '' })
    const method = this.current?.request.kind === 'approval' ? 'approval.respond' : 'interaction.respond'
    const responseId = same && kept ? kept.params.responseId : randomUUID()
    return this.send({ method, params: { ...draft, responseId } })
  }

  private async send(attempt: Attempt): Promise<string[]> {
    this.attempt = attempt
    this.draft = attempt.params
    this.phase = 'submitting'
    const result =
      attempt.method === 'approval.respond'
        ? await this.ports.respondApproval(attempt.params as ApprovalRespondRequest)
        : await this.ports.respond(attempt.params as InteractionClientRespondRequest)
    return this.settle(result, true)
  }

  private async settle(result: Status, sent: boolean): Promise<string[]> {
    const attempt = this.attempt as Attempt
    if (result.state === 'ok' && result.value.responseId === attempt.params.responseId) {
      const status = result.value
      // Never admitted: still pending, and sending again keeps the same id.
      if (status.status === 'not-accepted') return [this.t('runtime.question.notAccepted'), ...this.confirm()]
      if (status.status === 'rejected') return this.elsewhere()
      this.attempt = undefined
      this.phase = status.status
      const head = this.t(
        status.status === 'applied' ? 'runtime.question.answered' : 'runtime.question.accepted',
      )
      return [head, ...this.resolution(status.result)]
    }
    // The owner answers a stale expected version this way when another client won.
    if (result.state === 'failed' && result.error.detailCode === 'revision_conflict') return this.elsewhere()
    if (sent && result.state === 'failed' && REFUSED.has(result.error.code)) {
      this.attempt = undefined
      return [
        this.t('runtime.question.refused', { reason: oneLine(result.error.message) }),
        ...this.confirm(),
      ]
    }
    if (sent && result.state === 'refused') {
      if (result.reason !== 'reload-required')
        return [this.t('runtime.question.notSent', { reason: oneLine(result.reason) }), ...this.confirm()]
      this.phase = 'read-only'
      return [this.t('runtime.question.readOnly')]
    }
    this.phase = 'unknown'
    return [this.t('runtime.question.unknown')]
  }

  /** Another client answered first; shows what won. */
  private async elsewhere(): Promise<string[]> {
    this.attempt = undefined
    this.phase = 'handled-elsewhere'
    const current = this.current as InteractionRecord
    const read = await this.ports.read(current.interactionId)
    return [
      this.t('runtime.question.handledElsewhere'),
      ...(read.state === 'ok' ? this.outcome(read.value) : []),
    ]
  }
}
