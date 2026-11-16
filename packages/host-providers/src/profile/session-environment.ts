import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdirDurablySync, publishFileDurablySync, removeFileDurablySync } from '@agnes/package-manager'
import { parseSessionEnvironment, type SessionEnvironment } from '@agnes/protocol'

const fault = (file: string, why: string, cause?: unknown): Error & { code: string } =>
  Object.assign(
    new Error(`E_SESSION_ENVIRONMENT: the session environment record ${file} ${why}`, { cause }),
    {
      code: 'E_SESSION_ENVIRONMENT',
    },
  )

/** Session keys whose environment one process remembers per profile, before it forgets the oldest. */
const REMEMBERED = 4096
/**
 * What this process knows of each profile's records: a session's environment, or null for none. Every store over the
 * same directory shares it, so a write or a removal here is seen by the next read anywhere in the process. A record
 * that cannot be read is never remembered: it is read again, and refused again, on the next command.
 */
const known = new Map<string, Map<string, SessionEnvironment | null>>()

/**
 * A session's own environment (see `SessionEnvironment` in protocol), part of the session's records in the profile.
 * The shared session worker writes it when the daemon admits one from the bundled application's client, and reads it
 * for every command the session runs, so it holds across a reload, a worker restart and a daemon restart, whoever opens
 * the session next. Removed with the session's other records when the session is deleted. Reads are answered from
 * memory once a session's record, or its absence, is known; only this process writes or removes records.
 */
export class SessionEnvironmentStore {
  readonly root: string
  readonly #anchor: string
  readonly #known: Map<string, SessionEnvironment | null>
  constructor(profileDir: string) {
    this.root = join(profileDir, '.session-environment')
    this.#anchor = dirname(profileDir)
    const shared = known.get(this.root) ?? new Map<string, SessionEnvironment | null>()
    known.set(this.root, shared)
    this.#known = shared
  }
  private file(key: string): string {
    return join(this.root, `${createHash('sha256').update(key).digest('hex')}.json`)
  }
  private remember(key: string, environment: SessionEnvironment | null): void {
    this.#known.delete(key)
    this.#known.set(key, environment)
    if (this.#known.size > REMEMBERED) this.#known.delete(this.#known.keys().next().value as string)
  }
  /**
   * The session's environment, or undefined when it has none. A record that exists but cannot be read, names another
   * session or is not a valid environment throws: commands do not run without the environment their session was given.
   */
  read(key: string): SessionEnvironment | undefined {
    const remembered = this.#known.get(key)
    if (remembered !== undefined) return remembered ?? undefined
    const environment = this.load(key)
    this.remember(key, environment ?? null)
    return environment
  }
  private load(key: string): SessionEnvironment | undefined {
    const file = this.file(key)
    let bytes: string
    try {
      bytes = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw fault(file, 'cannot be read', error)
    }
    let value: { version?: unknown; sessionKey?: unknown; environment?: unknown }
    try {
      value = JSON.parse(bytes) as typeof value
    } catch (error) {
      throw fault(file, 'is not valid JSON', error)
    }
    if (value?.version !== 1 || value.sessionKey !== key) throw fault(file, 'does not describe this session')
    try {
      return parseSessionEnvironment(value.environment)
    } catch (error) {
      throw fault(file, 'holds an invalid environment', error)
    }
  }
  /** Keeps `environment` for the session, durably; the same environment again writes nothing. */
  write(key: string, environment: SessionEnvironment): void {
    const parsed = parseSessionEnvironment(environment)
    const bytes = JSON.stringify({ version: 1, sessionKey: key, environment: parsed })
    try {
      if (readFileSync(this.file(key), 'utf8') === bytes) {
        this.remember(key, parsed)
        return
      }
    } catch {
      /* No record yet, or one to replace. */
    }
    mkdirDurablySync(this.root, this.#anchor)
    publishFileDurablySync(this.file(key), bytes, { replace: true })
    this.remember(key, parsed)
  }
  release(key: string): void {
    removeFileDurablySync(this.file(key))
    this.remember(key, null)
  }
}
