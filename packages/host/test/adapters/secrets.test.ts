import { chmodSync, closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  composeSecrets,
  createSecretsEnv,
  createSecretsFile,
  parseSecretRef,
} from '../../src/adapters/secrets.js'
import { isHostError } from '../../src/errors.js'

/** The detail a refusal carried, so a rejection cannot be credited to the wrong rule. */
function refusal(fn: () => unknown): { code: string; detail: Record<string, unknown>; message: string } {
  try {
    fn()
  } catch (e) {
    if (!isHostError(e)) throw e
    return { code: e.code, detail: e.detail ?? {}, message: e.message }
  }
  throw new Error('should have refused')
}

describe('secrets', () => {
  let dir: string
  let parent: string
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'agnes-sec-'))
    dir = join(parent, 'store')
    createPrivateDirectorySync(dir)
    createPrivateDirectorySync(join(dir, 'agnes'))
    closeSync(createPrivateFileSync(join(dir, 'agnes', 'gateway')))
    writeFileSync(join(dir, 'agnes', 'gateway'), 'sk-value\n', { mode: 0o600 })
  })
  afterEach(() => rmSync(parent, { recursive: true, force: true }))

  it('parses refs and rejects bad ones', () => {
    expect(parseSecretRef('secret://agnes/gateway')).toEqual({ ns: 'agnes', name: 'gateway' })
    expect(parseSecretRef('secret://xin-wei/oa_token.v1')).toEqual({
      ns: 'xin-wei',
      name: 'oa_token.v1',
    })
    expect(() => parseSecretRef('sk-literal')).toThrow(/E_SECRET_UNRESOLVED/)
  })
  it.each([
    ['a bare literal', 'sk-literal'],
    ['the wrong scheme', 'https://agnes/gateway'],
    ['no namespace', 'secret:///gateway'],
    ['no name', 'secret://agnes/'],
    ['an uppercase namespace', 'secret://Agnes/gateway'],
    ['a path traversal in the name', 'secret://agnes/../../etc/passwd'],
    ['a nested path', 'secret://agnes/a/b'],
    ['trailing whitespace', 'secret://agnes/gateway '],
  ])('refuses %s as a bad reference, saying so', (_label, ref) => {
    const r = refusal(() => parseSecretRef(ref))
    expect(r.code).toBe('E_SECRET_UNRESOLVED')
    expect(r.detail.reason).toBe('bad-ref')
  })
  // A traversal must be refused by the pattern, before it is ever joined onto the store directory.
  it('never turns a reference into a path outside the store', () => {
    expect(() => createSecretsFile({ dir }).resolve('secret://agnes/../../../etc/passwd')).toThrow(
      /E_SECRET_UNRESOLVED/,
    )
  })
  it.runIf(typeof process.getuid === 'function')('file resolver reads and trims, requires 0600', () => {
    const r = createSecretsFile({ dir })
    expect(r.resolve('secret://agnes/gateway')).toBe('sk-value')
    chmodSync(join(dir, 'agnes', 'gateway'), 0o644)
    const refused = refusal(() => r.resolve('secret://agnes/gateway'))
    expect(refused.code).toBe('E_SECRET_UNRESOLVED')
    expect(refused.detail.reason).toBe('mode')
  })
  it('unwraps the credential-store API-key envelope before provider assembly', () => {
    writeFileSync(
      join(dir, 'agnes', 'gateway'),
      `${JSON.stringify({ version: 1, kind: 'api-key', provider: 'agnes', value: 'managed-key' })}\n`,
      { mode: 0o600 },
    )
    expect(createSecretsFile({ dir }).resolve('secret://agnes/gateway')).toBe('managed-key')
  })
  it('refuses a malformed managed credential envelope without exposing its value', () => {
    writeFileSync(
      join(dir, 'agnes', 'gateway'),
      `${JSON.stringify({ version: 1, kind: 'api-key', provider: 'other', value: 'must-not-leak' })}\n`,
      { mode: 0o600 },
    )
    try {
      createSecretsFile({ dir }).resolve('secret://agnes/gateway')
      expect.unreachable('should refuse')
    } catch (e) {
      if (!isHostError(e)) throw e
      expect(e.code).toBe('E_SECRET_UNRESOLVED')
      expect(e.detail).toMatchObject({ reason: 'schema' })
      expect(e.message).not.toContain('must-not-leak')
      expect(JSON.stringify(e.detail)).not.toContain('must-not-leak')
    }
  })
  // 0644 is refused by a world-bit check alone, so it cannot tell a correct mask from a narrow one.
  // 0640 is the case that separates them: readable by the group, invisible to a world-only check.
  it.runIf(typeof process.getuid === 'function').each([
    ['group read', 0o640],
    ['group write', 0o620],
    ['world read', 0o604],
    ['world write', 0o602],
    ['group and world', 0o666],
  ])('refuses a secret file that is %s', (_label, mode) => {
    chmodSync(join(dir, 'agnes', 'gateway'), mode)
    const r = refusal(() => createSecretsFile({ dir }).resolve('secret://agnes/gateway'))
    expect(r.detail.reason).toBe('mode')
  })
  it.runIf(typeof process.getuid === 'function').each([
    ['owner read only', 0o400],
    ['owner read and write', 0o600],
  ])('accepts a secret file that is %s', (_label, mode) => {
    chmodSync(join(dir, 'agnes', 'gateway'), mode)
    expect(createSecretsFile({ dir }).resolve('secret://agnes/gateway')).toBe('sk-value')
  })
  it.runIf(typeof process.getuid === 'function')(
    'never puts the value in the message or the detail of a refusal',
    () => {
      const r = createSecretsFile({ dir })
      chmodSync(join(dir, 'agnes', 'gateway'), 0o644)
      const refused = refusal(() => r.resolve('secret://agnes/gateway'))
      expect(refused.message).not.toContain('sk-value')
      expect(JSON.stringify(refused.detail)).not.toContain('sk-value')
    },
  )
  it('reports a missing file as unresolved rather than as a mode problem', () => {
    const r = refusal(() => createSecretsFile({ dir }).resolve('secret://agnes/absent'))
    expect(r.code).toBe('E_SECRET_UNRESOLVED')
    expect(r.detail).toEqual({ ref: 'secret://agnes/absent', kind: 'file' })
  })
  it('accepts a group- or world-unreadable file only when the mode check is turned off', () => {
    chmodSync(join(dir, 'agnes', 'gateway'), 0o644)
    expect(createSecretsFile({ dir, checkMode: false }).resolve('secret://agnes/gateway')).toBe('sk-value')
  })
  it('trims exactly one trailing newline, not internal or leading whitespace', () => {
    for (const name of ['crlf', 'spaces', 'none']) closeSync(createPrivateFileSync(join(dir, 'agnes', name)))
    writeFileSync(join(dir, 'agnes', 'crlf'), 'v\r\n', { mode: 0o600 })
    writeFileSync(join(dir, 'agnes', 'spaces'), ' a b \n', { mode: 0o600 })
    writeFileSync(join(dir, 'agnes', 'none'), 'v', { mode: 0o600 })
    const r = createSecretsFile({ dir })
    expect(r.resolve('secret://agnes/crlf')).toBe('v')
    expect(r.resolve('secret://agnes/spaces')).toBe(' a b ')
    expect(r.resolve('secret://agnes/none')).toBe('v')
  })
  it('env resolver maps ref to AGNES_SECRET_<NS>_<NAME>', () => {
    process.env.AGNES_SECRET_XINWEI_OA_TOKEN = 'tok'
    try {
      expect(createSecretsEnv().resolve('secret://xinwei/oa-token')).toBe('tok')
    } finally {
      delete process.env.AGNES_SECRET_XINWEI_OA_TOKEN
    }
  })
  it('env resolver names the variable it looked for when it is not set', () => {
    const r = refusal(() => createSecretsEnv().resolve('secret://xinwei/oa-token'))
    expect(r.detail).toEqual({
      ref: 'secret://xinwei/oa-token',
      kind: 'env',
      key: 'AGNES_SECRET_XINWEI_OA_TOKEN',
    })
  })
  it('composite tries in order and reports unresolved without values', () => {
    const c = composeSecrets(createSecretsFile({ dir }), createSecretsEnv())
    expect(c.kind).toBe('composite')
    expect(c.resolve('secret://agnes/gateway')).toBe('sk-value')
    expect(() => c.resolve('secret://agnes/missing')).toThrow(
      /E_SECRET_UNRESOLVED: secret:\/\/agnes\/missing/,
    )
  })
  it('composite falls through to a later resolver when an earlier one has nothing', () => {
    process.env.AGNES_SECRET_AGNES_ONLYENV = 'from-env'
    try {
      const c = composeSecrets(createSecretsFile({ dir }), createSecretsEnv())
      expect(c.resolve('secret://agnes/onlyenv')).toBe('from-env')
    } finally {
      delete process.env.AGNES_SECRET_AGNES_ONLYENV
    }
  })
  // A refusal is not a miss. The mode check exists to tell an operator that a secret file is
  // readable by other users; swallowed and fallen through, the composite answers with whatever the
  // environment happened to hold and the operator is never told, which is the check defeated
  // rather than applied.
  it.runIf(typeof process.getuid === 'function')(
    'composite rethrows a file-mode refusal instead of falling through to the environment',
    () => {
      writeFileSync(join(dir, 'agnes', 'loose'), 'from-file\n', { mode: 0o644 })
      process.env.AGNES_SECRET_AGNES_LOOSE = 'from-env'
      try {
        const c = composeSecrets(createSecretsFile({ dir }), createSecretsEnv())
        const r = refusal(() => c.resolve('secret://agnes/loose'))
        expect(r.code).toBe('E_SECRET_UNRESOLVED')
        expect(r.detail).toMatchObject({ reason: 'mode', kind: 'file' })
        expect(r.message).toMatch(/mode too open/)
        expect(r.message).not.toContain('from-env')
        expect(r.message).not.toContain('from-file')
      } finally {
        delete process.env.AGNES_SECRET_AGNES_LOOSE
      }
    },
  )
  // Order is the whole configuration: openAdapters composes [file, env] on purpose, and if that
  // ever inverts an environment variable silently overrides the file store for the same reference.
  it('composite takes the first resolver that answers, not the last', () => {
    process.env.AGNES_SECRET_AGNES_GATEWAY = 'from-env'
    try {
      expect(
        composeSecrets(createSecretsFile({ dir }), createSecretsEnv()).resolve('secret://agnes/gateway'),
      ).toBe('sk-value')
      expect(
        composeSecrets(createSecretsEnv(), createSecretsFile({ dir })).resolve('secret://agnes/gateway'),
      ).toBe('from-env')
    } finally {
      delete process.env.AGNES_SECRET_AGNES_GATEWAY
    }
  })
  it('composite refuses a malformed reference outright instead of asking every resolver', () => {
    let asked = 0
    const counting = {
      kind: 'env' as const,
      resolve() {
        asked++
        return 'x'
      },
    }
    const c = composeSecrets(counting, counting)
    expect(() => c.resolve('not-a-ref')).toThrow(/E_SECRET_UNRESOLVED/)
    expect(asked).toBe(0)
  })
})
