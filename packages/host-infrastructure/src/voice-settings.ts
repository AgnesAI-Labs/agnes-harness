import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { VoiceSettings, VoiceSettingsSnapshot } from '@agnes/protocol'
import { DEFAULT_VOICE_SETTINGS, validateAgainst } from '@agnes/protocol'
import { VoiceSettings as Schema } from '@agnes/protocol/gen/agnes-v1'
import { exclusive, MAX_SETTINGS_BYTES, readSettingsText, writeSettingsText } from './settings-file.js'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The version a client read, for a conditional save: it names the stored value. */
export const voiceSettingsRevision = (settings: VoiceSettings): string => sha256(JSON.stringify(settings))

const failure = (code: 'CONFIG_INVALID_INPUT' | 'CONFIG_REVISION_CONFLICT', extra: object = {}) =>
  Object.assign(new Error(code), { code, ...extra })

/**
 * The voice settings of one profile, in `<dataDir>/voice/<sha256(profile)>.json`. A missing or
 * unreadable-as-settings file reads as the defaults, so a bad file never turns voice off for good.
 */
export class VoiceSettingsStore {
  private readonly dir: string
  private readonly file: string
  constructor(dataDir: string, profile: string) {
    this.dir = join(dataDir, 'voice')
    this.file = join(this.dir, `${sha256(profile)}.json`)
  }

  async read(): Promise<VoiceSettingsSnapshot> {
    const settings = (await this.stored()) ?? structuredClone(DEFAULT_VOICE_SETTINGS)
    return { settings, revision: voiceSettingsRevision(settings) }
  }

  /**
   * Saves the whole settings while the stored value still has `expectedRevision`; otherwise refuses
   * with `CONFIG_REVISION_CONFLICT` and the current snapshot, and writes nothing.
   */
  async save(settings: VoiceSettings, expectedRevision: string): Promise<VoiceSettingsSnapshot> {
    const text = JSON.stringify(settings)
    if (!validateAgainst(Schema, settings).ok || Buffer.byteLength(text) > MAX_SETTINGS_BYTES)
      throw failure('CONFIG_INVALID_INPUT')
    return exclusive(this.file, async () => {
      const current = await this.read()
      if (current.revision !== expectedRevision) throw failure('CONFIG_REVISION_CONFLICT', { current })
      await writeSettingsText(this.dir, this.file, text)
      return { settings: structuredClone(settings), revision: voiceSettingsRevision(settings) }
    })
  }

  private async stored(): Promise<VoiceSettings | undefined> {
    let text: string
    try {
      text = await readSettingsText(this.file)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === undefined || code === 'ENOENT') return undefined
      throw error
    }
    try {
      const value: unknown = JSON.parse(text)
      return validateAgainst(Schema, value).ok ? (value as VoiceSettings) : undefined
    } catch {
      return undefined
    }
  }
}
