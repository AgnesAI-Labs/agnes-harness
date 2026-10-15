import { resolve } from 'node:path'
import { BatchError, type Manifest, type Spec } from './contracts.js'
import type { BatchEngine } from './engine.js'
import { type SnapshotArtifacts, snapshotFolder } from './enumerate.js'
import { publishExport, renderExport } from './export.js'
import { checkId } from './repository.js'

export function batchStatus(m: Manifest) {
  return {
    ...m,
    counts: {
      total: m.total,
      pending: m.total - m.next + 1,
      running: m.active.length - m.uncertain,
      unknown: m.uncertain,
      done: m.successes,
      invalid: m.invalid,
      failed: m.failed,
      cancelled: m.cancelled,
    },
  }
}
/** Host-admitted workspace/owner binding; never construct this from service request parameters. */
export type BatchBinding = {
  workspaceRoot: string
  engine: BatchEngine
  artifacts: SnapshotArtifacts
  signal: AbortSignal
}
/** A narrow business service ready for an owner-bound, authority-enforcing runtime adapter. */
export class BatchService {
  constructor(private readonly binding: BatchBinding) {}
  async start(input: { id: string; dir: string; spec: Spec; extensions?: readonly string[] }) {
    this.binding.signal.throwIfAborted()
    checkId(input.id)
    // Validate the spec and authority before reading files or creating artifact snapshots.
    const { validateSpec } = await import('./schema.js')
    const spec = validateSpec(input.spec)
    const a = this.binding.engine.executor.authority
    if (
      !a.immutableInputOnly ||
      !a.durableIdempotency ||
      !a.hardBudget ||
      !a.terminalBilling ||
      !a.bindingReceipts
    )
      throw new BatchError('E_BATCH_AUTHORITY_UNAVAILABLE')
    const inputs = await snapshotFolder({
      root: this.binding.workspaceRoot,
      dir: input.dir,
      artifacts: this.binding.artifacts,
      signal: this.binding.signal,
      ...(input.extensions ? { extensions: input.extensions } : {}),
    })
    this.binding.signal.throwIfAborted()
    return batchStatus(await this.binding.engine.begin(input.id, spec, inputs))
  }
  async status(id: string) {
    return batchStatus(await this.binding.engine.repo.status(id))
  }
  async list(cursor?: string) {
    const page = await this.binding.engine.repo.list(cursor)
    return { ...page, rows: page.rows.map(batchStatus) }
  }
  async results(id: string, offset = 0, limit = 3) {
    if (limit > 3) throw new BatchError('E_BATCH_PAGE')
    const items = await this.binding.engine.repo.page(id, offset, limit)
    const m = await this.status(id)
    return { items, ...(offset + items.length < m.total ? { nextOffset: offset + items.length } : {}) }
  }
  async cancel(id: string) {
    return batchStatus(await this.binding.engine.cancel(id))
  }
  async resume(id: string) {
    return batchStatus(await this.binding.engine.resume(id))
  }
  /** Called by the managed runtime's wake/driver, not by an untrusted child. */
  async tick(): Promise<void> {
    let cursor: string | undefined
    do {
      this.binding.signal.throwIfAborted()
      const page = await this.list(cursor)
      for (const m of page.rows) {
        this.binding.signal.throwIfAborted()
        if (m.status === 'running' || m.status === 'unknown') await this.binding.engine.tick(m.id)
      }
      cursor = page.nextCursor
    } while (cursor)
  }
  async export(id: string, out: string) {
    this.binding.signal.throwIfAborted()
    const bundle = await renderExport(this.binding.engine.repo, id)
    await publishExport(this.binding.workspaceRoot, out, bundle)
    return { digest: bundle.digest, path: resolve(this.binding.workspaceRoot, out) }
  }
}
