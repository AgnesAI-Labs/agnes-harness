import type { RuntimeTargetIdentity } from '@agnes/plugin-runtime/host'

export type RuntimeBootExpectation = Readonly<{
  workerKind: 'session'
  workerKey: '@shared'
  generation: number
  digest: string
  identity: RuntimeTargetIdentity
  source: 'lastGood' | 'bootstrap'
}>

function sameIdentity(left: RuntimeTargetIdentity, right: RuntimeTargetIdentity): boolean {
  return (
    left.treeHash === right.treeHash &&
    left.resourceRevision === right.resourceRevision &&
    left.compositeRevision === right.compositeRevision
  )
}

function matches(actual: RuntimeBootExpectation, expected: RuntimeBootExpectation): boolean {
  return (
    actual.workerKind === expected.workerKind &&
    actual.workerKey === expected.workerKey &&
    actual.generation === expected.generation &&
    actual.digest === expected.digest &&
    actual.source === expected.source &&
    sameIdentity(actual.identity, expected.identity)
  )
}

/**
 * One shared-worker startup attempt. Session.open stays closed until a boot_ready frame matches the
 * frozen six-tuple. A correct duplicate is idempotent; any mismatched field is refused.
 */
export class RuntimeAdmission {
  #ready = false
  #failure: Error | undefined
  readonly #waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  constructor(readonly expected: RuntimeBootExpectation) {
    if (expected.workerKind !== 'session' || expected.workerKey !== '@shared') {
      throw new TypeError('runtime admission is only defined for session/@shared')
    }
    if (!Number.isSafeInteger(expected.generation) || expected.generation < 1) {
      throw new TypeError('runtime admission generation must be a positive safe integer')
    }
  }

  get ready(): boolean {
    return this.#ready
  }

  admit(frame: RuntimeBootExpectation): boolean {
    if (!matches(frame, this.expected)) return false
    if (this.#ready) return true
    if (this.#failure) return false
    this.#ready = true
    for (const waiter of this.#waiters.splice(0)) waiter.resolve()
    return true
  }

  /** The worker said it cannot start from this target: whoever waits for it to be ready stops waiting. */
  fail(error: Error): void {
    if (this.#ready || this.#failure) return
    this.#failure = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  whenReady(): Promise<void> {
    if (this.#ready) return Promise.resolve()
    const failure = this.#failure
    if (failure) return Promise.reject(failure)
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
    })
  }
}
