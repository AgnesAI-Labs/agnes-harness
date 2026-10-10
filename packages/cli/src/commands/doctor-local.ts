import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSea } from 'node:sea'
import { DatabaseSync } from 'node:sqlite'
import {
  type CredentialInspectionFinding,
  dataDir,
  cacheDir as defaultCacheDir,
  hasLegacySessionsDb,
  inspectCredentialStore,
  legacySessionsDbPath,
} from '@agnes/host'
import type { BootDeps } from '../types.js'

export type Section = { name: string; status: 'ok' | 'warn' | 'fail'; detail: string[] }
const failure = (name: string): Section => ({ name, status: 'fail', detail: [`${name} local probe failed`] })

/** Uses a private disposable database, never an existing session or diagnostic database. */
export async function doctorStorage(d: BootDeps): Promise<Section> {
  let dir: string | undefined
  let db: DatabaseSync | undefined
  let result = failure('storage')
  try {
    const data = dataDir(d.home)
    mkdirSync(data, { recursive: true })
    dir = mkdtempSync(join(data, 'doctor-'))
    db = new DatabaseSync(join(dir, 'probe.db'))
    const mode = db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode
    if (mode !== 'wal') throw new Error()
    db.exec('CREATE TABLE probe (value TEXT NOT NULL); BEGIN IMMEDIATE')
    db.prepare('INSERT INTO probe VALUES (?)').run('agnes-storage-probe')
    db.exec('COMMIT')
    if (db.prepare('SELECT value FROM probe').get()?.value !== 'agnes-storage-probe') throw new Error()
    const version = db.prepare('SELECT sqlite_version() AS version').get()?.version
    result = {
      name: 'storage',
      status: 'ok',
      detail: [`node:sqlite ${version}`, 'journal_mode wal', 'transaction write/read verified'],
    }
  } catch {
    result = failure('storage')
  } finally {
    try {
      try {
        db?.close()
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      result = failure('storage')
    }
  }
  // Independent of the probe above: a file left at this exact path is the pre-fix default's
  // signature, not this run's business. Reported, never touched -- moving or reading someone
  // else's database is not this command's call to make, only naming it is.
  if (hasLegacySessionsDb(d.home))
    result.detail.push(
      `legacy session database at ${legacySessionsDbPath(d.home)}: not opened, not moved, not ` +
        `deleted. Current sessions live under ${dataDir(d.home)}; nothing here decides what happens ` +
        'to the old file.',
    )
  return result
}

const TARGET_LABEL: Record<CredentialInspectionFinding['target'], string> = {
  home: 'AGH_HOME',
  secrets: 'secrets directory',
  auth: 'auth directory',
  locks: 'locks directory',
  provider: 'provider directory',
  file: 'credential file',
}

function credentialFindingLine(finding: CredentialInspectionFinding, windows: boolean): string {
  const subject = `${TARGET_LABEL[finding.target]} ${finding.path}`
  const octal = finding.target === 'file' ? '600' : '700'
  switch (finding.reason) {
    case 'mode': {
      const hint = windows
        ? ''
        : finding.narrowable
          ? `; the next credential save narrows it, or run: chmod ${octal} '${finding.path}'`
          : `; run: chmod ${octal} '${finding.path}'`
      return `${subject}: mode ${finding.actualMode ?? 'unknown'}, must be ${finding.expectedMode ?? octal}${hint}`
    }
    case 'owner':
      return `${subject}: owned by a different user; it must belong to the user running Agnes`
    case 'symlink':
      return `${subject}: is a symbolic link; the credential store refuses links`
    case 'not-directory':
      return `${subject}: is not a directory`
    case 'not-file':
      return `${subject}: is not a regular file`
    case 'link-count':
      return `${subject}: has more than one hard link`
    case 'too-large':
      return `${subject}: is larger than the credential size limit`
    case 'io':
      return `${subject}: could not be read`
    default:
      return `${subject}: ${finding.reason}`
  }
}

/** Read-only: the same rules the credential store applies, with nothing created, changed or read. */
export async function doctorCredentials(d: BootDeps): Promise<Section> {
  try {
    const result = await inspectCredentialStore(d.home)
    if (result.enforcement === 'unavailable')
      return {
        name: 'credentials',
        status: 'warn',
        detail: [`credential permission checks are unavailable: ${result.unavailableReason ?? 'unknown'}`],
      }
    if (result.homeMissing)
      return {
        name: 'credentials',
        status: 'ok',
        detail: ['no credential store yet: AGH_HOME does not exist'],
      }
    if (result.findings.length === 0)
      return {
        name: 'credentials',
        status: 'ok',
        detail: [`${result.checked} credential store entries checked: owner and permissions as required`],
      }
    const repairable = result.findings.every((finding) => finding.narrowable)
    return {
      name: 'credentials',
      status: repairable ? 'warn' : 'fail',
      detail: result.findings.map((finding) => credentialFindingLine(finding, result.windows)),
    }
  } catch {
    return failure('credentials')
  }
}

/** The command supplies resolved cacheDir; direct callers default to the home cache. */
export async function doctorBinary(d: BootDeps, cacheDir = defaultCacheDir(d.home)): Promise<Section> {
  let dir: string | undefined
  let result = failure('binary')
  try {
    const cache = join(cacheDir, 'jiti', d.agnesVersion)
    mkdirSync(cache, { recursive: true })
    dir = mkdtempSync(join(cache, 'doctor-'))
    const file = join(dir, 'probe')
    writeFileSync(file, 'agnes-cache-probe', { flag: 'wx' })
    if (readFileSync(file, 'utf8') !== 'agnes-cache-probe') throw new Error()
    result = {
      name: 'binary',
      status: 'ok',
      detail: [`sea: ${isSea() ? 'yes' : 'no'}`, 'jiti cache write/read verified'],
    }
  } catch {
    result = failure('binary')
  } finally {
    try {
      if (dir) rmSync(dir, { recursive: true, force: true })
    } catch {
      result = failure('binary')
    }
  }
  return result
}
