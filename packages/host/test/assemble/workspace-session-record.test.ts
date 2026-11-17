import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import { normalizeSandboxStaticConfig, sandboxStaticConfigHash } from '@agnes/host-common/workspace-policy'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
import { type SandboxExecutionRecord, SessionSandboxStore } from '@agnes/host-providers/profile/sandbox-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  legacyStaticConfigHash,
  officialPresetNames,
  sessionRecordVerifier,
  verifySessionRecord,
  windowsModeSource,
  windowsPermissionIntent,
} from '../../src/runtime/assemble/workspace-session-record.js'

const OVERLAY = {
  name: 'permission-workspace-write',
  sandbox: { level: 'L1', on_unavailable: 'allow-if-unimplemented', windows_mode: 'write-restricted' },
}
const presets: Record<string, PresetDoc> = {
  base: { name: 'base' },
  standard: { name: 'standard', extends: 'base' },
  'permission-workspace-write': OVERLAY,
  'permission-full-access': {
    name: 'permission-full-access',
    sandbox: { level: 'L0', on_unavailable: 'allow' },
  },
  mine: { name: 'mine', extends: 'standard' },
  'own-windows': { name: 'own-windows', sandbox: { level: 'L1', windows_mode: 'write-restricted' } },
}
const modules = new Map<string, PackageModule>([
  [
    'official',
    {
      presets: {
        base: presets.base!,
        standard: presets.standard!,
        ...pick('permission-workspace-write', 'permission-full-access'),
      },
    } as unknown as PackageModule,
  ],
  [
    'third-party',
    { presets: { mine: presets.mine!, 'own-windows': presets['own-windows']! } } as unknown as PackageModule,
  ],
])
function pick(...names: string[]): Record<string, PresetDoc> {
  return Object.fromEntries(names.map((name) => [name, presets[name]!]))
}
const profile = {
  packages: [
    { id: 'official', trust: 'builtin' as const },
    { id: 'third-party', trust: 'trusted' as const },
  ],
}

describe('Windows permission evidence', () => {
  it('computes the static config hash a Host without Windows settings saved', () => {
    const doc = { name: 'standard', sandbox: OVERLAY.sandbox }
    const windows = normalizeSandboxStaticConfig(doc, { target: 'win32' })
    expect(windows.windowsMode).toBe('write-restricted')
    expect(sandboxStaticConfigHash(windows)).not.toBe(
      sandboxStaticConfigHash(normalizeSandboxStaticConfig(doc)),
    )
    expect(legacyStaticConfigHash(windows)).toBe(sandboxStaticConfigHash(normalizeSandboxStaticConfig(doc)))
  })

  it('counts only builtin documents a profile bundle did not change as official', () => {
    const official = officialPresetNames(profile, modules)
    expect(official('permission-workspace-write')).toBe(true)
    expect(official('mine')).toBe(false)
    const bundled = officialPresetNames(
      { ...profile, bundlePresets: { 'permission-workspace-write': OVERLAY } },
      modules,
    )
    expect(bundled('permission-workspace-write')).toBe(false)
    expect(bundled('standard')).toBe(true)
  })

  it('names who wrote windows_mode into the session preset', () => {
    const official = officialPresetNames(profile, modules)
    const source = (origin: Parameters<typeof windowsModeSource>[0]) =>
      windowsModeSource(origin, presets, official)
    expect(source({ chain: ['base', 'standard'], permission: 'workspace-write' })).toBe('official')
    // A custom recipe that takes the official overlay still gets windows_mode from the overlay.
    expect(source({ chain: ['base', 'standard', 'mine'], permission: 'workspace-write' })).toBe('official')
    expect(source({ chain: ['own-windows'] })).toBe('custom')
    expect(source({ chain: ['base', 'standard'], permission: 'full-access' })).toBe('absent')
    // Without its origin a preset cannot prove where its setting came from.
    expect(source(undefined)).toBe('custom')
    const changed = officialPresetNames(
      { ...profile, bundlePresets: { 'permission-workspace-write': OVERLAY } },
      modules,
    )
    expect(windowsModeSource({ chain: ['standard'], permission: 'workspace-write' }, presets, changed)).toBe(
      'custom',
    )
  })

  it('records the strong constraints of the static config in the intent', () => {
    const config = normalizeSandboxStaticConfig(
      {
        name: 'x',
        sandbox: {
          level: 'L1',
          required: true,
          on_unavailable: 'deny',
          deny_paths: ['secret'],
          network_allow: ['example.com'],
          windows_mode: 'write-restricted',
        },
        providers: { 'tool-policy': { provider: 'read-only' } },
      },
      { target: 'win32' },
    )
    expect(windowsPermissionIntent(config, { chain: ['x'], permission: 'read-only' }, 'custom')).toEqual({
      permission: 'read-only',
      access: 'read-only',
      windowsMode: 'write-restricted',
      windowsModeSource: 'custom',
      required: true,
      onUnavailable: 'deny',
      customFsDeny: true,
      networkMode: 'hosts',
    })
  })
})

