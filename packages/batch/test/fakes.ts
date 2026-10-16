import { DatabaseSync } from 'node:sqlite'
import { createOwnedStore } from '@agnes/sdk/owned-store'
import { afterEach } from 'vitest'
import {
  BatchError,
  type Dispatch,
  type Executor,
  type Input,
  type InputReference,
  type Receipt,
  type Spec,
  type Store,
} from '../src/index.js'

const databases = new Set<DatabaseSync>()
afterEach(() => {
  for (const database of databases) database.close()
  databases.clear()
})
/** Actual SDK store in an isolated SQLite namespace; no production state or processes. */
export function testStore(): Store {
  const database = new DatabaseSync(':memory:')
  databases.add(database)
  return createOwnedStore(database, 'profile:unit/batch')
}
export const spec: Spec = {
  prompt: 'Count {{name}}',
  budget: 10,
  itemBudget: 1,
  itemTimeoutMs: 1000,
  concurrency: 2,
  maxRepairs: 1,
  failureLimit: 5,
}
export const reference = (digest: string, size: number, tag = digest): InputReference => ({
  artifact: { sha256: digest, size, mime: 'text/plain' },
  receipt: { id: `receipt:${tag}`, scope: { sessionKey: `session:${tag}`, lane: 'main' } },
})
export const inputs: Input[] = ['a.txt', 'b.txt'].map((name, i) => ({
  name,
  digest: String(i + 1).repeat(64),
  size: 1,
  ...reference(String(i + 1).repeat(64), 1, name),
}))
export const id = 'b123456abcdef'
export class FakeExecutor implements Executor {
  readonly authority = {
    immutableInputOnly: true,
    durableIdempotency: true,
    hardBudget: true,
    terminalBilling: true,
    bindingReceipts: true,
  }
  requests = new Map<string, Dispatch>()
  receipts = new Map<string, Receipt>()
  fenced = new Set<string>()
  executions = 0
  loseReply = false
  reply: (request: Dispatch) => Partial<Receipt> = () => ({
    state: 'completed',
    charged: 0.25,
    text: 'ok',
    inputRead: true,
  })
  async lookup(key: string) {
    return structuredClone(this.receipts.get(key))
  }
  async dispatch(request: Dispatch): Promise<Receipt> {
    const old = this.requests.get(request.key)
    if (old && JSON.stringify(old) !== JSON.stringify(request)) throw new BatchError('ID_CONFLICT')
    if (this.receipts.has(request.key)) return structuredClone(this.receipts.get(request.key)!)
    const child = request.child ?? `child:${request.batch}:${request.ordinal}`
    const receipt: Receipt = {
      key: request.key,
      inputDigest: request.input.digest,
      child,
      job: `job:${request.key}`,
      session: request.input.receipt!.scope.sessionKey,
      lane: request.input.receipt!.scope.lane,
      frame: `frame:${request.key}`,
      charged: 0,
      state: 'running',
      ...(!this.fenced.has(request.key) ? this.reply(request) : { state: 'cancelled' }),
    }
    this.requests.set(request.key, structuredClone(request))
    this.receipts.set(request.key, receipt)
    if (!this.fenced.has(request.key)) this.executions++
    if (this.loseReply) {
      this.loseReply = false
      throw new Error('lost response')
    }
    return structuredClone(receipt)
  }
  async cancel(key: string) {
    this.fenced.add(key)
    const receipt = this.receipts.get(key)
    if (receipt && receipt.state !== 'completed' && receipt.state !== 'failed') receipt.state = 'cancelled'
    return structuredClone(receipt)
  }
  /** Synthetic authority boundary: only exact bound input, child/session/frame/job accepted. */
  read(
    key: string,
    binding: Pick<Receipt, 'child' | 'session' | 'lane' | 'frame' | 'job'>,
    artifact: Input['artifact'],
  ): string {
    const request = this.requests.get(key),
      receipt = this.receipts.get(key)
    if (
      !request ||
      !receipt ||
      artifact!.sha256 !== request.input.artifact!.sha256 ||
      Object.entries(binding).some(([k, v]) => receipt[k as keyof Receipt] !== v)
    )
      throw new Error('E_INPUT_DENIED')
    return request.input.name
  }
}
