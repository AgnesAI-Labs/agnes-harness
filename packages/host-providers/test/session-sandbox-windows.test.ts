// Execution record version 2 on Windows: an existing session keeps its place, history and files and
// gets a new execution generation only when its saved records prove the original permission intent.
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type SandboxExecutionRecord, SessionSandboxStore } from '../src/profile/sandbox-state.js'
import type {
  WindowsExecutionVerification,
  WindowsPermissionIntent,
} from '../src/profile/session-sandbox-windows.js'

const BOUNDARY = {
  contract: 'windows-write-restricted-v1',
  fileWrite: 'acl-partial',
  fileRead: 'unrestricted',
  network: 'unrestricted',
  processTree: 'job-object',
} as const
const LEGACY_HASH = 'd'.repeat(64)
const CURRENT_HASH = 'e'.repeat(64)
const ROOT_ID = { volumeId: 'vol-1', fileId: 'file-1' }

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'agh-sandbox-v2-'))
  roots.push(home)
  const profileDir = join(home, 'profiles', 'test')
  mkdirSync(profileDir, { recursive: true })
  return { home, profileDir, store: new SessionSandboxStore(profileDir) }
}

const recordFile = (profileDir: string, key: string) =>
  join(profileDir, '.session-sandbox', createHash('sha256').update(key).digest('hex') + '.json')
const readRecord = (profileDir: string, key: string) =>
  JSON.parse(readFileSync(recordFile(profileDir, key), 'utf8')) as Record<string, unknown> & {
    version: number
    generations: Array<Record<string, unknown>>
    currentGeneration: string
  }

/** What a build before the Windows write restriction saved for a Windows session. */
const legacyExecution: SandboxExecutionRecord = {
  workspaceId: 'workspace',
  workspaceRoot: 'C:\\work',
  policyDigest: 'c'.repeat(64),
  staticConfigHash: LEGACY_HASH,
  provider: 'local',
  providerVersion: '0.0.0',
  target: 'win32',
  implementation: 'unimplemented',
  probeState: 'unprobed',
  backend: 'none',
  enforcement: { level: 'partial', scope: ['file'] },
}
/** The same session under this build: the hash now carries windows_mode, commands run under the ACL. */
const aclExecution: SandboxExecutionRecord = {
  ...legacyExecution,
  staticConfigHash: CURRENT_HASH,
  probeState: 'ready',
  backend: 'windows-acl',
  enforcement: { level: 'partial', scope: ['file'], boundary: BOUNDARY },
}
const officialIntent: WindowsPermissionIntent = {
  permission: 'workspace-write',
  access: 'workspace-write',
  windowsMode: 'write-restricted',
  windowsModeSource: 'official',
  required: false,
  onUnavailable: 'allow-if-unimplemented',
  customFsDeny: false,
  networkMode: 'allow',
}
/** The official default verified now; `rootIdentity: undefined` leaves the identity out. */
const verified = (
  overrides: Omit<Partial<WindowsExecutionVerification>, 'rootIdentity'> & {
    rootIdentity?: WindowsExecutionVerification['rootIdentity'] | undefined
  } = {},
): WindowsExecutionVerification => {
  const { rootIdentity, ...rest } = { rootIdentity: ROOT_ID, ...overrides }
  return {
    currentExecution: aclExecution,
    permissionEvidence: {
      intent: officialIntent,
      recordedPermission: 'workspace-write',
      legacyStaticConfigHash: LEGACY_HASH,
    },
    ...rest,
    ...(rootIdentity ? { rootIdentity } : {}),
  }
}
/** `recorded` is the permission the session start saved: the intent's own by default, `null` for none. */
const withIntent = (
  intent: Partial<WindowsPermissionIntent>,
  recorded?: WindowsPermissionIntent['permission'] | null,
) => {
  const merged = { ...officialIntent, ...intent }
  const recordedPermission = recorded === undefined ? merged.permission : (recorded ?? undefined)
  return verified({
    permissionEvidence: {
      intent: merged,
      ...(recordedPermission === undefined ? {} : { recordedPermission }),
      legacyStaticConfigHash: LEGACY_HASH,
    },
  })
}

