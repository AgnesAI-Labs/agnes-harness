import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runConformance } from '../run-conformance.js'
import { runPackageAcceptance } from './packages.js'

const CLOCK = { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' } as const

// This aggregate runs both providers, all scenarios and a second split-provider report.
// Hosted Windows measured 17.4s; keep a finite budget independent of platform defaults.
describe('package source and resolver conformance', { timeout: 30_000 }, () => {
  it('passes both providers across the six scenarios', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'package-conformance-'))
    try {
      const run = await runConformance({
        contracts: ['agh.package-source', 'agh.package-resolver'],
        providers: ['default', 'reference'],
        command: 'package-contracts',
        clock: CLOCK,
        reportPath: join(directory, 'conformance.json'),
      })
      expect(run.report.status).toBe('passed')
      expect(run.report.failures).toEqual([])
      const required = run.report.assertions.filter((assertion) => assertion.qualification === 'required')
      const omitted = run.report.assertions.filter(
        (assertion) => assertion.qualification === 'not-advertised',
      )
      expect(required).toHaveLength(24)
      expect(required.every((assertion) => assertion.status === 'passed')).toBe(true)
      expect(omitted.map((assertion) => assertion.recipe).sort()).toEqual(['git', 'npm'])
      expect(
        omitted.every((assertion) => assertion.status === 'passed' && assertion.providerId === 'reference'),
      ).toBe(true)
      const full = await runConformance({
        contracts: ['agh.package-source', 'agh.package-resolver'],
        providers: ['agh.default/package-source', 'agh.reference/package-resolver'],
        command: 'package-contracts',
        clock: CLOCK,
        reportPath: join(directory, 'split.json'),
      })
      expect(full.report.assertions.filter((assertion) => assertion.status === 'passed')).toHaveLength(12)
      expect(full.report.assertions.some((assertion) => assertion.providerDigest === 'provider-absent')).toBe(
        true,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('agrees on local digests and refusals, and leaves npm and git to the default provider', async () => {
    const report = await runPackageAcceptance()
    expect(report.ok).toBe(true)
    expect(report.resolvers.sameLock).toBe(true)
    expect(report.resolvers.sameConflict).toBe(true)
    expect(report.resolvers.conflict).toContain('content identity mismatch')
    expect(report.sources.local.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(report.sources.local.sameDigest).toBe(true)
    expect(report.sources.refusal).toEqual({ detailCode: 'digest_mismatch', sameCode: true })
    expect(report.sources.symlink).toEqual({ detailCode: 'symlink_escape', sameCode: true })
    expect(report.sources.npm.digest).toBe(report.sources.local.digest)
    expect(report.sources.git.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(report.sources.git.head).not.toBe(report.sources.git.commit)
    expect(report.sources.referenceUnsupported).toEqual({
      npm: 'source_kind_unsupported',
      git: 'source_kind_unsupported',
    })
    expect(report.sources.local.installed).toBe(false)
    expect(report.sources.npm.installed).toBe(false)
    expect(report.sources.git.installed).toBe(false)
  })
})
