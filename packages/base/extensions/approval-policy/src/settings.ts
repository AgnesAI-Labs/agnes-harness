import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolPolicySelection, ToolPolicySettingsContext } from '@agnes/extension-api'
import { AutoReviewConfig, validateAgainst } from '@agnes/protocol'

const profileHash = (profile: string) => createHash('sha256').update(JSON.stringify(profile)).digest('hex')

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
    this.file = join(this.dir, `${profileHash(profile)}.json`)
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

/** Official provider-owned selection; unreadable operator settings escalate rather than widen risk. */
export async function selectAutoReviewSettings(
  context: ToolPolicySettingsContext,
  signal: AbortSignal,
): Promise<ToolPolicySelection> {
  signal.throwIfAborted()
  if (context.policy !== 'default' && context.policy !== 'auto-review') return {}
  let config: AutoReviewConfig
  try {
    config = await new AutoReviewSettingsStore(
      context.dataDir,
      context.profile,
      context.approvalMode === 'auto-review',
    ).read()
  } catch {
    signal.throwIfAborted()
    return { policy: 'auto-review', config: { maxReviews: 0 } }
  }
  signal.throwIfAborted()
  return { config, ...(config.enabled && context.policy === 'default' ? { policy: 'auto-review' } : {}) }
}
