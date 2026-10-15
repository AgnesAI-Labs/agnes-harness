import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { credentialFileEnforcement } from './credential-files.js'
import { createPlatform } from './platform.js'

export type CredentialMetadata = {
  target: string
  part: 'home' | 'secrets' | 'auth' | 'locks'
  check: 'ok' | 'missing' | 'unsafe' | 'io' | 'limit'
  mode?: string
  expectedMode?: string
  repair?: 'chmod'
}
/** Local diagnostic only: no file is opened, no permissions are changed, and links are not followed. */
export async function inspectCredentialMetadata(home: string): Promise<CredentialMetadata[]> {
  const enforcement = credentialFileEnforcement(createPlatform())
  const rows: CredentialMetadata[] = []
  let remaining = 4096
  const visit = async (target: string, part: CredentialMetadata['part'], descend: boolean): Promise<void> => {
    if (--remaining < 0) {
      if (remaining === -1) rows.push({ target: home, part, check: 'limit' })
      return
    }
    try {
      const stat = await lstat(target)
      const mode = (stat.mode & 0o7777).toString(8).padStart(4, '0')
      const safe =
        !stat.isSymbolicLink() &&
        (stat.isDirectory() || (stat.isFile() && stat.nlink === 1)) &&
        enforcement.level === 'full' &&
        (enforcement.mechanism === 'windows-acl'
          ? hasPrivateDaclSync(target)
          : stat.uid === enforcement.ownerUid &&
            (stat.mode & 0o7777) === (stat.isDirectory() ? 0o700 : 0o600))
      rows.push({
        target,
        part,
        check: safe ? 'ok' : 'unsafe',
        mode,
        ...(enforcement.mechanism === 'posix-mode-owner' && (stat.isDirectory() || stat.isFile())
          ? { expectedMode: stat.isDirectory() ? '0700' : '0600' }
          : {}),
        ...(!safe &&
        enforcement.level === 'full' &&
        enforcement.mechanism === 'posix-mode-owner' &&
        stat.uid === enforcement.ownerUid &&
        !stat.isSymbolicLink() &&
        (stat.isDirectory() || (stat.isFile() && stat.nlink === 1))
          ? { repair: 'chmod' as const }
          : {}),
      })
      if (safe && descend && stat.isDirectory()) {
        for (const name of await readdir(target)) {
          if (remaining <= 0) {
            await visit(target, part, false)
            break
          }
          await visit(join(target, name), part, true)
        }
      }
    } catch (error) {
      rows.push({
        target,
        part,
        check: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'io',
      })
    }
  }
  await visit(home, 'home', false)
  if (rows[0]?.check === 'ok')
    for (const part of ['secrets', 'auth', 'locks'] as const) await visit(join(home, part), part, true)
  return rows
}
