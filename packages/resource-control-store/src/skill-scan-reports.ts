import { type SkillScanObservation, type SkillScanReport, validateResourceControlData } from '@agnes/protocol'

export type SkillScanToken = Readonly<{ key: string; operationId: string; generation: number }>

/** Validate the path-free transport envelope and the aggregate invariants schemas cannot express. */
export function checkedSkillScanObservation(value: unknown): SkillScanObservation {
  if (!validateResourceControlData('SkillScanObservation', value).ok)
    throw new Error('invalid Skill scan observation')
  const scan = value as SkillScanObservation
  const dirs = scan.directories
  const integers = [
    scan.foundCount,
    scan.skippedCount,
    ...dirs.flatMap((dir) => [dir.foundCount, dir.skippedCount]),
  ]
  if (
    integers.some((n) => !Number.isSafeInteger(n)) ||
    new Set(dirs.map((dir) => dir.directoryId)).size !== dirs.length ||
    scan.foundCount !== dirs.reduce((sum, dir) => sum + dir.foundCount, 0) ||
    scan.skippedCount !== dirs.reduce((sum, dir) => sum + dir.skippedCount, 0) ||
    scan.unreadableDirectoryCount !== dirs.filter((dir) => dir.unreadable).length ||
    scan.complete !== dirs.every((dir) => dir.complete) ||
    dirs.some((dir) => dir.complete && dir.unreadable) ||
    dirs.reduce((sum, dir) => sum + dir.issues.length, 0) > 128 ||
    (dirs.some((dir) => dir.truncated) && !scan.truncated)
  )
    throw new Error('inconsistent Skill scan observation')
  return structuredClone(scan)
}

/** Recent diagnostics, never an authority for catalog contents and never serialized to a journal.
 *  Each scope reports the most recently admitted scan that has finished. */
export class SkillScanReports {
  private generation = 0
  private readonly latest = new Map<string, SkillScanToken>()
  private readonly published = new Map<string, SkillScanReport>()
  constructor(private readonly limit = 128) {}

  begin(profile: string, workspaceId: string | undefined, operationId: string): SkillScanToken {
    const key = JSON.stringify([profile, workspaceId ?? null])
    const token = { key, operationId, generation: ++this.generation }
    this.latest.delete(key)
    this.latest.set(key, token)
    while (this.latest.size > this.limit) {
      const oldest = this.latest.keys().next().value
      if (oldest === undefined) break
      this.latest.delete(oldest)
      this.published.delete(oldest)
    }
    return token
  }

  publish(token: SkillScanToken, observation: SkillScanObservation): void {
    // A scope that was evicted, or a scan older than the one already reported, publishes nothing.
    // A later scan still running does not void this one: a person's rescan overlapped by a watcher
    // refresh of the same folders must still report what it read.
    const latest = this.latest.get(token.key)
    if (!latest || latest.generation < token.generation) return
    const current = this.published.get(token.key)
    if (current && current.generation >= token.generation) return
    this.published.set(token.key, {
      ...checkedSkillScanObservation(observation),
      operationId: token.operationId,
      generation: token.generation,
      observedAt: new Date().toISOString(),
    })
  }

  read(profile: string, workspaceId?: string): SkillScanReport | undefined {
    const report = this.published.get(JSON.stringify([profile, workspaceId ?? null]))
    return report ? structuredClone(report) : undefined
  }
}
