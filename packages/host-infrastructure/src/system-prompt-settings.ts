import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SystemPromptConfig } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { SystemPromptConfig as Schema } from '@agnes/protocol/gen/agnes-v1'

export const promptConfigHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
/**
 * The version a client read, for a conditional save. It names the stored value, so two windows that
 * read the same settings hold the same revision and the first save changes it for the other.
 */
export const promptConfigRevision = (config: SystemPromptConfig): string => promptConfigHash(config)

/** One writer per settings file at a time, across every store instance in this process. */
const saving = new Map<string, Promise<unknown>>()
function exclusive<T>(file: string, run: () => Promise<T>): Promise<T> {
  const next = (saving.get(file) ?? Promise.resolve()).catch(() => undefined).then(run)
  saving.set(file, next)
  void next
    .finally(() => {
      if (saving.get(file) === next) saving.delete(file)
    })
    .catch(() => undefined)
  return next
}

/** Deployment-local defaults. Sessions persist their detached copy rather than rereading this file. */
export class SystemPromptSettingsStore {
  private readonly dir: string
  private readonly file: string
  constructor(dataDir: string, profile: string) {
    this.dir = join(dataDir, 'system-prompts')
    this.file = join(this.dir, `${promptConfigHash(profile)}.json`)
  }
  async read(): Promise<SystemPromptConfig> {
    try {
      if ((await stat(this.file)).size > 1024 * 1024) throw new Error('CONFIG_INVALID_STATE')
      const text = await readFile(this.file, 'utf8')
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('CONFIG_INVALID_STATE')
      const value: unknown = JSON.parse(text)
      if (!validateAgainst(Schema, value).ok) throw new Error('CONFIG_INVALID_STATE')
      return value as SystemPromptConfig
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw Object.assign(new Error('CONFIG_INVALID_STATE'), { code: 'CONFIG_INVALID_STATE' })
    }
  }
  /**
   * Saves the whole configuration. With `expectedRevision`, the save happens only while the stored
   * value still has that revision; otherwise it is refused with `CONFIG_REVISION_CONFLICT` and the
   * current value, and nothing is written.
   */
  async save(
    config: SystemPromptConfig,
    confirmed = false,
    expectedRevision?: string,
  ): Promise<SystemPromptConfig> {
    if (
      !validateAgainst(Schema, config).ok ||
      (config.fullOverride !== undefined &&
        (!confirmed || !!(config.personaPrefix || config.personaSuffix || config.replyStyle)))
    )
      throw Object.assign(new Error('CONFIG_INVALID_INPUT'), { code: 'CONFIG_INVALID_INPUT' })
    const text = JSON.stringify(config)
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw Object.assign(new Error('CONFIG_INVALID_INPUT'), { code: 'CONFIG_INVALID_INPUT' })
    return exclusive(this.file, async () => {
      if (expectedRevision !== undefined) {
        const current = await this.read()
        if (promptConfigRevision(current) !== expectedRevision)
          throw Object.assign(new Error('CONFIG_REVISION_CONFLICT'), {
            code: 'CONFIG_REVISION_CONFLICT',
            current,
          })
      }
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.file)
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
      return structuredClone(config)
    })
  }
}
