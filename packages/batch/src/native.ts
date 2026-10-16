import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { NodeClient, Session } from '@agnes/sdk'
import {
  BatchError,
  type Dispatch,
  type Executor,
  type InputReference,
  type Json,
  type Receipt,
  type Store,
} from './contracts.js'
import type { SnapshotArtifacts } from './enumerate.js'
import { checkId } from './repository.js'

async function readSnapshot(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new BatchError('E_BATCH_INPUT_LIMIT')
    const bytes = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, null)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    if (offset !== stat.size) throw new BatchError('E_BATCH_CHANGED')
    return bytes.subarray(0, offset)
  } finally {
    await file.close()
  }
}
/** An owned immutable original and a separate workspace containing exactly one input file. */
export function ownedSnapshots(area: string): SnapshotArtifacts {
  return {
    async put(bytes, metadata): Promise<InputReference> {
      if (createHash('sha256').update(bytes).digest('hex') !== metadata.digest)
        throw new BatchError('E_BATCH_CHANGED')
      checkId(metadata.batch)
      const item = createHash('sha256').update(metadata.name).digest('hex')
      const directory = join(area, 'inputs', metadata.batch, item)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if ((await realpath(directory)) !== directory) throw new BatchError('E_BATCH_PATH')
      const path = join(directory, basename(metadata.name))
      try {
        const file = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o400,
        )
        try {
          await file.writeFile(bytes)
          await file.sync()
        } finally {
          await file.close()
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (
          createHash('sha256')
            .update(await readSnapshot(path))
            .digest('hex') !== metadata.digest
        )
          throw new BatchError('E_BATCH_ID_CONFLICT')
      }
      return { workspace: directory, path }
    },
  }
}
type Operation = { key: string; fingerprint: string; receipt: Receipt; workspace: string }
/** Public SDK only. A committed operation fence precedes every side effect. Reopening never resends. */
export class SessionExecutor implements Executor {
  readonly sessionBacked = true as const
  readonly authority = {
    immutableInputOnly: true,
    durableIdempotency: true,
    hardBudget: true,
    terminalBilling: true,
    bindingReceipts: false,
  }
  private readonly live = new Map<
    string,
    { controller: AbortController; session?: Session; work?: Promise<void> }
  >()
  constructor(
    readonly client: NodeClient,
    readonly store: Store,
    readonly signal: AbortSignal,
  ) {}
  private key(key: string) {
    return `operation/${key}`
  }
  private async read(key: string): Promise<Operation | undefined> {
    return this.store.transaction((tx) => tx.get(this.key(key))?.value as unknown as Operation | undefined)
  }
  private async write(row: Operation): Promise<void> {
    await this.store.transaction((tx) =>
      tx.put(
        this.key(row.key),
        JSON.parse(JSON.stringify(row)) as Json,
        tx.get(this.key(row.key))?.revision ?? null,
      ),
    )
  }
  async lookup(key: string): Promise<Receipt | undefined> {
    return this.store.transaction((tx) => {
      const entry = tx.get(this.key(key))
      if (!entry) return undefined
      const row = entry.value as unknown as Operation
      if (row.receipt.state === 'running' && !this.live.has(key)) {
        row.receipt.state = 'unknown'
        tx.put(this.key(key), JSON.parse(JSON.stringify(row)) as Json, entry.revision)
      }
      return structuredClone(row.receipt)
    })
  }
  async dispatch(input: Dispatch): Promise<Receipt> {
    this.signal.throwIfAborted()
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const old = await this.read(input.key)
    if (old) {
      if (old.fingerprint !== fingerprint) throw new BatchError('E_BATCH_ID_CONFLICT')
      return (await this.lookup(input.key))!
    }
    if (!input.input.workspace || !input.input.path) throw new BatchError('E_BATCH_INPUTS')
    const workspace = resolve(input.input.workspace)
    if ((await realpath(workspace)) !== workspace || dirname(input.input.path) !== workspace)
      throw new BatchError('E_BATCH_PATH')
    const bytes = await readSnapshot(input.input.path)
    if (createHash('sha256').update(bytes).digest('hex') !== input.input.digest)
      throw new BatchError('E_BATCH_CHANGED')
    const row: Operation = {
      key: input.key,
      fingerprint,
      workspace,
      receipt: {
        key: input.key,
        inputDigest: input.input.digest,
        child: input.child ?? randomUUID(),
        job: input.operationId,
        session: input.child ?? `unopened:${input.key}`,
        lane: 'main',
        frame: input.key,
        charged: 0,
        state: 'running',
      },
    }
    // Compare-and-set is the idempotency fence, including a crash before session.new replies.
    await this.store.transaction((tx) =>
      tx.put(this.key(input.key), JSON.parse(JSON.stringify(row)) as Json, null),
    )
    const controller = new AbortController()
    const live: { controller: AbortController; session?: Session; work?: Promise<void> } = { controller }
    this.live.set(input.key, live)
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    live.work = this.run(input, row, live, started).finally(() => {
      started()
      this.live.delete(input.key)
    })
    // run catches transport failures and persists unknown; avoid unhandled shutdown/storage errors.
    void live.work.catch(() => {})
    await ready
    return structuredClone(row.receipt)
  }
  /** Wait for already accepted callbacks before closing the owned database. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.live.values()].flatMap((value) => (value.work ? [value.work] : [])))
  }
  private async run(
    input: Dispatch,
    row: Operation,
    live: { controller: AbortController; session?: Session },
    started: () => void,
  ): Promise<void> {
    const signal = AbortSignal.any([
      this.signal,
      live.controller.signal,
      AbortSignal.timeout(Math.max(1, input.deadline - Date.now())),
    ])
    try {
      signal.throwIfAborted()
      await this.client.workspace.add(row.workspace)
      const session = input.child
        ? await this.client.session.load(input.child, { cwd: row.workspace })
        : await this.client.createSession({
            cwd: row.workspace,
            sessionKey: `batch:${input.batch}:${input.ordinal}`,
          })
      live.session = session
      // Unattended work must never grant a workspace escape, tool approval, or shell authority.
      const off = session.onPermissionRequest(async () => ({ verdict: 'rejected' }))
      try {
        row.receipt.child = session.id
        row.receipt.session = session.id
        await this.write(row)
        await this.client.session.rename(
          session.id,
          `batch ${input.batch} · ${input.input.name}`.slice(0, 80),
        )
        started()
        signal.throwIfAborted()
        const result = await session.prompt(input.prompt, {
          signal,
          creditLimit: Math.min(input.ceiling, Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000)),
        })
        if (result.reason === 'parked' || result.reason === 'interrupted')
          throw new BatchError('E_BATCH_BILLING_UNKNOWN')
        const timeline = await session.projectUI()
        // The session's cumulative meter also survives repairs; subtract previous attempt charges.
        const prior = await this.store.scan({
          prefix: `operation/${input.batch}/${input.ordinal}/`,
          limit: 3,
        })
        const charged = prior.rows.reduce(
          (sum, entry) =>
            sum +
            (entry.key === this.key(input.key) ? 0 : (entry.value as unknown as Operation).receipt.charged),
          0,
        )
        const credits = timeline.usage?.credits
        // A budget refusal before the first model call has no cost rows. The committed terminal
        // turn and its complete call projection prove zero; absent billing alone never does.
        const zeroCallRefusal =
          timeline.turns?.some(
            (turn) =>
              turn.endSeq === result.lastSeq && turn.reason === 'budget' && turn.usage.calls.length === 0,
          ) && timeline.turns.every((turn) => turn.usage.calls.length === 0)
        const total = credits?.complete ? credits.amount : zeroCallRefusal ? 0 : undefined
        if (typeof total !== 'number' || !Number.isFinite(total) || total < charged)
          throw new BatchError('E_BATCH_BILLING_UNKNOWN')
        if (total - charged > input.ceiling) throw new BatchError('E_BATCH_BILLING_UNKNOWN')
        row.receipt.charged = total - charged
        if (result.reason === 'completed') {
          const view = await this.client.session.view(session.id, { maxNodes: 200 })
          const answer = view.timeline.nodes.filter((node) => node.kind === 'assistant').at(-1)
          row.receipt.text = answer?.kind === 'assistant' ? answer.text : ''
          row.receipt.state = 'completed'
        } else row.receipt.state = result.reason === 'aborted' ? 'cancelled' : 'failed'
      } finally {
        off()
      }
    } catch {
      // A transport error, abort, or lost billing answer cannot prove quiescence or zero cost.
      row.receipt.state = 'unknown'
    }
    await this.write(row)
  }
  async cancel(key: string): Promise<Receipt | undefined> {
    const row = await this.read(key)
    if (!row) return undefined
    const live = this.live.get(key)
    live?.controller.abort()
    if (live?.session) await live.session.cancel().catch(() => {})
    if (live?.work) await live.work.catch(() => {})
    return this.lookup(key)
  }
}
