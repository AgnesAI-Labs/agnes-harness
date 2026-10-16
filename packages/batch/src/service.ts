import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { BatchError, type Manifest, type Spec } from './contracts.js'
import type { BatchEngine } from './engine.js'
import { type SnapshotArtifacts, snapshotFolder } from './enumerate.js'
import { publishExport, publishProgress, renderExport } from './export.js'
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
      skipped: m.skipped,
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
  /** Stable runtime binding displayed and revalidated by native effect preparation. */
  reviewBinding(): { workspaceRoot: string } {
    return { workspaceRoot: this.binding.workspaceRoot }
  }
  withSignal(signal: AbortSignal): BatchService {
    return new BatchService({ ...this.binding, signal: AbortSignal.any([this.binding.signal, signal]) })
  }
  async start(input: { id: string; dir: string; spec: Spec; extensions?: readonly string[] }) {
    this.binding.signal.throwIfAborted()
    checkId(input.id)
    // Validate the spec and authority before reading files or creating artifact snapshots.
    const { validateSpec } = await import('./schema.js')
    const spec = validateSpec(input.spec)
    const root = this.binding.workspaceRoot
    if (this.binding.engine.executor.sessionBacked) {
      const out = spec.out ?? `agh-batch/${input.id}`
      const output = resolve(root, out),
        source = resolve(root, input.dir)
      const rel = relative(root, output)
      if (
        !rel ||
        isAbsolute(rel) ||
        rel.split(sep).some((p) => p === '..' || p.startsWith('.')) ||
        (spec.out &&
          (source === output || source.startsWith(`${output}${sep}`) || output.startsWith(`${source}${sep}`)))
      )
        throw new BatchError('E_BATCH_EXPORT_PATH')
      spec.out = rel
    }
    const a = this.binding.engine.executor.authority
    if (
      !a.immutableInputOnly ||
      !a.durableIdempotency ||
      !a.hardBudget ||
      !a.terminalBilling ||
      (!this.binding.engine.executor.sessionBacked && !a.bindingReceipts)
    )
      throw new BatchError('E_BATCH_AUTHORITY_UNAVAILABLE')
    const inputs = await snapshotFolder({
      id: input.id,
      root: this.binding.workspaceRoot,
      dir: input.dir,
      artifacts: this.binding.artifacts,
      signal: this.binding.signal,
      ...(input.extensions ? { extensions: input.extensions } : {}),
    })
    let accepted: Manifest
    try {
      this.binding.signal.throwIfAborted()
      accepted = await this.binding.engine.begin(input.id, spec, inputs)
    } catch (error) {
      await Promise.allSettled(inputs.map((input) => this.binding.artifacts.discard?.(input)))
      throw error
    }
    // A same-key retry may have uploaded independent pending receipts. Keep only the receipts
    // actually retained in the accepted manifest; never clear the original batch's roots.
    for (let offset = 0; offset < inputs.length; offset += 1000) {
      const stored = await this.binding.engine.repo.page(input.id, offset, 1000)
      for (const [index, item] of stored.entries()) {
        const captured = inputs[offset + index]
        if (captured && captured.receipt?.id !== item.input.receipt?.id)
          await this.binding.artifacts.discard?.(captured)
      }
    }
    if (spec.out) await this.progress(input.id)
    return batchStatus(accepted)
  }
  async status(id: string) {
    return batchStatus(await this.binding.engine.repo.status(id))
  }
  async list(cursor?: string) {
    const page = await this.binding.engine.repo.list(cursor)
    return {
      ...page,
      rows: page.rows.map((manifest) => {
        const { spec, digest: _digest, ...summary } = batchStatus(manifest)
        return { ...summary, budget: spec.budget }
      }),
    }
  }
  async results(id: string, offset = 0, limit = 3) {
    if (limit > 3) throw new BatchError('E_BATCH_PAGE')
    const items = await this.binding.engine.repo.page(id, offset, limit)
    const m = await this.status(id)
    return { items, ...(offset + items.length < m.total ? { nextOffset: offset + items.length } : {}) }
  }
  async cancel(id: string) {
    const result = await this.binding.engine.cancel(id)
    await this.progress(id)
    return batchStatus(result)
  }
  async resume(id: string) {
    this.binding.signal.throwIfAborted()
    const result = await this.binding.engine.resume(id)
    await this.progress(id)
    return batchStatus(result)
  }
  /** Called by the managed runtime's wake/driver, not by an untrusted child. */
  async tick(): Promise<void> {
    // Managed-store cursors are invalidated by writes. Complete discovery before any tick.
    const ids: string[] = []
    let cursor: string | undefined
    do {
      this.binding.signal.throwIfAborted()
      const page = await this.binding.engine.repo.list(cursor)
      for (const m of page.rows) {
        this.binding.signal.throwIfAborted()
        if (m.status === 'running' || m.status === 'unknown' || m.spec.out) ids.push(m.id)
      }
      cursor = page.nextCursor
    } while (cursor)
    for (const id of ids) {
      this.binding.signal.throwIfAborted()
      await this.binding.engine.tick(id)
      await this.progress(id)
    }
  }
  private async progress(id: string): Promise<void> {
    const manifest = await this.binding.engine.repo.status(id)
    if (!manifest.spec.out) return
    const signature = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
    const key = `publication/${id}`
    const published = await this.binding.engine.repo.store.transaction((tx) => tx.get(key)?.value)
    if (
      published &&
      typeof published === 'object' &&
      !Array.isArray(published) &&
      published.signature === signature
    )
      return
    const bundle = await renderExport(this.binding.engine.repo, id, 64 * 1024 * 1024, true)
    await publishProgress(this.binding.workspaceRoot, manifest.spec.out, id, bundle)
    await this.binding.engine.repo.store.transaction((tx) =>
      tx.put(key, { signature }, tx.get(key)?.revision ?? null),
    )
  }
  async export(id: string, out: string) {
    this.binding.signal.throwIfAborted()
    const bundle = await renderExport(this.binding.engine.repo, id)
    await publishExport(this.binding.workspaceRoot, out, bundle)
    return { digest: bundle.digest, path: resolve(this.binding.workspaceRoot, out) }
  }
}
