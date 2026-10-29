import { resolve } from 'node:path'
import type { SkillDirectoryScan, SkillScanIssue } from '@agnes/protocol'
import type { SkillRoot, SkillRootDir } from './discover.js'
import { skillSha256 } from './frontmatter.js'

const SAFE_OS_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'])

/** Error messages, paths and arbitrary OS codes never enter a management diagnostic. */
export function skillScanError(
  error: unknown,
  stage: SkillScanIssue['stage'],
  fallback: SkillScanIssue['code'],
  directory = false,
): SkillScanIssue {
  const raw = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const osCode = (typeof raw === 'string' && SAFE_OS_CODES.has(raw) ? raw : 'OTHER') as NonNullable<
    SkillScanIssue['osCode']
  >
  const code =
    osCode === 'EACCES' || osCode === 'EPERM'
      ? 'permission-denied'
      : osCode === 'ENOTDIR'
        ? 'not-directory'
        : directory && osCode === 'ENOENT'
          ? 'directory-missing'
          : fallback
  return Object.freeze({ code, stage, osCode })
}

/** Mutable only during one existing traversal; the emitted DTO is detached and frozen. */
export class SkillDirectoryProgress {
  private observed = false
  private complete = false
  private foundCount = 0
  private skippedCount = 0
  private unreadable = false
  private truncated = false
  private readonly issues: SkillScanIssue[] = []

  constructor(
    private readonly directoryId: string,
    private readonly takeIssue: () => boolean,
  ) {}

  begin(): void {
    this.observed = true
    this.complete = true
  }

  found(): void {
    this.foundCount += 1
  }

  private issue(issue: SkillScanIssue, complete: boolean): void {
    this.complete &&= complete
    if (issue.stage === 'budget') this.truncated = true
    if (this.takeIssue()) this.issues.push(Object.freeze({ ...issue }))
    else this.truncated = true
  }

  reject(issue: SkillScanIssue, complete = true): void {
    this.skippedCount += 1
    this.issue(issue, complete)
  }

  unidentified(issue: SkillScanIssue): void {
    this.issue(issue, false)
  }

  unavailable(issue: SkillScanIssue): void {
    this.observed = true
    this.unreadable = true
    this.issue(issue, false)
  }

  result(): SkillDirectoryScan {
    const state =
      !this.observed || this.unreadable
        ? 'unavailable'
        : !this.complete || this.skippedCount > 0
          ? 'partial'
          : this.foundCount > 0
            ? 'ready'
            : 'empty'
    const result: SkillDirectoryScan = {
      directoryId: this.directoryId,
      rootKey: 'user-agnes',
      state,
      complete: this.complete,
      foundCount: this.foundCount,
      skippedCount: this.skippedCount,
      unreadable: this.unreadable,
      truncated: this.truncated,
      issues: [...this.issues],
    }
    Object.freeze(result.issues)
    return Object.freeze(result)
  }
}

export class SkillScanDiagnostics {
  private readonly directories = new Map<SkillRootDir, SkillDirectoryProgress>()

  constructor(root: SkillRoot, targeted: boolean) {
    if (targeted || root.rootKey !== 'user-agnes') return
    let issueCount = 0
    for (const dir of root.dirs ?? []) {
      if (!dir.prefix.startsWith('custom/')) continue
      this.directories.set(
        dir,
        new SkillDirectoryProgress(skillSha256(resolve(dir.path)), () => {
          if (issueCount >= 128) return false
          issueCount += 1
          return true
        }),
      )
    }
  }

  directory(dir: SkillRootDir): SkillDirectoryProgress | undefined {
    return this.directories.get(dir)
  }

  fields(): { directoryScans?: readonly SkillDirectoryScan[] } {
    return this.directories.size
      ? { directoryScans: Object.freeze([...this.directories.values()].map((dir) => dir.result())) }
      : {}
  }
}
