import {
  BatchError,
  type Dispatch,
  type Executor,
  type Input,
  type Json,
  type Receipt,
  type Spec,
  type Store,
  type Stored,
  type StoreTransaction,
} from '../src/index.js'

/** Transactional test adapter, deliberately not installed as a production authority provider. */
export class MemoryStore implements Store {
  rows = new Map<string, Stored>()
  revision = 0
  async scan(input: { prefix: string; limit: number; cursor?: string }) {
    const rows = [...this.rows]
      .filter(([key]) => key.startsWith(input.prefix) && (!input.cursor || key > input.cursor))
      .sort(([a], [b]) => (a < b ? -1 : 1))
    const selected = rows.slice(0, input.limit)
    return {
      rows: selected.map(([, row]) => structuredClone(row)),
      ...(rows.length > input.limit ? { nextCursor: selected.at(-1)![0] } : {}),
    }
  }
  async transaction<T>(fn: (tx: StoreTransaction) => T): Promise<T> {
    const next = structuredClone(this.rows)
    const result = fn({
      get: (key) => structuredClone(next.get(key)),
      put: (key, value, revision) => {
        if ((next.get(key)?.revision ?? null) !== revision) throw new Error('CAS conflict')
        if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new Error('value limit')
        next.set(key, { value: structuredClone(value), revision: String(++this.revision) })
      },
    })
    this.rows = next
    return structuredClone(result)
  }
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
export const inputs: Input[] = ['a.txt', 'b.txt'].map((name, i) => ({
  name,
  digest: String(i + 1).repeat(64),
  size: 1,
  artifact: `artifact:${i}`,
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
      session: `session:${child}`,
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
  read(key: string, binding: Pick<Receipt, 'child' | 'session' | 'frame' | 'job'>, artifact: string): string {
    const request = this.requests.get(key),
      receipt = this.receipts.get(key)
    if (
      !request ||
      !receipt ||
      artifact !== request.input.artifact ||
      Object.entries(binding).some(([k, v]) => receipt[k as keyof Receipt] !== v)
    )
      throw new Error('E_INPUT_DENIED')
    return request.input.name
  }
}
