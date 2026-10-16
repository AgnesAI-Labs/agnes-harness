import { randomUUID } from 'node:crypto'
import {
  DecisionCommands,
  defaultIds,
  type Event,
  type EventInput,
  reduceDecision,
  SessionLogImpl,
  type StorageAdapter,
} from '@agnes/core'
import type { DecisionSnapshot } from '@agnes/extension-api'
import {
  type Actor,
  type JsonValue,
  type ProfileServiceReceipt,
  profileDecisionJournalKey,
} from '@agnes/protocol'

export interface ProfileOperation {
  key: string
  control: { grantId: string; expiresAt: number } | null
  requestDigest: string
  digest: string
  actorId: string
  owner: string
  service: string
  source: string
  activationId: string
  receipt: ProfileServiceReceipt
  input: JsonValue
  prepared: JsonValue
}
export class ProfileJournal {
  private log!: SessionLogImpl
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  readonly operations = new Map<string, ProfileOperation>()
  private readonly cells = new Map<string, { value: DecisionSnapshot; seq: number }>()
  private constructor(
    readonly profileId: string,
    private readonly clock: () => number,
  ) {}
  static async open(
    profileId: string,
    storage: StorageAdapter,
    clock: () => number,
  ): Promise<ProfileJournal> {
    const journal = new ProfileJournal(profileId, clock)
    const apply = (events: Event[]) => {
      for (const event of events) {
        if (event.type === 'decision/state') {
          const id = (event.data as DecisionSnapshot).handle.id
          journal.cells.set(id, {
            value: reduceDecision(journal.cells.get(id)?.value, event),
            seq: event.seq,
          })
        } else if (event.type === 'x/host/profile-operation') {
          const row = event.data as unknown as ProfileOperation
          journal.operations.set(row.key, structuredClone(row))
        }
      }
    }
    journal.log = await SessionLogImpl.open({
      key: profileDecisionJournalKey(profileId),
      storage,
      writerRunId: randomUUID(),
      ttlMs: 30000,
      clock,
      ids: defaultIds(clock),
      replay: { page: apply },
      onAppended: apply,
    })
    // A dispatch without a terminal receipt is never automatically retried after restart.
    for (const operation of journal.operations.values())
      if (operation.receipt.state === 'running')
        await journal.write({
          ...operation,
          receipt: { operationId: operation.receipt.operationId, state: 'unknown', code: 'OUTCOME_UNKNOWN' },
        })
    return journal
  }
  locked<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(work)
    this.tail = pending.catch(() => undefined)
    return pending
  }
  decisions(actor: Actor): DecisionCommands {
    const journal = this
    return new DecisionCommands({
      key: profileDecisionJournalKey(this.profileId),
      profileId: this.profileId,
      lane: 'main',
      actor,
      ttlMs: 86400000,
      get lastSeq() {
        return journal.log.lastSeq
      },
      get closed() {
        return journal.closed
      },
      cancelled: false,
      log: this.log,
      readDecisions: () => this.cells,
      clock: this.clock,
      id: randomUUID,
      transact: (work) => this.locked(work),
      event: (value) => this.decisionEvent(value),
    })
  }
  private decisionEvent(value: DecisionSnapshot): EventInput {
    return {
      type: 'decision/state',
      register: 'decision/state',
      actor: { id: '@agnes/profile', org: 'local', role: 'system', deptPath: [], attrs: {} },
      data: value,
      lane: 'main',
      v: 1,
      origin: 'system',
      trust: 'trusted',
    }
  }
  write(
    operation: ProfileOperation,
    decisions: EventInput[] = [],
    check: () => void = () => undefined,
  ): Promise<unknown> {
    return this.log.append(
      [
        ...decisions,
        {
          type: 'x/host/profile-operation',
          ignorable: true,
          actor: { id: '@agnes/profile', org: 'local', role: 'system', deptPath: [], attrs: {} },
          data: operation as unknown as JsonValue,
          lane: 'main',
          v: 1,
          origin: 'system',
          trust: 'trusted',
        },
      ],
      { commitCheck: check },
    )
  }
  async close(): Promise<void> {
    this.closed = true
    await this.tail
    await this.log.close()
  }
}
