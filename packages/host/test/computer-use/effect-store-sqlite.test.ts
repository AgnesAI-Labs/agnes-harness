import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'
import { createSqliteComputerUseEffectStore } from '../../src/computer-use/effect-store-sqlite.js'
import type { ComputerUseEffectBinding } from '../../src/computer-use/host-enforcement.js'

const roots: string[] = []
const owner = '@agnes/host/computer-use-effects'
const hash = (digit: string) => digit.repeat(64)

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'agnes-computer-use-effects-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function binding(overrides: Partial<ComputerUseEffectBinding> = {}): ComputerUseEffectBinding {
  return {
    effectId: 'effect-a',
    sessionKey: 'session-a',
    lane: 'main',
    ownerId: 'owner-a',
    profileHash: hash('a'),
    callId: 'call-a',
    argsHash: hash('b'),
    action: 'click',
    deliveryMode: 'background',
    bringToFront: false,
    definitionFingerprint: hash('c'),
    policyHash: hash('d'),
    generation: 1,
    mode: 'standard',
    authorization: 'driver-standard',
    ...overrides,
  }
}

function open(root: string) {
  const tablesDir = join(root, 'tables')
  const storage = createSqliteStorage({ file: join(root, 'sessions.db'), tablesDir })
  const tables = storage.tables(owner)
  return {
    storage,
    tables,
    store: createSqliteComputerUseEffectStore(tables),
    tablesDir,
  }
}

