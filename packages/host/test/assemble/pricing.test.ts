import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSeams, testFsPolicy } from '@agnes/core/testkit'
import type { ModelRecord, RouteDecl } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryPackageLoader, type PackageModule } from '../../src/assemble/packages.js'
import { CREDITS_PER_USD_LIMIT, readCreditsPerUsd } from '../../src/assemble/provider.js'
import { type AssembleDeps, assemble } from '../../src/assemble.js'
import { type AuditEvent, type AuditSink, createMemoryAudit } from '../../src/audit.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import { attachTestSeamPlugins } from '../../testkit/cordis-seams.js'

/**
 * What a delivered assembly denominates its ledger in.
 *
 * @agnes/ai prices a turn from the catalogue and multiplies by the deployment's credit rate; with no
 * rate the factor is 1 and the credits column is a column of dollars. It says so once, on a logger
 * the caller supplies. host is the caller, and it used to supply neither the logger nor the rate -
 * so the sentence went nowhere and the fallback ran in every delivery. The cases below run the
 * absent-rate path first, because that is the path every assembly in this repository takes.
 */

const MODEL: ModelRecord = {
  id: 'm1',
  name: 'm1',
  api: 'openai',
  route: 'gw',
  baseUrl: 'https://gw.example/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 3000, output: 15000, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}
const ROUTE: RouteDecl = { route: 'gw', api: 'openai', baseUrl: 'https://gw.example/v1', models: [MODEL] }
const env = {
  platform: { os: 'linux' as const, arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-09T00:00:00Z',
}
const lockPkgs = {
  '@agnes/ai': { version: '0.1.0', integrity: 'sha512-a', trust: 'builtin' as const, enabled: true },
  '@agnes/base': { version: '0.1.0', integrity: 'sha512-b', trust: 'builtin' as const, enabled: true },
  '@agnes/code': { version: '0.1.0', integrity: 'sha512-c', trust: 'builtin' as const, enabled: true },
}
const SEAM_KEYS = [
  'approval',
  'checkpoint',
  'ledger',
  'sandbox',
  'verifier',
  'repair',
  'artifacts',
  'principals',
  'harness',
] as const

function modules(): Record<string, PackageModule> {
  const seams = fakeSeams()
  const result: Record<string, PackageModule> = {
    '@agnes/base': {
      id: '@agnes/base',
      seams: Object.fromEntries(
        SEAM_KEYS.map((n) => [
          n,
          n === 'sandbox'
            ? async (ctx: { profile: { workspaceRoot: string } }) => ({
                ...seams.sandbox,
                fsPolicy: () => testFsPolicy(realpathSync.native(ctx.profile.workspaceRoot)),
              })
            : async () => seams[n],
        ]),
      ),
      operations: {},
      presets: { base: { name: 'base' } },
    },
    '@agnes/code': {
      id: '@agnes/code',
      presets: { standard: { name: 'standard', extends: 'base', disclosure: 'standard' } },
      operations: {},
    },
    '@agnes/ai': { id: '@agnes/ai' },
  }
  attachTestSeamPlugins(result['@agnes/base'] as PackageModule)
  return result
}

const profileFor = (limits?: Record<string, number>) =>
  resolveProfile(
    {
      builtin: 'local-dev',
      lock: { packages: lockPkgs },
      user: {
        name: 'local-dev',
        provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
        ...(limits ? { limits } : {}),
      },
    },
    env,
  )

describe('the credit rate a delivered assembly runs on', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  // No providerFactory: the real @agnes/ai provider is built, which is the only way the warning
  // exists to be sunk. A test provider replaces the whole model seam and would prove nothing here.
  const deps = (): AssembleDeps & { warnings: string[] } => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-pricing-'))
    dirs.push(dataDir)
    const warnings: string[] = []
    return {
      dataDir,
      profileDir: join(dataDir, 'profiles', 'local-dev'),
      workspaceRoot: dataDir,
      homeDir: dataDir,
      hostRoot: process.cwd(),
      loader: new MemoryPackageLoader(modules()),
      audit: createMemoryAudit(),
      log: { debug() {}, info() {}, warn: (m: string) => void warnings.push(m), error() {} },
      agnesVersion: '0.1.0',
      env: { ...process.env },
      warnings,
    }
  }
  const row = (d: AssembleDeps): AuditEvent | undefined =>
    (d.audit as AuditSink & { events: AuditEvent[] }).events.find((e) => e.kind === 'provider.assembled')

  it('with no rate declared, the model layer warns and the assembly hears it', async () => {
    const p = await profileFor()
    const d = deps()
    const a = await assemble(p, d)
    expect(d.warnings.join('\n')).toContain('no pricing.creditsPerUsd')
    await a.rollback.unwind()
  })

  it('with no rate declared, the audit row says the credits column is dollars', async () => {
    const p = await profileFor()
    const d = deps()
    const a = await assemble(p, d)
    expect(row(d)?.detail).toMatchObject({ creditsPerUsd: null, creditUnit: 'usd' })
    await a.rollback.unwind()
  })

  it('a declared rate reaches the model layer, which is why it stops warning', async () => {
    const p = await profileFor({ [CREDITS_PER_USD_LIMIT]: 100 })
    const d = deps()
    const a = await assemble(p, d)
    expect(d.warnings.join('\n')).not.toContain('no pricing.creditsPerUsd')
    expect(row(d)?.detail).toMatchObject({ creditsPerUsd: 100, creditUnit: 'credit' })
    await a.rollback.unwind()
  })

  it('a rate that cannot price anything is refused at assembly, not defaulted', async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = await profileFor({ [CREDITS_PER_USD_LIMIT]: bad })
      await expect(assemble(p, deps())).rejects.toThrow(/E_API_RANGE.*cost\.credits_per_usd/)
    }
  })

  it('reads the rate off the profile limits map, and nothing else', async () => {
    expect(readCreditsPerUsd(await profileFor())).toBeUndefined()
    expect(readCreditsPerUsd(await profileFor({ [CREDITS_PER_USD_LIMIT]: 2.5 }))).toBe(2.5)
    expect(CREDITS_PER_USD_LIMIT).toBe('cost.credits_per_usd')
  })
})
