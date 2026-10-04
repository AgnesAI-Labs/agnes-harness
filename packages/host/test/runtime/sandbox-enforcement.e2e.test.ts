import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createReferenceSandbox } from '../../../../examples/runtime-reference/src/providers/sandbox.js'
import { cleanup, error } from './network-secrets-fixture.js'
import { fixture } from './sandbox-exec-fixture.js'
import { expectedRefusal } from './sandbox-exec-scenarios.js'

describe('mandatory sandbox hard-limit admission', () => {
  it.each(['default', 'reference'] as const)('%s refuses before a launch callback', async (kind) => {
    const f = await fixture(kind)
    const effect = join(f.roots.workspace, 'effect')
    try {
      expect(error(await f.sandbox.create(f.createInput, f.auth.call()))).toBe(expectedRefusal('sandbox'))
      expect(f.sandbox.features).toEqual([])
      const request = {
        sandboxRef: {
          authorityId: 'sandbox-authority',
          sandboxId: 'old-handle',
          ownerBinding: f.sandbox.binding,
          lease: f.mount.lease,
        },
        argv: ['/usr/bin/touch', effect],
        cwd: { mount: f.mount, path: '' },
        env: [],
        stdinRef: null,
        limits: f.createInput.resourceLimits,
      }
      const result = await f.sandbox.withExecution(request, f.auth.call(), async () => {
        writeFileSync(effect, 'started')
        return null
      })
      expect(error(result)).toBe('incompatible/sandbox_limit_memoryBytes_unsupported')
      expect(existsSync(effect)).toBe(false)
    } finally {
      await f.close()
      cleanup(f.directory)
    }
  })
  it('matches refusal codes and literal zero for the same input', async () => {
    const f = await fixture()
    const ref = createReferenceSandbox({ ...f.sandboxOptions, directory: join(f.directory, 'cross') })
    try {
      for (const patch of [
        {},
        { mode: 'remote' },
        ...Object.keys(f.createInput.resourceLimits).map((field) => ({
          resourceLimits: { ...f.createInput.resourceLimits, [field]: 0 },
        })),
      ]) {
        const call = f.auth.call(),
          input = { ...f.createInput, ...patch }
        expect(error(await f.sandbox.create(input, call))).toBe(error(await ref.create(input, call)))
        if ('resourceLimits' in patch)
          expect(error(await f.sandbox.create(input, f.auth.call()))).toBe('quota/sandbox_zero_limit')
      }
    } finally {
      await ref.close()
      await f.close()
      cleanup(f.directory)
    }
  })
  it('reports admission evidence separately from incomplete normal and recovery qualification', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hard-gate-report-'))
    const path = join(directory, 'report.json')
    let report: {
      status: string
      assertions: Array<{
        scenario: string
        qualification: string
        status: string
        features: string[]
        diagnostic?: string
      }>
    }
    try {
      execFileSync(process.execPath, [
        '--import',
        'tsx',
        fileURLToPath(new URL('../../../../tools/acceptance/runtime/run-conformance.ts', import.meta.url)),
        '--contracts',
        'agh.sandbox,agh.exec',
        '--providers',
        'default,reference',
        '--report',
        path,
      ])
      report = JSON.parse(readFileSync(path, 'utf8'))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
    expect(report.status).toBe('passed')
    for (const row of report.assertions) {
      if (['select', 'normal', 'recover'].includes(row.scenario)) {
        expect(row.qualification).toBe('not-advertised')
        expect(row.status).toBe('skipped')
        expect(row.features).toEqual([])
        expect(row.diagnostic).toContain('Incomplete')
      } else {
        expect(['deny', 'cancel', 'dispose']).toContain(row.scenario)
        expect(row.status).toBe('passed')
        expect(row.features).toEqual(['admission-refusal'])
      }
    }
    expect(report.assertions).toHaveLength(24)
  })
})
