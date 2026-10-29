import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SeamInitContext as BaseSeamInitContext } from '@agnes/base'
import { BASE_SEAM_PROVIDERS } from '@agnes/base'
import { SEAM_NAMES } from '@agnes/core'
import { SEAM_KINDS } from '@agnes/extension-api/seams'
import { resolveProfile } from '@agnes/host-common/profile/resolve'
import type { LockState, ResolveEnv } from '@agnes/host-common/profile/types'
import type { SeamInitContext as HostSeamInitContext } from '@agnes/host-extensions/assemble/packages'
import { describe, expect, it } from 'vitest'
import { openAdapters, toSeamAdapters } from '../src/runtime/adapters/index.js'

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
    '@agnes/base': {
      version: '0.1.0',
      source: { type: 'builtin' as const, ref: 'builtin' },
      integrity: 'builtin:0.1.0',
      trust: 'builtin',
      enabled: true,
    },
    '@agnes/code': {
      version: '0.1.0',
      source: { type: 'builtin' as const, ref: 'builtin' },
      integrity: 'builtin:0.1.0',
      trust: 'builtin',
      enabled: true,
    },
    '@agnes/ai': {
      version: '0.1.0',
      source: { type: 'builtin' as const, ref: 'builtin' },
      integrity: 'builtin:0.1.0',
      trust: 'builtin',
      enabled: true,
    },
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
      const artifacts = await BASE_SEAM_PROVIDERS.artifacts.create(ctx, new AbortController().signal)
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

  it('delivers the seven seam kinds as registered providers', () => {
    expect(Object.keys(BASE_SEAM_PROVIDERS).sort()).toEqual([...SEAM_KINDS].sort())
  })
})