describe('session record routing', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const store = () => {
    const root = mkdtempSync(join(tmpdir(), 'agh-session-record-'))
    roots.push(root)
    const profileDir = join(root, 'profiles', 'p')
    mkdirSync(profileDir, { recursive: true })
    const file = (key: string) =>
      join(profileDir, '.session-sandbox', createHash('sha256').update(key).digest('hex') + '.json')
    return { store: new SessionSandboxStore(profileDir), file }
  }
  const execution: SandboxExecutionRecord = {
    workspaceId: 'w',
    workspaceRoot: '/work',
    policyDigest: 'c'.repeat(64),
    staticConfigHash: 'd'.repeat(64),
    provider: 'local',
    providerVersion: '0.0.0',
    target: 'darwin',
    implementation: 'implemented',
    probeState: 'ready',
    backend: 'l1',
    enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
  }

  it('keeps the version 1 record, byte for byte, off Windows', () => {
    const { store: sessions, file } = store()
    expect(verifySessionRecord({ store: sessions, key: 's', execution, hasHistory: false })).toBeUndefined()
    expect(readFileSync(file('s'), 'utf8')).toBe(JSON.stringify({ version: 1, sessionKey: 's', execution }))
  })

  it('writes the version 2 record on Windows and returns its current generation', () => {
    const { store: sessions, file } = store()
    const config = normalizeSandboxStaticConfig({ ...OVERLAY, name: 'x' }, { target: 'win32' })
    const windows = {
      ...execution,
      workspaceRoot: 'C:\\work',
      target: 'win32',
      implementation: 'unimplemented' as const,
      backend: 'none' as const,
      enforcement: { level: 'partial' as const, scope: ['file'] },
    }
    const generation = verifySessionRecord({
      store: sessions,
      key: 's',
      execution: windows,
      hasHistory: false,
      windows: { staticConfig: config, origin: { chain: ['x'] }, windowsModeSource: 'official' },
    })
    expect(generation).toMatchObject({ backend: 'none', reason: 'new-session' })
    expect(JSON.parse(readFileSync(file('s'), 'utf8'))).toMatchObject({
      version: 2,
      currentGeneration: generation!.generationId,
    })
  })
})

