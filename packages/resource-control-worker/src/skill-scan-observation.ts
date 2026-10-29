import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { SkillDirectoryScan, SkillScanObservation } from '@agnes/protocol'

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Aggregate only the configured directories observed in this same filesystem traversal. */
export function createSkillScanObservation(
  customRoots: readonly string[],
  scans: readonly SkillDirectoryScan[],
): SkillScanObservation {
  if (customRoots.length > 16) throw new Error('too many custom Skill directories')
  const normalized = [...new Set(customRoots.map((path) => resolve(path)))]
  const byId = new Map(scans.map((scan) => [scan.directoryId, scan]))
  let remainingIssues = 128
  const directories = normalized.map((path): SkillDirectoryScan => {
    const directoryId = digest(path)
    const scan = byId.get(directoryId)
    const issues = (scan?.issues ?? []).slice(0, remainingIssues).map((issue) =>
      Object.freeze({
        code: issue.code,
        stage: issue.stage,
        ...(issue.osCode ? { osCode: issue.osCode } : {}),
      }),
    )
    remainingIssues -= issues.length
    const result: SkillDirectoryScan = {
      directoryId,
      rootKey: 'user-agnes',
      state: scan?.state ?? 'unavailable',
      complete: scan?.complete ?? false,
      foundCount: scan?.foundCount ?? 0,
      skippedCount: scan?.skippedCount ?? 0,
      unreadable: scan?.unreadable ?? false,
      truncated: (scan?.truncated ?? false) || issues.length < (scan?.issues.length ?? 0),
      issues,
    }
    Object.freeze(issues)
    return Object.freeze(result)
  })
  const observation: SkillScanObservation = {
    configurationRevision: digest(JSON.stringify(normalized)),
    complete: directories.every((directory) => directory.complete),
    foundCount: directories.reduce((count, directory) => count + directory.foundCount, 0),
    skippedCount: directories.reduce((count, directory) => count + directory.skippedCount, 0),
    unreadableDirectoryCount: directories.filter((directory) => directory.unreadable).length,
    truncated: directories.some((directory) => directory.truncated),
    directories,
  }
  Object.freeze(directories)
  return Object.freeze(observation)
}
