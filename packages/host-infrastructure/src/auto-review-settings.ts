import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AutoReviewConfig, validateAgainst } from '@agnes/protocol'
import { promptConfigHash } from './system-prompt-settings.js'

/** Operator-owned settings; future rules change only through an explicit administrative save. */
export class AutoReviewSettingsStore {
  private readonly dir: string
  private readonly file: string
  constructor(
    dataDir: string,
    profile: string,
    private readonly defaultEnabled = false,
  ) {
    this.dir = join(dataDir, 'approval-review')
    this.file = join(this.dir, `${promptConfigHash(profile)}.json`)
  }
  async read(): Promise<AutoReviewConfig> {
    try {
      if ((await stat(this.file)).size > 256 * 1024) throw new Error('CONFIG_INVALID_STATE')
      const text = await readFile(this.file, 'utf8')
      if (Buffer.byteLength(text) > 256 * 1024) throw new Error('CONFIG_INVALID_STATE')
      const value: unknown = JSON.parse(text)
      if (!validateAgainst(AutoReviewConfig, value).ok) throw new Error('CONFIG_INVALID_STATE')
      return { enabled: this.defaultEnabled, ...(value as AutoReviewConfig) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: this.defaultEnabled }
      throw new Error('CONFIG_INVALID_STATE')
    }
  }
  async save(config: AutoReviewConfig): Promise<AutoReviewConfig> {
    if (!validateAgainst(AutoReviewConfig, config).ok) throw new Error('CONFIG_INVALID_INPUT')
    const text = JSON.stringify(config)
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('CONFIG_INVALID_INPUT')
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.file)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    return structuredClone(config)
  }
}
