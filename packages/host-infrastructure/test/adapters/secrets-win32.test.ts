import { execFileSync } from 'node:child_process'
import { closeSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateFileSync, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCredentialStore } from '../../src/adapters/credential-store.js'
import { composeSecrets, createSecretsFile } from '../../src/adapters/secrets.js'

describe.runIf(process.platform === 'win32')('Windows secret file reader', () => {
  let parent: string, home: string, dir: string, file: string
  const ref = 'secret://agnes/gateway'
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'agnes-reader-中文 space-'))
    home = join(parent, 'home')
    dir = join(home, 'secrets')
    windowsEnsurePrivateDirectorySync(join(dir, 'agnes'))
    file = join(dir, 'agnes', 'gateway')
    const fd = createPrivateFileSync(file)
    try {
      writeFileSync(fd, ' raw 中文 \r\n')
    } finally {
      closeSync(fd)
    }
  })
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true })
  })
  it('reads private plain text and unwraps a managed credential without changing either format', async () => {
    expect(createSecretsFile({ dir }).resolve(ref)).toBe(' raw 中文 ')
    const credentials = createCredentialStore({ root: home })
    await credentials.putApiKey('secret://openai/default', 'managed-key')
    expect(createSecretsFile({ dir }).resolve('secret://openai/default')).toBe('managed-key')
  })
  it('falls back only for a missing secret', () => {
    const fallback = vi.fn(() => 'env-value')
    const resolver = composeSecrets(createSecretsFile({ dir }), { kind: 'env', resolve: fallback })
    expect(resolver.resolve('secret://agnes/absent')).toBe('env-value')
    expect(fallback).toHaveBeenCalledOnce()
  })
  it.each(['file', 'namespace', 'store'])(
    'refuses broad %s permissions without environment fallback',
    (target) => {
      const path = target === 'file' ? file : target === 'namespace' ? join(dir, 'agnes') : dir
      const systemRoot = process.env.SystemRoot
      if (!systemRoot) throw new Error('SystemRoot missing')
      execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [path, '/grant', '*S-1-1-0:R'], {
        windowsHide: true,
      })
      const fallback = vi.fn(() => 'env-value')
      const resolver = composeSecrets(createSecretsFile({ dir }), { kind: 'env', resolve: fallback })
      expect(() => resolver.resolve(ref)).toThrow(
        expect.objectContaining({
          code: 'E_SECRET_UNRESOLVED',
          detail: expect.objectContaining({ reason: 'private-file' }),
        }),
      )
      expect(fallback).not.toHaveBeenCalled()
      expect(readFileSync(file, 'utf8')).toBe(' raw 中文 \r\n')
    },
  )
  it('refuses a hard-linked file and an oversized file', () => {
    const alias = join(parent, 'alias')
    linkSync(file, alias)
    const resolver = createSecretsFile({ dir })
    expect(() => resolver.resolve(ref)).toThrow(/E_SECRET_UNRESOLVED/)
    rmSync(alias)
    writeFileSync(file, Buffer.alloc(1024 * 1024 + 1))
    expect(() => resolver.resolve(ref)).toThrow(/E_SECRET_UNRESOLVED/)
  })
})
