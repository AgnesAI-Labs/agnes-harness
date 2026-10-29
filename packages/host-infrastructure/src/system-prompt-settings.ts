import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { SystemPromptConfig } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { SystemPromptConfig as Schema } from '@agnes/protocol/gen/agnes-v1'
import { exclusive, MAX_SETTINGS_BYTES, readSettingsText, writeSettingsText } from './settings-file.js'

export const promptConfigHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
/**
 * The version a client read, for a conditional save. It names the stored value, so two windows that
 * read the same settings hold the same revision and the first save changes it for the other.
 */
export const promptConfigRevision = (config: SystemPromptConfig): string => promptConfigHash(config)

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
      const value: unknown = JSON.parse(await readSettingsText(this.file))
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
    if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES)
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
      await writeSettingsText(this.dir, this.file, text)
      return structuredClone(config)
    })
  }
}