describe('the verifySession of a Windows workspace runtime', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const BOUNDARY = {
    contract: 'windows-write-restricted-v1',
    fileWrite: 'acl-partial',
    fileRead: 'unrestricted',
    network: 'unrestricted',
    processTree: 'job-object',
  } as const
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'agh-session-verifier-'))
    roots.push(root)
    const profileDir = join(root, 'profiles', 'p')
    mkdirSync(profileDir, { recursive: true })
    const staticConfig = normalizeSandboxStaticConfig({ ...OVERLAY, name: 'standard' }, { target: 'win32' })
    const plan = {
      policy: { workspaceRoot: 'C:\\work', digest: 'c'.repeat(64) },
      staticConfig,
      staticConfigHash: sandboxStaticConfigHash(staticConfig),
    }
    const bind = vi.fn()
    const posture = {
      execBackend: 'windows-acl' as const,
      enforcement: { level: 'partial' as const, scope: ['file' as const], boundary: BOUNDARY },
      windowsAcl: { bind },
    }
    // Storage holds the owner's session/start; a child reads that same row as its inherited prefix.
    const start = { id: 'start-1', seq: 1, data: { permission: 'workspace-write' } }
    const proc = {
      adapters: {
        platform: { os: 'win32' },
        storage: {
          scan: async () => [start],
          scanIntegrity: async () => [{ event: { id: 'start-1' }, sessionKey: 'owner' }],
        },
      },
      sandboxProviderSlot: { registry: { catalog: () => [{ id: 'local', version: '0.0.0' }] } },
      windowsAcl: { rootIdentity: vi.fn(async () => ({ volumeId: 'v', fileId: 'f' })) },
    }
    const verify = sessionRecordVerifier({
      profileDir,
      proc: proc as never,
      providerId: 'local',
      ownerKey: 'owner',
      workspaceId: 'w',
      implementation: 'unimplemented',
      requestedLevel: 'L1',
      windows: {
        origin: { chain: ['standard'], permission: 'workspace-write' },
        windowsModeSource: 'official',
      },
      state: () => ({ plan: plan as never, posture: posture as never }),
    })
    const file = (key: string) =>
      join(profileDir, '.session-sandbox', createHash('sha256').update(key).digest('hex') + '.json')
    return { profileDir, staticConfig, plan, bind, proc, verify, file }
  }

  it('adopts the saved session, then binds its generation to the gate after the record is durable', async () => {
    const f = fixture()
    const legacy = {
      version: 1,
      sessionKey: 'owner',
      execution: {
        workspaceId: 'w',
        workspaceRoot: 'C:\\work',
        policyDigest: 'c'.repeat(64),
        staticConfigHash: legacyStaticConfigHash(f.staticConfig),
        provider: 'local',
        providerVersion: '0.0.0',
        target: 'win32',
        implementation: 'unimplemented',
        probeState: 'unprobed',
        backend: 'none',
        enforcement: { level: 'partial', scope: ['file'] },
      },
    }
    mkdirSync(join(f.profileDir, '.session-sandbox'))
    writeFileSync(f.file('owner'), JSON.stringify(legacy))
    f.bind.mockImplementation(() => {
      // Bound only once the version 2 record is on disk.
      expect(JSON.parse(readFileSync(f.file('owner'), 'utf8')).version).toBe(2)
    })
    await f.verify('owner')
    const saved = JSON.parse(readFileSync(f.file('owner'), 'utf8'))
    expect(saved.legacyRecord).toEqual(legacy)
    expect(saved.generations[0]).toMatchObject({
      backend: 'windows-acl',
      rootIdentity: { volumeId: 'v', fileId: 'f' },
    })
    expect(f.bind).toHaveBeenCalledWith(saved.currentGeneration)
    expect(f.proc.windowsAcl.rootIdentity).toHaveBeenCalledWith('C:\\work')
  })

  it('verifies a child sharing the runtime without moving the owner gate', async () => {
    const f = fixture()
    await f.verify('owner/child')
    expect(JSON.parse(readFileSync(f.file('owner/child'), 'utf8'))).toMatchObject({ version: 2 })
    expect(f.bind).not.toHaveBeenCalled()
  })

  it('binds nothing when the record cannot be saved', async () => {
    const f = fixture()
    writeFileSync(join(f.profileDir, '.session-sandbox'), 'not a directory')
    await expect(f.verify('owner')).rejects.toThrow()
    expect(f.bind).not.toHaveBeenCalled()
  })
})