describe('durable Computer Use effect store', () => {
  it('atomically admits one dispatcher and turns a concurrent dispatching recovery into unknown', async () => {
    const root = temp()
    const left = open(root)
    const right = open(root)
    try {
      expect(await left.store.claim(binding())).toEqual({ status: 'claimed' })
      expect(await right.store.claim(binding())).toEqual({ status: 'terminal', phase: 'unknown' })
      expect(await left.store.claim(binding())).toEqual({ status: 'terminal', phase: 'unknown' })
      await expect(left.store.finish(binding(), 'responded')).rejects.toThrow(/terminal effect/)
    } finally {
      await left.storage.close()
      await right.storage.close()
    }
  })

  it('allows only a durably not-sent mutation to retry', async () => {
    const root = temp()
    const first = open(root)
    expect(await first.store.claim(binding())).toEqual({ status: 'claimed' })
    await first.store.finish(binding(), 'not_sent')
    await first.storage.close()

    const opened = open(root)
    try {
      expect(await opened.store.claim(binding())).toEqual({ status: 'claimed' })
      await opened.store.finish(binding(), 'responded')
      await opened.store.finish(binding(), 'responded')
      expect(await opened.store.claim(binding())).toEqual({ status: 'terminal', phase: 'responded' })

      const unknown = binding({ effectId: 'effect-unknown', callId: 'call-unknown' })
      expect(await opened.store.claim(unknown)).toEqual({ status: 'claimed' })
      await opened.store.finish(unknown, 'unknown')
      expect(await opened.store.claim(unknown)).toEqual({ status: 'terminal', phase: 'unknown' })

      const exhausted = binding({ effectId: 'effect-exhausted', callId: 'call-exhausted' })
      expect(await opened.store.claim(exhausted)).toEqual({ status: 'claimed' })
      await opened.store.finish(exhausted, 'not_sent')
      expect(await opened.store.claim(exhausted)).toEqual({ status: 'claimed' })
      await opened.store.finish(exhausted, 'not_sent')
      expect(await opened.store.claim(exhausted)).toEqual({ status: 'terminal', phase: 'unknown' })
    } finally {
      await opened.storage.close()
    }
  })

  it('detects identity collisions while isolating sessions, lanes, and owners', async () => {
    const opened = open(temp())
    try {
      expect(await opened.store.claim(binding())).toEqual({ status: 'claimed' })
      for (const changed of [
        { argsHash: hash('e') },
        { action: 'type' },
        { generation: 2 },
        { policyHash: hash('f') },
      ])
        expect(await opened.store.claim(binding(changed))).toEqual({ status: 'conflict' })
      await expect(opened.store.finish(binding({ argsHash: hash('e') }), 'responded')).rejects.toThrow(
        /identity mismatch/,
      )

      for (const isolated of [{ sessionKey: 'session-b' }, { lane: 'side' }, { ownerId: 'owner-b' }])
        expect(await opened.store.claim(binding(isolated))).toEqual({ status: 'claimed' })
    } finally {
      await opened.storage.close()
    }
  })

  it('persists terminal state across independent storage instances', async () => {
    const root = temp()
    const first = open(root)
    expect(await first.store.claim(binding())).toEqual({ status: 'claimed' })
    await first.store.finish(binding(), 'responded')
    await first.storage.close()

    const reopened = open(root)
    try {
      expect(await reopened.store.claim(binding())).toEqual({ status: 'terminal', phase: 'responded' })
    } finally {
      await reopened.storage.close()
    }
  })

  it('stores only digests and phase, never caller identifiers or transport credentials', async () => {
    const opened = open(temp())
    const secret = 'Bearer-test-only-credential-must-not-persist'
    const sensitive = binding({
      effectId: `effect-${secret}`,
      sessionKey: `session-${secret}`,
      callId: `call-${secret}`,
      ownerId: `owner-${secret}`,
    })
    expect(await opened.store.claim(sensitive)).toEqual({ status: 'claimed' })
    await opened.store.finish(sensitive, 'unknown')
    const rows = opened.tables
      .table('computer_use_effects')
      .all<Record<string, unknown>>('SELECT * FROM computer_use_effects')
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'binding_hash',
      'dispatch_ordinal',
      'lookup_hash',
      'phase',
    ])
    expect(JSON.stringify(rows)).not.toContain(secret)
    await opened.storage.close()

    for (const file of readdirSync(opened.tablesDir)) {
      const bytes = readFileSync(join(opened.tablesDir, file))
      expect(bytes.includes(Buffer.from(secret))).toBe(false)
    }
  })

  it('rejects hostile bindings without invoking accessors or writing a claim', async () => {
    const opened = open(temp())
    try {
      const getter = vi.fn(() => 'effect-forged')
      const accessor = { ...binding() }
      Object.defineProperty(accessor, 'effectId', { enumerable: true, get: getter })
      const proxyGet = vi.fn(() => {
        throw new Error('Bearer secret')
      })
      await expect(opened.store.claim(accessor)).rejects.toThrow(/invalid Computer Use effect binding/)
      await expect(opened.store.claim(new Proxy(binding(), { get: proxyGet }))).rejects.toThrow(
        /invalid Computer Use effect binding/,
      )
      await expect(
        opened.store.claim({ ...binding(), extra: true } as ComputerUseEffectBinding),
      ).rejects.toThrow(/invalid Computer Use effect binding/)
      await expect(
        opened.store.claim({
          ...binding(),
          capabilityManifestDigest: undefined,
        } as unknown as ComputerUseEffectBinding),
      ).rejects.toThrow(/invalid Computer Use effect binding/)
      expect(getter).not.toHaveBeenCalled()
      expect(proxyGet).not.toHaveBeenCalled()
      expect(opened.tables.table('computer_use_effects').all('SELECT * FROM computer_use_effects')).toEqual(
        [],
      )
    } finally {
      await opened.storage.close()
    }
  })

  it('fails closed on incompatible schema or rows', async () => {
    const root = temp()
    const storage = createSqliteStorage({
      file: join(root, 'sessions.db'),
      tablesDir: join(root, 'tables'),
    })
    const tables = storage.tables(owner)
    tables.table('computer_use_effects').exec('CREATE TABLE unexpected (value TEXT)')
    expect(() => createSqliteComputerUseEffectStore(tables)).toThrow(/E_COMPUTER_USE_EFFECT_SCHEMA/)
    await storage.close()

    const rowRoot = temp()
    const corrupted = open(rowRoot)
    expect(await corrupted.store.claim(binding())).toEqual({ status: 'claimed' })
    corrupted.tables
      .table('computer_use_effects')
      .run("UPDATE computer_use_effects SET binding_hash = 'not-a-digest'")
    await expect(corrupted.store.claim(binding())).rejects.toThrow(/invalid durable row/)
    await corrupted.storage.close()

    const rowStorage = createSqliteStorage({
      file: join(rowRoot, 'sessions.db'),
      tablesDir: join(rowRoot, 'tables'),
    })
    expect(() => createSqliteComputerUseEffectStore(rowStorage.tables(owner))).toThrow(/invalid durable row/)
    await rowStorage.close()
  })
})
