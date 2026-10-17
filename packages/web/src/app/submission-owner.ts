import {
  type PendingCommand,
  type Session,
  type UnresolvedSubmission,
  unresolvedSubmission,
} from '@agnes/sdk/browser'
import type { SessionBinding, SessionBindingOwner } from './session-owner.js'

type BindingReader = Pick<SessionBindingOwner, 'capture' | 'isCurrent'>
export type SubmissionPhase =
  | 'draft'
  | 'submitting'
  | 'accepted'
  | 'needs-confirmation'
  | 'failed'
  | 'refused'
export type QueueSubmission = Readonly<{ itemId: string; kind: 'sendNow' | 'removeQueued' | 'promote' }>

/** One user intent; the SDK remains the owner of durable command identity and replay. */
export class Submission {
  private phase: SubmissionPhase = 'draft'
  private work: Promise<void> | undefined
  private command: UnresolvedSubmission | undefined
  private failure: unknown
  private message: string | undefined
  private checking: Promise<void> | undefined

  constructor(
    private binding: SessionBinding,
    readonly queue?: QueueSubmission,
  ) {}

  get snapshot(): Readonly<{ phase: SubmissionPhase; command?: UnresolvedSubmission; error?: unknown }> {
    return {
      phase: this.phase,
      ...(this.command ? { command: { ...this.command } } : {}),
      ...(this.failure ? { error: this.failure } : {}),
    }
  }
  start(): void {
    if (this.phase === 'draft') this.phase = 'submitting'
  }
  presentError(message: string): void {
    this.message = message
  }
  get error(): string | undefined {
    return this.message
  }
  get pending(): boolean {
    return this.phase === 'submitting'
  }
  belongsTo(owner: BindingReader, session?: Session): boolean {
    return owner.isCurrent(this.binding, session)
  }
  adopt(binding: SessionBinding): void {
    this.binding = binding
  }

  /** Repeated consumers share this promise; they cannot dispatch a second command. */
  run(send: () => Promise<void>): Promise<void> {
    if (this.work) return this.work
    if (this.command) return Promise.reject(new Error('Submission requires confirmation'))
    this.phase = 'submitting'
    this.work = Promise.resolve()
      .then(send)
      .then(
        () => {
          this.accept()
        },
        (error: unknown) => {
          this.command = unresolvedSubmission(error)
          this.failure = error
          const code = (error as { data?: { code?: unknown } } | null)?.data?.code
          this.phase = this.command ? 'needs-confirmation' : typeof code === 'string' ? 'refused' : 'failed'
          throw error
        },
      )
    return this.work
  }
  accept(): void {
    this.phase = 'accepted'
    this.command = undefined
    this.failure = undefined
  }
  restore(sessionId: string, command: PendingCommand): void {
    this.command = { sessionId, commandId: command.commandId, state: command.state ?? 'pending' }
    this.phase = 'needs-confirmation'
  }
  check(session: Session): Promise<void> {
    if (this.checking) return this.checking
    const command = this.command
    if (!command || session.id !== command.sessionId) return Promise.resolve()
    this.checking = (async () => {
      let failure: unknown
      try {
        await session.checkCommand(command.commandId)
      } catch (error) {
        failure = error
      }
      const remaining = (await session.pendingCommands()).find(
        (entry) => entry.commandId === command.commandId,
      )
      if (remaining) this.restore(session.id, remaining)
      else if (failure !== undefined) {
        this.command = undefined
        this.failure = failure
        this.phase =
          typeof (failure as { data?: { code?: unknown } } | null)?.data?.code === 'string'
            ? 'refused'
            : 'failed'
      } else this.accept()
    })().finally(() => {
      this.checking = undefined
    })
    return this.checking
  }
}

/** Binding-scoped presentation of composer, queue and recovered SDK submissions. */
export class SubmissionOwner {
  private control: Submission | undefined
  private composer: Submission | undefined
  private queued: Submission | undefined
  private recovered = new Map<string, Submission>()
  private recoveryRequest = 0
  private prompt: Submission | undefined

  constructor(private readonly binding: BindingReader) {}
  get controlPending(): boolean {
    return !!this.control?.belongsTo(this.binding) && this.control.pending
  }
  beginControl(): Submission | undefined {
    if (this.controlPending) return undefined
    const submission = new Submission(this.binding.capture())
    submission.start()
    this.control = submission
    return submission
  }
  get currentComposer(): Submission | undefined {
    return this.composer?.belongsTo(this.binding) ? this.composer : undefined
  }
  get queueAction(): Readonly<QueueSubmission & { pending: boolean; error?: string }> | undefined {
    const submission = this.queue
    return (
      submission?.queue && {
        ...submission.queue,
        pending: submission.pending,
        ...(submission.error ? { error: submission.error } : {}),
      }
    )
  }
  get sending(): boolean {
    return !!this.composer?.belongsTo(this.binding) && this.composer.pending
  }
  get queue(): Submission | undefined {
    return this.queued?.belongsTo(this.binding) ? this.queued : undefined
  }
  isCurrent(submission: Submission, session?: Session): boolean {
    return (
      (submission === this.composer || submission === this.queued || submission === this.control) &&
      submission.belongsTo(this.binding, session)
    )
  }
  beginComposer(awaitPrompt: boolean): Submission | undefined {
    if (this.sending) return undefined
    const submission = new Submission(this.binding.capture())
    submission.start()
    this.composer = submission
    this.prompt = awaitPrompt ? submission : undefined
    return submission
  }
  beginQueue(queue: QueueSubmission): Submission | undefined {
    if (this.queue?.pending) return undefined
    const submission = new Submission(this.binding.capture(), queue)
    submission.start()
    this.queued = submission
    return submission
  }
  promptStarted(): void {
    if (this.prompt && this.isCurrent(this.prompt) && this.prompt.pending) this.prompt.accept()
    this.prompt = undefined
  }
  /** Reconstruct after reload, and reject a read that raced a session switch or newer refresh. */
  async recover(session: Session): Promise<readonly Submission[] | undefined> {
    const binding = this.binding.capture()
    const request = ++this.recoveryRequest
    const commands = await session.pendingCommands()
    if (!this.binding.isCurrent(binding, session) || request !== this.recoveryRequest) return undefined
    const next = new Map<string, Submission>()
    for (const command of commands) {
      const record = [this.composer, this.queued, this.control, this.recovered.get(command.commandId)].find(
        (entry) =>
          entry?.snapshot.command?.commandId === command.commandId && entry.belongsTo(this.binding, session),
      )
      const submission = record?.belongsTo(this.binding) ? record : new Submission(binding)
      submission.restore(session.id, command)
      next.set(command.commandId, submission)
    }
    for (const [id, submission] of this.recovered) {
      if (!next.has(id)) submission.accept()
    }
    this.recovered = next
    return [...next.values()]
  }
}
