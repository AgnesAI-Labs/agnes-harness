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

/**
 * A session's own environment (see `SessionEnvironment` in protocol), part of the session's records in the profile:
 * the daemon writes it when the bundled application's client opens the session with one, and the Host reads it for
 * every command the session runs, so it holds across a reload, a worker restart and a daemon restart, whoever opens
 * the session next. Removed with the session's other records when the session is deleted.
 */
export class SessionEnvironmentStore {
  readonly root: string
  readonly #anchor: string
  constructor(profileDir: string) {
    this.root = join(profileDir, '.session-environment')
    this.#anchor = dirname(profileDir)
  }
  private file(key: string): string {
    return join(this.root, `${createHash('sha256').update(key).digest('hex')}.json`)
  }
  /**
   * The session's environment, or undefined when it has none. A record that exists but cannot be read, names another
   * session or is not a valid environment throws: commands do not run without the environment their session was given.
   */
  read(key: string): SessionEnvironment | undefined {
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
    const bytes = JSON.stringify({
      version: 1,
      sessionKey: key,
      environment: parseSessionEnvironment(environment),
    })
    try {
      if (readFileSync(this.file(key), 'utf8') === bytes) return
    } catch {
      /* No record yet, or one to replace. */
    }
    mkdirDurablySync(this.root, this.#anchor)
    publishFileDurablySync(this.file(key), bytes, { replace: true })
  }
  release(key: string): void {
    removeFileDurablySync(this.file(key))
  }
}
