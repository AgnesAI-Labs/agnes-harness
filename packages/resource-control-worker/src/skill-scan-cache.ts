import type { scanSkills } from './skill-bootstrap.js'

type Scan = Awaited<ReturnType<typeof scanSkills>>
/** Process-private source bodies. Reuse requires an explicit control-only notification and the
 * exact durable revision observed by a scan; discovery and unknown invalidations always read disk. */
export class SkillScanCache {
  private readonly entries = new Map<string, { revision: string; scan: Scan; bytes: number }>()
  private bytes = 0
  private size(scan: Scan): number {
    let bytes = 0
    for (const root of scan.roots)
      for (const item of root.candidates) {
        bytes += Buffer.byteLength(item.body)
        for (const file of item.files ?? []) bytes += file.bytes.byteLength
      }
    return bytes
  }
  private store(key: string, revision: string, scan: Scan, bytes = this.size(scan)): void {
    const previous = this.entries.get(key)
    this.bytes -= previous?.bytes ?? 0
    this.entries.delete(key)
    if (bytes > 32 * 1024 * 1024) return
    this.entries.set(key, { revision, scan, bytes })
    this.bytes += bytes
    while (this.entries.size > 4 || this.bytes > 32 * 1024 * 1024) {
      const oldest = this.entries.entries().next().value
      if (!oldest) break
      this.bytes -= oldest[1].bytes
      this.entries.delete(oldest[0])
    }
  }
  get(workspace: string | undefined, revision: string): Scan | undefined {
    const entry = this.entries.get(workspace ?? '')
    return entry?.revision === revision ? entry.scan : undefined
  }
  observe(workspace: string | undefined, revision: string, scan: Scan, selected?: readonly string[]): void {
    if (!selected) {
      this.store(workspace ?? '', revision, scan)
      return
    }
    if (scan.failedRoots.length || scan.skippedResourceIds.length) return
    const ids = new Set(selected)
    // Each complete workspace view includes the shared user/package roots. Only the matching
    // workspace receives workspace candidates; other views keep their immutable source bodies.
    for (const [key, previous] of [...this.entries]) {
      let bytes = previous.bytes
      const roots = previous.scan.roots.map((root) => {
        if (root.rootKey === 'workspace-agnes' && key !== (workspace ?? '')) return root
        const incoming = scan.roots.find((item) => item.rootKey === root.rootKey)
        if (!incoming) return root
        const removed = root.candidates.filter((item) => ids.has(item.resourceId))
        bytes +=
          this.size({ ...scan, roots: [incoming] }) -
          this.size({ ...scan, roots: [{ ...root, candidates: removed }] })
        return {
          ...root,
          candidates: [
            ...root.candidates.filter((item) => !ids.has(item.resourceId)),
            ...incoming.candidates,
          ],
        }
      })
      this.store(key, revision, { ...previous.scan, roots }, bytes)
    }
  }
}
