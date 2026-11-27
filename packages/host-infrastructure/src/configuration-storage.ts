import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SkinStoredSnapshot, validateAgainst } from '@agnes/protocol'
import { renameWriteThrough, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { createWin32Platform } from './adapters/platform.js'
import { ConfigurationError } from './configuration-error.js'

export const CONFIGURATION_FILE = 'configuration.json'
export const MAX_CONFIG_BYTES = 1024 * 1024
export const windowsDirectories = createWin32Platform().matches()

export async function ensureDirectory(path: string): Promise<void> {
  try {
    if (windowsDirectories) {
      windowsEnsurePrivateDirectorySync(path)
      return
    }
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('directory')
  } catch {
    throw new ConfigurationError('CONFIG_PERSIST_FAILED')
  }
}

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const parent = dirname(path)
  await ensureDirectory(parent)
  const temporary = join(
    parent,
    `.${CONFIGURATION_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.chmod(0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await renameWriteThrough(temporary, path, { noFollow: true })
  } catch {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw new ConfigurationError('CONFIG_PERSIST_FAILED')
  }
}

export async function readJsonFile(path: string): Promise<unknown | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ConfigurationError('CONFIG_INVALID_STATE', path)
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES)
    throw new ConfigurationError('CONFIG_INVALID_STATE', path)
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new ConfigurationError('CONFIG_INVALID_STATE', path)
  }
}

export function createSkinConfiguration(
  profileDir: string,
  serialized: <T>(action: () => Promise<T>) => Promise<T>,
) {
  const path = join(profileDir, 'skin-selection.json')
  const skin = async (): Promise<SkinStoredSnapshot> => {
    const stored = await readJsonFile(path)
    if (stored === undefined) return { revision: 0, choice: { kind: 'application' } }
    const checked = validateAgainst<SkinStoredSnapshot>(SkinStoredSnapshot, stored)
    if (!checked.ok || checked.value.revision === 0)
      throw new ConfigurationError('CONFIG_INVALID_STATE', path)
    return checked.value
  }
  return {
    skin,
    saveSkin: (input: SkinStoredSnapshot, isCurrent?: () => boolean | Promise<boolean>) =>
      serialized(async () => {
        const checked = validateAgainst<SkinStoredSnapshot>(SkinStoredSnapshot, input)
        if (!checked.ok || input.revision >= Number.MAX_SAFE_INTEGER)
          throw new ConfigurationError('CONFIG_INVALID_INPUT')
        const current = await skin()
        if (input.revision !== current.revision) throw new ConfigurationError('CONFIG_REVISION_CONFLICT')
        const next = { revision: current.revision + 1, choice: checked.value.choice }
        if (isCurrent && !(await isCurrent())) throw new ConfigurationError('CONFIG_REVISION_CONFLICT')
        await atomicWrite(path, JSON.stringify(next))
        return next
      }),
  }
}
