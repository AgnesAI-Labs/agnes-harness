import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SeamInitContext as BaseSeamInitContext } from '@agnes/base'
import { seams } from '@agnes/base'
import { SEAM_NAMES } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { openAdapters, toSeamAdapters } from '../src/adapters/index.js'
import type { SeamInitContext as HostSeamInitContext } from '../src/assemble/packages.js'
import { resolveProfile } from '../src/profile/resolve.js'
import type { LockState, ResolveEnv } from '../src/profile/types.js'

// `@agnes/base` cannot import this package, so it restates the assembly context as a consumption
// contract of its own. This line is the whole of what keeps the two spellings honest: the host's
// object has to be usable as base's, in that direction, at every member. Deleting a field from
// either side, or renaming one, stops compiling here rather than at whichever seam reached for it.
const _hostSatisfiesBase: (c: HostSeamInitContext) => BaseSeamInitContext = (c) => c

const env: ResolveEnv = {
  platform: { os: 'linux', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-07T00:00:00Z',
}
const lock: LockState = {
  packages: {
    '@agnes/base': { version: '0.1.0', integrity: 'sha512-b', trust: 'builtin', enabled: true },
    '@agnes/code': { version: '0.1.0', integrity: 'sha512-c', trust: 'builtin', enabled: true },
    '@agnes/ai': { version: '0.1.0', integrity: 'sha512-a', trust: 'builtin', enabled: true },
  },
}

describe('@agnes/base consumption contract against the real host adapters', () => {
  it('runs the artifacts seam against the assembled adapters, with dataDir outside the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-bc-'))
    const dataDir = join(root, 'data')
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agnes-bc-ws-'))
    try {
      const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
      const bundle = await openAdapters(profile, { dataDir, workspaceRoot })
      const ctx: BaseSeamInitContext = {
        secrets: (ref) => bundle.secrets.resolve(ref),
        adapters: toSeamAdapters(bundle, { owner: '@agnes/base' }),
        profile: {
          name: profile.name,
          resolvedProfileHash: profile.hash,
          dataDir,
          workspaceRoot,
          homeDir: '/home/nobody',
          limits: profile.limits,
          preset: {},
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        signal: new AbortController().signal,
      }
      const artifacts = await seams.artifacts(ctx)
      const ref = await artifacts.put(new TextEncoder().encode('hello'), { mime: 'text/plain' })
      expect(ref.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
      // On disk, under dataDir, at the path the seam's own tests assert against the fake.
      expect(existsSync(join(dataDir, 'artifacts', 'sha256', '2c', ref.sha256))).toBe(true)
      expect(new TextDecoder().decode(await artifacts.get(ref))).toBe('hello')
      expect(await artifacts.put(new TextEncoder().encode('hello'))).toMatchObject({ sha256: ref.sha256 })
      // And the reason it needs its own handle: the workspace one refuses that path outright.
      await expect(
        ctx.adapters.fs.read(join(dataDir, 'artifacts', 'sha256', '2c', ref.sha256)),
      ).rejects.toThrow(/E_FS_DENIED/)
      await bundle.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('keeps the host files inside dataDir out of reach of a seam', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-bc2-'))
    try {
      const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
      const bundle = await openAdapters(profile, { dataDir, workspaceRoot: dataDir })
      const seamFs = toSeamAdapters(bundle, { owner: '@agnes/base' }).dataFs
      for (const p of ['secrets/k', 'tables/x.db', 'audit/host.jsonl', 'sessions.db'])
        await expect(seamFs.read(join(dataDir, p)), p).rejects.toThrow(/E_FS_DENIED/)
      // Its own store is not on the list.
      await seamFs.write(join(dataDir, 'artifacts', 'x'), new Uint8Array([1]))
      expect(existsSync(join(dataDir, 'artifacts', 'x'))).toBe(true)
      await bundle.close()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('declares only seam names core knows, and the profile can be pointed at them', async () => {
    // The list grows as the remaining pieces land, so it is checked against core's own set rather
    // than restated here: a name outside that set is a name no profile can point at, and it would
    // otherwise be found by whoever assembled a profile against it rather than by this file.
    // `platform` is excluded because it is the host's own backend, not a package's to supply.
    const declared = Object.keys(seams).sort()
    for (const n of declared) expect(SEAM_NAMES, n).toContain(n)
    expect(declared).not.toContain('platform')
    // Pinned so a seam that stops being exported is a failure here rather than an assembly that
    // refuses at startup for a package this test says delivers it.
    expect(declared).toEqual([
      'approval',
      'artifacts',
      'checkpoint',
      'harness',
      'ledger',
      'principals',
      'repair',
      'sandbox',
      'verifier',
    ])
  })
})
