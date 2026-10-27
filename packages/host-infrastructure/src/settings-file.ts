import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'

/** The largest settings file read or written. */
export const MAX_SETTINGS_BYTES = 1024 * 1024

/** One writer per settings file at a time, across every store instance in this process. */
const saving = new Map<string, Promise<unknown>>()
export function exclusive<T>(file: string, run: () => Promise<T>): Promise<T> {
  const next = (saving.get(file) ?? Promise.resolve()).catch(() => undefined).then(run)
  saving.set(file, next)
  void next
    .finally(() => {
      if (saving.get(file) === next) saving.delete(file)
    })
    .catch(() => undefined)
  return next
}

/** The file's text; a missing file rejects with ENOENT and one over the cap with `too large`. */
export async function readSettingsText(file: string): Promise<string> {
  if ((await stat(file)).size > MAX_SETTINGS_BYTES) throw new Error('settings file too large')
  const text = await readFile(file, 'utf8')
  if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES) throw new Error('settings file too large')
  return text
}

/** Replaces the file in one step: a 0600 temporary file in a 0700 directory, renamed over it. */
export async function writeSettingsText(dir: string, file: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}