/** Writes the v1 record exactly as the previous build did (one JSON.stringify of the whole value). */
function writeLegacy(profileDir: string, key: string, execution = legacyExecution): string {
  const bytes = JSON.stringify({ version: 1, sessionKey: key, execution })
  mkdirSync(join(profileDir, '.session-sandbox'), { recursive: true })
  writeFileSync(recordFile(profileDir, key), bytes)
  return bytes
}

/** Every byte of the session's history, attachments and workspace files, outside the record itself. */
function snapshot(home: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (name === '.session-sandbox') continue
      if (statSync(path).isDirectory()) walk(path)
      else files.set(relative(home, path), readFileSync(path).toString('base64'))
    }
  }
  walk(home)
  return files
}

const refusedAsInvalid = expect.objectContaining({
  code: 'E_SANDBOX_WORKSPACE',
  reason: 'session-execution-record-invalid',
})
const refusedForConfirmation = expect.objectContaining({
  code: 'E_SANDBOX_WORKSPACE',
  reason: 'session-workspace-confirmation-required',
})

describe('adopting a version 1 Windows record', () => {
  it('adopts verified legacy intent without moving the session', () => {
    const { home, profileDir } = setup()
    const log = { info: vi.fn() }
    const store = new SessionSandboxStore(profileDir, log)
    // A session's history, an attachment and workspace files live next to the record.
    mkdirSync(join(profileDir, 'sessions'), { recursive: true })
    writeFileSync(join(profileDir, 'sessions', 'old.jsonl'), '{"type":"session/start"}\n{"type":"message"}\n')
    mkdirSync(join(profileDir, 'attachments', 'old'), { recursive: true })
    writeFileSync(join(profileDir, 'attachments', 'old', 'a.png'), Buffer.from([0, 1, 2, 255]))
    mkdirSync(join(home, 'work', 'src'), { recursive: true })
    writeFileSync(join(home, 'work', 'src', 'main.ts'), 'export {}\n')
    const original = writeLegacy(profileDir, 'old')
    const before = snapshot(home)

    const generation = store.verifyWindowsExecution('old', verified(), true)

    const saved = readRecord(profileDir, 'old')
    expect(saved.version).toBe(2)
    expect(saved.sessionKey).toBe('old')
    expect(saved.legacyRecord).toEqual(JSON.parse(original))
    expect(saved.legacyDigest).toBe(createHash('sha256').update(original).digest('hex'))
    expect(saved.permissionIntent).toEqual(officialIntent)
    expect(saved.generations).toHaveLength(1)
    expect(saved.currentGeneration).toBe(generation.generationId)
    expect(saved.generations[0]).toEqual({
      ...aclExecution,
      generationId: generation.generationId,
      rootIdentity: ROOT_ID,
      reason: 'legacy-adoption',
      evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(snapshot(home)).toEqual(before)
    expect(log.info).toHaveBeenCalledWith(
      'Adopted session execution history under a new execution generation',
      expect.objectContaining({ backend: 'windows-acl' }),
    )
  })

  it('reuses the adopted generation on every later open without rewriting it', () => {
    const { profileDir, store } = setup()
    writeLegacy(profileDir, 'old')
    const first = store.verifyWindowsExecution('old', verified(), true)
    const bytes = readFileSync(recordFile(profileDir, 'old'), 'utf8')
    const reopened = new SessionSandboxStore(profileDir).verifyWindowsExecution('old', verified(), true)
    expect(reopened).toEqual(first)
    expect(readFileSync(recordFile(profileDir, 'old'), 'utf8')).toBe(bytes)
  })

  it('keeps an unchanged backend for full access and records no ACL protection', () => {
    const { profileDir, store } = setup()
    const full = { ...legacyExecution, enforcement: { level: 'none' as const, scope: [] } }
    writeLegacy(profileDir, 'full', full)
    const generation = store.verifyWindowsExecution(
      'full',
      {
        currentExecution: { ...full, staticConfigHash: CURRENT_HASH },
        permissionEvidence: {
          intent: {
            ...officialIntent,
            permission: 'full-access',
            access: 'full-access',
            windowsMode: 'require-full',
            windowsModeSource: 'absent',
            onUnavailable: 'allow',
          },
          recordedPermission: 'full-access',
          legacyStaticConfigHash: LEGACY_HASH,
        },
      },
      true,
    )
    expect(generation).toMatchObject({ backend: 'none', reason: 'legacy-adoption' })
    expect(generation.rootIdentity).toBeUndefined()
  })

  it.each([
    ['a custom windows_mode', withIntent({ windowsModeSource: 'custom' })],
    ['no windows_mode source', withIntent({ windowsModeSource: 'absent' })],
    ['required isolation', withIntent({ required: true })],
    ['a custom read deny', withIntent({ customFsDeny: true })],
    ['a network allowlist', withIntent({ networkMode: 'hosts' })],
    ['loopback serving', withIntent({ networkMode: 'loopback-serve' })],
    ['a strict on_unavailable', withIntent({ onUnavailable: 'deny' })],
    ['another saved permission', withIntent({}, 'read-only')],
    ['no saved permission', withIntent({}, null)],
    [
      'another saved static config',
      verified({
        permissionEvidence: {
          intent: officialIntent,
          recordedPermission: 'workspace-write',
          legacyStaticConfigHash: 'f'.repeat(64),
        },
      }),
    ],
    [
      'another policy digest',
      verified({ currentExecution: { ...aclExecution, policyDigest: 'b'.repeat(64) } }),
    ],
    ['another provider', verified({ currentExecution: { ...aclExecution, provider: 'remote-box' } })],
    ['another provider version', verified({ currentExecution: { ...aclExecution, providerVersion: '2' } })],
    ['no root identity', verified({ rootIdentity: undefined })],
  ])('refuses %s and keeps the history', (_name, input) => {
    const { profileDir, store } = setup()
    const original = writeLegacy(profileDir, 'old')
    expect(() => store.verifyWindowsExecution('old', input, true)).toThrow(refusedAsInvalid)
    expect(readFileSync(recordFile(profileDir, 'old'), 'utf8')).toBe(original)
  })

  it('never weakens a saved boundary that was stronger than the partial contract', () => {
    const { profileDir, store } = setup()
    const full = {
      ...legacyExecution,
      implementation: 'implemented' as const,
      probeState: 'ready' as const,
      backend: 'l1' as const,
      enforcement: { level: 'full' as const, scope: ['file', 'network', 'process'] },
    }
    const original = writeLegacy(profileDir, 'old', full)
    expect(() => store.verifyWindowsExecution('old', verified(), true)).toThrow(refusedAsInvalid)
    expect(readFileSync(recordFile(profileDir, 'old'), 'utf8')).toBe(original)
  })

  it.each([
    ['another workspace id', { workspaceId: 'other' }],
    ['another workspace root', { workspaceRoot: 'C:\\elsewhere' }],
  ])('asks to confirm the workspace again in this session for %s', (_name, change) => {
    const { profileDir, store } = setup()
    const original = writeLegacy(profileDir, 'old', { ...legacyExecution, ...change })
    let error: unknown
    try {
      store.verifyWindowsExecution('old', verified(), true)
    } catch (caught) {
      error = caught
    }
    expect(error).toEqual(refusedForConfirmation)
    expect((error as Error).message).not.toMatch(/new session/)
    expect(readFileSync(recordFile(profileDir, 'old'), 'utf8')).toBe(original)
  })

  it.each([
    ['damaged JSON', '{'],
    ['another session key', JSON.stringify({ version: 1, sessionKey: 'other', execution: legacyExecution })],
    ['no execution', JSON.stringify({ version: 1, sessionKey: 'old' })],
    ['an unknown version', JSON.stringify({ version: 3, sessionKey: 'old' })],
    [
      'a hand-edited spelling',
      JSON.stringify({ version: 1, sessionKey: 'old', execution: legacyExecution }, null, 2),
    ],
  ])('refuses %s and leaves it in place', (_name, bytes) => {
    const { profileDir, store } = setup()
    mkdirSync(join(profileDir, '.session-sandbox'), { recursive: true })
    writeFileSync(recordFile(profileDir, 'old'), bytes)
    expect(() => store.verifyWindowsExecution('old', verified(), true)).toThrow(refusedAsInvalid)
    expect(readFileSync(recordFile(profileDir, 'old'), 'utf8')).toBe(bytes)
  })

  it('refuses a session with history but no record at all', () => {
    const { profileDir, store } = setup()
    expect(() => store.verifyWindowsExecution('old', verified(), true)).toThrow(refusedAsInvalid)
    expect(existsSync(join(profileDir, '.session-sandbox'))).toBe(false)
  })
})

describe('version 2 records', () => {
  it('starts a new session with one generation and no legacy record', () => {
    const { profileDir, store } = setup()
    const generation = store.verifyWindowsExecution('new', verified(), false)
    const saved = readRecord(profileDir, 'new')
    expect(saved).toEqual({
      version: 2,
      sessionKey: 'new',
      permissionIntent: officialIntent,
      generations: [generation],
      currentGeneration: generation.generationId,
    })
    expect(generation.reason).toBe('new-session')
    expect(new SessionSandboxStore(profileDir).verifyWindowsExecution('new', verified(), true)).toEqual(
      generation,
    )
  })

  it('is refused by the version 1 reader, which never falls back to an older path', () => {
    const { profileDir, store } = setup()
    writeLegacy(profileDir, 'old')
    store.verifyWindowsExecution('old', verified(), true)
    const bytes = readFileSync(recordFile(profileDir, 'old'), 'utf8')
    expect(() => store.verify('old', legacyExecution, true)).toThrow('create a new session')
    expect(() => store.verify('old', aclExecution, true)).toThrow('create a new session')
    expect(readFileSync(recordFile(profileDir, 'old'), 'utf8')).toBe(bytes)
  })

  it('refuses a permission change inside the same session and keeps every generation', () => {
    const { profileDir, store } = setup()
    store.verifyWindowsExecution('s', verified(), false)
    const bytes = readFileSync(recordFile(profileDir, 's'), 'utf8')
    for (const input of [
      withIntent({ permission: 'read-only', access: 'read-only' }),
      verified({ currentExecution: { ...aclExecution, staticConfigHash: 'f'.repeat(64) } }),
      verified({ currentExecution: { ...aclExecution, policyDigest: 'b'.repeat(64) } }),
      verified({ currentExecution: { ...aclExecution, backend: 'none', probeState: 'unprobed' } }),
    ])
      expect(() => store.verifyWindowsExecution('s', input, true)).toThrow(refusedAsInvalid)
    expect(readFileSync(recordFile(profileDir, 's'), 'utf8')).toBe(bytes)
  })

  it('appends a generation only when the backend gets stronger and leaves earlier ones untouched', () => {
    const { profileDir, store } = setup()
    const unconfined = verified({
      currentExecution: {
        ...aclExecution,
        backend: 'none',
        probeState: 'unprobed',
        enforcement: legacyExecution.enforcement,
      },
      rootIdentity: undefined,
    })
    const first = store.verifyWindowsExecution('s', unconfined, false)
    const firstRecord = readRecord(profileDir, 's')
    const second = store.verifyWindowsExecution('s', verified(), true)
    const saved = readRecord(profileDir, 's')
    expect(saved.generations).toEqual([firstRecord.generations[0], second])
    expect(saved.generations[0]).toEqual(first)
    expect(second).toMatchObject({ backend: 'windows-acl', reason: 'backend-change', rootIdentity: ROOT_ID })
    expect(second.generationId).not.toBe(first.generationId)
    expect(saved.currentGeneration).toBe(second.generationId)
    // Ordinary opens reference the current generation; nothing is copied per command.
    store.verifyWindowsExecution('s', verified(), true)
    expect(readRecord(profileDir, 's').generations).toHaveLength(2)
  })

  it('binds the current root identity and asks to confirm the workspace after the directory was replaced', () => {
    const { profileDir, store } = setup()
    const generation = store.verifyWindowsExecution('s', verified(), false)
    const bytes = readFileSync(recordFile(profileDir, 's'), 'utf8')
    const replaced = verified({ rootIdentity: { volumeId: 'vol-1', fileId: 'file-2' } })
    expect(() => store.verifyWindowsExecution('s', replaced, true)).toThrow(refusedForConfirmation)
    expect(readFileSync(recordFile(profileDir, 's'), 'utf8')).toBe(bytes)

    // The confirmation stays in this session and starts a new generation at the current directory.
    const confirmed = store.confirmWindowsWorkspace('s', replaced)
    expect(confirmed).toMatchObject({
      reason: 'workspace-confirmed',
      rootIdentity: { volumeId: 'vol-1', fileId: 'file-2' },
    })
    expect(readRecord(profileDir, 's').generations).toEqual([generation, confirmed])
    expect(store.verifyWindowsExecution('s', replaced, true)).toEqual(confirmed)
  })

  it('confirms only a replaced directory, never another workspace or permission', () => {
    const { store } = setup()
    store.verifyWindowsExecution('s', verified(), false)
    expect(() => store.confirmWindowsWorkspace('s', verified())).toThrow(refusedAsInvalid)
    expect(() =>
      store.confirmWindowsWorkspace(
        's',
        verified({
          currentExecution: { ...aclExecution, workspaceRoot: 'C:\\elsewhere' },
          rootIdentity: { volumeId: 'v', fileId: 'other' },
        }),
      ),
    ).toThrow(refusedAsInvalid)
    expect(() =>
      store.confirmWindowsWorkspace(
        's',
        verified({
          ...withIntent({ permission: 'read-only', access: 'read-only' }),
          rootIdentity: { volumeId: 'v', fileId: 'other' },
        }),
      ),
    ).toThrow(refusedAsInvalid)
  })

  it.each([
    [
      'a missing current generation',
      (record: Record<string, unknown>) => ({ ...record, currentGeneration: 'x' }),
    ],
    ['no generations', (record: Record<string, unknown>) => ({ ...record, generations: [] })],
    [
      'a generation edited to follow another directory',
      (record: Record<string, unknown> & { generations: Array<Record<string, unknown>> }) => ({
        ...record,
        generations: [{ ...record.generations[0], rootIdentity: { volumeId: 'vol-1', fileId: 'file-2' } }],
      }),
    ],
    [
      'an edited legacy record',
      (record: Record<string, unknown> & { legacyRecord?: Record<string, unknown> }) => ({
        ...record,
        legacyRecord: { ...record.legacyRecord, sessionKey: 'other' },
      }),
    ],
    ['another session key', (record: Record<string, unknown>) => ({ ...record, sessionKey: 'other' })],
  ] as const)('refuses %s', (_name, damage) => {
    const { profileDir, store } = setup()
    writeLegacy(profileDir, 's')
    store.verifyWindowsExecution('s', verified(), true)
    const damaged = JSON.stringify(damage(readRecord(profileDir, 's') as never))
    writeFileSync(recordFile(profileDir, 's'), damaged)
    expect(() => store.verifyWindowsExecution('s', verified(), true)).toThrow(refusedAsInvalid)
    expect(readFileSync(recordFile(profileDir, 's'), 'utf8')).toBe(damaged)
  })

  it('gives a child the same verification and never relaxes a stricter child record', () => {
    const { store } = setup()
    store.verifyWindowsExecution('parent', verified(), false)
    // A child inheriting the parent's prefix verifies as new with the runtime it shares.
    expect(store.verifyWindowsExecution('parent/child', verified(), false).reason).toBe('new-session')
    // A child saved read-only keeps read-only when it reopens under a parent that writes.
    store.verifyWindowsExecution(
      'parent/strict',
      withIntent({ permission: 'read-only', access: 'read-only' }),
      false,
    )
    expect(() => store.verifyWindowsExecution('parent/strict', verified(), true)).toThrow(refusedAsInvalid)
  })

  it('publishes the record before returning and refuses when it cannot be published', () => {
    const { profileDir, store } = setup()
    writeFileSync(join(profileDir, '.session-sandbox'), 'not a directory')
    expect(() => store.verifyWindowsExecution('s', verified(), false)).toThrow()
    rmSync(join(profileDir, '.session-sandbox'))
    store.verifyWindowsExecution('s', verified(), false)
    expect(readRecord(profileDir, 's').version).toBe(2)
    store.release('s')
    expect(existsSync(recordFile(profileDir, 's'))).toBe(false)
  })
})
