import { execFileSync } from 'node:child_process'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveCredentialFile } from '../src/adapters/credential-files.js'
import { createCredentialStore } from '../src/adapters/credential-store.js'

describe.runIf(process.platform === 'win32')('Windows credential store', () => {
  let parent: string, root: string
  const ref = 'secret://openai/default'
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'agnes-win-credential-中文 space%-'))
    root = join(parent, 'home')
  })
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true })
  })
  it('creates private directories, writes, replaces, reopens and removes an API key', async () => {
    const store = createCredentialStore({ root })
    expect(store.enforcement).toEqual({ level: 'full', mechanism: 'windows-acl' })
    expect(await store.read(ref)).toBeNull()
    await store.putApiKey(ref, 'first-key')
    expect(await store.read(ref)).toMatchObject({ kind: 'api-key', value: 'first-key' })
    await store.putApiKey(ref, 'second-key')
    expect(await createCredentialStore({ root }).read(ref)).toMatchObject({ value: 'second-key' })
    expect(readdirSync(dirname(resolveCredentialFile(root, ref, 'api-key')))).toEqual(['default'])
    await store.remove(ref)
    expect(await store.read(ref)).toBeNull()
  })
  it('round trips OAuth and rejects a conflicting credential kind', async () => {
    const store = createCredentialStore({ root })
    await store.putOAuth(ref, {
      provider: 'agnes-subscription',
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 1780000000000,
      scope: ['models:read'],
      grantId: 'grant',
    })
    expect(await createCredentialStore({ root }).read(ref)).toMatchObject({
      kind: 'oauth',
      accessToken: 'access',
      refreshToken: 'refresh',
    })
    await expect(store.putApiKey(ref, 'other')).rejects.toMatchObject({ reason: 'kind-conflict' })
    await store.remove(ref)
    expect(await store.read(ref)).toBeNull()
  })
  it('rejects a widened file ACL without returning or overwriting the key', async () => {
    const store = createCredentialStore({ root })
    await store.putApiKey(ref, 'keep-key')
    const file = resolveCredentialFile(root, ref, 'api-key'),
      saved = readFileSync(file)
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error('SystemRoot missing')
    execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [file, '/grant', '*S-1-1-0:R'], {
      windowsHide: true,
      stdio: 'pipe',
    })
    await expect(store.read(ref)).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNSAFE', reason: 'mode' })
    await expect(store.putApiKey(ref, 'replacement')).rejects.toMatchObject({
      code: 'CREDENTIAL_STORE_UNSAFE',
    })
    expect(readFileSync(file)).toEqual(saved)
  })
  it('refuses hard links on read and removal and preserves both names', async () => {
    const store = createCredentialStore({ root })
    await store.putApiKey(ref, 'keep-key')
    const file = resolveCredentialFile(root, ref, 'api-key'),
      alias = join(parent, 'alias')
    linkSync(file, alias)
    await expect(store.read(ref)).rejects.toMatchObject({ reason: 'link-count' })
    await expect(store.remove(ref)).rejects.toMatchObject({ reason: 'link-count' })
    expect(readFileSync(file)).toEqual(readFileSync(alias))
  })
  it('rejects oversized stored data before parsing or replacing it', async () => {
    const store = createCredentialStore({ root })
    await store.putApiKey(ref, 'key')
    const file = resolveCredentialFile(root, ref, 'api-key')
    const contents = Buffer.alloc(1024 * 1024 + 1, 65)
    writeFileSync(file, contents)
    await expect(store.read(ref)).rejects.toMatchObject({ reason: 'too-large' })
    await expect(store.putApiKey(ref, 'replacement')).rejects.toMatchObject({ reason: 'too-large' })
    // Buffer.equals: a deep toEqual walks the megabyte byte by byte and alone takes seconds here.
    expect(readFileSync(file).equals(contents)).toBe(true)
  })
  it('refuses a broadly accessible existing root without changing its ACL or contents', async () => {
    mkdirSync(root)
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error('SystemRoot missing')
    const icacls = join(systemRoot, 'System32', 'icacls.exe')
    execFileSync(icacls, [root, '/grant', '*S-1-1-0:R'], { windowsHide: true, stdio: 'pipe' })
    const before = execFileSync(icacls, [root], { windowsHide: true })
    const store = createCredentialStore({ root })
    await expect(store.read(ref)).rejects.toMatchObject({ reason: 'mode' })
    await expect(store.putApiKey(ref, 'key')).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNSAFE' })
    expect(readdirSync(root)).toEqual([])
    expect(execFileSync(icacls, [root], { windowsHide: true })).toEqual(before)
  })
  it('does not adopt a directory junction as a credential root', async () => {
    const target = join(parent, 'target')
    mkdirSync(target)
    symlinkSync(target, root, 'junction')
    try {
      await expect(createCredentialStore({ root }).putApiKey(ref, 'key')).rejects.toMatchObject({
        code: 'CREDENTIAL_STORE_UNSAFE',
      })
      expect(readdirSync(target)).toEqual([])
    } finally {
      unlinkSync(root)
    }
  })
})
