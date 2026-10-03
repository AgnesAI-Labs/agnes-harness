import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  createConformanceHarness,
  judgeReport as judgeFromKit,
  SCENARIOS,
} from '../../../packages/extension-api/testkit/index.js'
import { getConformanceBuildIdentity } from './build-identity.js'
import { SAMPLE_CLOCK, sampleAssertion, sampleDraft } from './fixtures.js'
import { judgeReport, mergeReports, serializeReport, writeReport } from './report.js'
import { conformanceBinderFiles, main, parseConformanceArgs, runConformance } from './run-conformance.js'

describe('conformance report entry', () => {
  it('keeps the cached checkout identity equal in a fresh recover process and rejects a mismatch', () => {
    const build = getConformanceBuildIdentity()
    expect(getConformanceBuildIdentity()).toBe(build)
    expect(Object.isFrozen(build)).toBe(true)
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const module = new URL('./build-identity.ts', import.meta.url).href
    const child = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { getConformanceBuildIdentity } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(getConformanceBuildIdentity()))`,
      ],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    )
    expect(JSON.parse(child)).toEqual(build)
    const directory = mkdtempSync(join(tmpdir(), 'recover-build-'))
    try {
      const rejected = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('./client/ui-registry-conformance.ts', import.meta.url)),
          directory,
          JSON.stringify({ ...build, codeSha: 'other-checkout' }),
        ],
        { cwd: root, encoding: 'utf8', timeout: 30_000 },
      )
      expect(rejected.status).toBe(1)
      expect(rejected.stderr).toContain('AssertionError')
      expect(rejected.stderr).toContain('other-checkout')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
  it.each([new Error('case exploded'), 'non-Error refusal'])(
    'records a thrown case and continues: %s',
    async (error) => {
      const harness = createConformanceHarness()
      harness.registerCase({
        contract: 'agh.loop',
        scenario: 'normal',
        qualification: 'required',
        providerId: 'reference',
        async run() {
          throw error
        },
      })
      harness.registerCase({
        contract: 'agh.loop',
        scenario: 'recover',
        qualification: 'required',
        providerId: 'reference',
        async run() {
          return sampleAssertion({ id: 'later-case' })
        },
      })
      const report = await harness.run({
        contracts: ['agh.loop'],
        providers: ['reference'],
        command: 'throw-case',
        clock: SAMPLE_CLOCK,
      })
      expect(report.status).toBe('failed')
      expect(report.assertions).toHaveLength(2)
      expect(report.assertions[0]).toMatchObject({
        contract: 'agh.loop',
        scenario: 'normal',
        qualification: 'required',
        providerId: 'reference',
        status: 'failed',
        diagnostic: error instanceof Error ? error.message : error,
      })
      expect(report.assertions[1]).toMatchObject({ id: 'later-case', scenario: 'recover', status: 'passed' })
      expect(JSON.parse(serializeReport(report)).assertions[0].diagnostic).toBe(
        error instanceof Error ? error.message : error,
      )
    },
  )
  it('uses the testkit judge and keeps one input on the same bytes', () => {
    expect(judgeReport).toBe(judgeFromKit)
    const report = judgeReport(sampleDraft([sampleAssertion({ features: ['write', 'read'] })]))
    const text = serializeReport(report)
    expect(text).toBe(
      serializeReport(judgeReport(sampleDraft([sampleAssertion({ features: ['write', 'read'] })]))),
    )
    expect(text).toContain('"features":["write","read"]')
    expect(text).toContain(`"startedAt":"${SAMPLE_CLOCK.startedAt}"`)
    expect(report.status).toBe('passed')
  })

  it('rejects missing evidence, mixed versions, and every empty run', () => {
    expect(judgeReport(sampleDraft([{ ...sampleAssertion(), recipe: '' }])).failures).toEqual([
      { code: 'missing-evidence', detail: 'assertion 0 missing recipe' },
    ])
    expect(
      judgeReport(
        sampleDraft([
          sampleAssertion({ id: 'one' }),
          sampleAssertion({ id: 'two', build: { ...sampleAssertion().build, lockDigest: 'other-lock' } }),
        ]),
      ).failures,
    ).toEqual([{ code: 'mixed-version', detail: 'mixed sdkDigest, lockDigest, buildDigest or specVersion' }])
    expect(judgeReport(sampleDraft([])).failures).toEqual([{ code: 'empty-run', detail: 'zero assertions' }])
    expect(
      judgeReport(sampleDraft([sampleAssertion({ qualification: 'advertised', status: 'skipped' })]))
        .failures,
    ).toEqual([{ code: 'empty-run', detail: 'all skipped' }])
    expect(judgeReport(sampleDraft([sampleAssertion({ qualification: 'not-advertised' })])).failures).toEqual(
      [{ code: 'empty-run', detail: 'all not-advertised' }],
    )
    expect(
      judgeReport(
        sampleDraft([
          sampleAssertion({ id: 'skip', qualification: 'advertised', status: 'skipped' }),
          sampleAssertion({ id: 'absent', qualification: 'not-advertised' }),
        ]),
      ).failures,
    ).toEqual([{ code: 'empty-run', detail: 'no executed assertion' }])
  })

  it('merges assertions in order and takes timestamps from the caller', () => {
    const left = judgeReport(
      sampleDraft([sampleAssertion({ id: 'left', contract: 'agh.context' })], {
        contracts: ['agh.context'],
        command: 'left',
      }),
    )
    const right = judgeReport(
      sampleDraft([sampleAssertion({ id: 'right' })], { contracts: ['agh.loop'], command: 'right' }),
    )
    const merged = mergeReports([left, right], {
      command: 'unused',
      startedAt: '2026-10-01T03:00:00.000Z',
      finishedAt: '2026-10-01T03:00:01.000Z',
    })
    expect(merged.status).toBe('passed')
    expect(merged.command).toBe('left\nright')
    expect(merged.startedAt).toBe('2026-10-01T03:00:00.000Z')
    expect(merged.assertions.map((item) => item.id)).toEqual(['left', 'right'])
    expect(merged.contracts).toEqual(['agh.context', 'agh.loop'])
    const mixed = mergeReports(
      [
        left,
        judgeReport(
          sampleDraft([
            sampleAssertion({ build: { ...sampleAssertion().build, buildDigest: 'other-build' } }),
          ]),
        ),
      ],
      { command: 'merge', startedAt: SAMPLE_CLOCK.startedAt, finishedAt: SAMPLE_CLOCK.finishedAt },
    )
    expect(mixed.failures).toContainEqual({
      code: 'mixed-version',
      detail: 'mixed sdkDigest, lockDigest, buildDigest or specVersion',
    })
    const empty = mergeReports([], {
      command: 'merge',
      startedAt: SAMPLE_CLOCK.startedAt,
      finishedAt: SAMPLE_CLOCK.finishedAt,
    })
    expect(empty.failures).toEqual([{ code: 'empty-run', detail: 'zero assertions' }])
  })

  // The selection runs every bound reference case, and some of them kill real provider processes.
  it('writes the serialized report and runs a selection with an injected clock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'conformance-report-'))
    try {
      const report = judgeReport(sampleDraft([sampleAssertion()]))
      const path = join(directory, 'nested', 'conformance.json')
      writeReport(path, report)
      expect(readFileSync(path, 'utf8')).toBe(serializeReport(report))
      const run = await runConformance({
        contracts: 'all',
        providers: ['reference'],
        command: 'conformance',
        clock: SAMPLE_CLOCK,
        reportPath: join(directory, 'all.json'),
      })
      expect(run.report.status).toBe('failed')
      expect(run.report.failures.some((failure) => failure.code === 'empty-run')).toBe(false)
      expect(run.report.failures.some((failure) => failure.code === 'mixed-version')).toBe(false)
      expect(run.report.failures).toContainEqual({
        code: 'missing-evidence',
        detail: 'required agh.loop missing examples/runtime-reference/src/providers/loop.ts',
      })
      expect(run.report.startedAt).toBe(SAMPLE_CLOCK.startedAt)
      const directoryRows = run.report.assertions.filter((row) => row.contract === 'agh.authority-directory')
      expect(directoryRows).toHaveLength(SCENARIOS.length)
      expect(directoryRows.map((row) => row.scenario)).toEqual([...SCENARIOS])
      const unsupported = directoryRows[0]?.build.platform.startsWith('win32-') === true
      expect(directoryRows.every((row) => row.status === (unsupported ? 'skipped' : 'passed'))).toBe(true)
      if (unsupported) {
        for (const row of directoryRows) {
          expect(row.diagnostic).toBe(`incompatible/filesystem_unsupported on ${row.build.platform}`)
          expect(run.report.failures).toContainEqual({
            code: 'missing-evidence',
            detail: `required ${row.contract} ${row.scenario} ${row.id} skipped`,
          })
        }
      }
      const uiRows = run.report.assertions.filter((row) => row.contract === 'agh.ui-registry')
      expect(uiRows).toHaveLength(SCENARIOS.length)
      expect(uiRows.every((row) => row.status === 'passed')).toBe(true)
      const stored = JSON.parse(readFileSync(run.reportPath, 'utf8')) as { startedAt: string; status: string }
      expect(stored).toMatchObject({ startedAt: SAMPLE_CLOCK.startedAt, status: 'failed' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('finishes the full selection when both authority directories refuse the filesystem', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'conformance-unsupported-'))
    try {
      const supported = await runConformance({
        contracts: 'all',
        providers: ['default', 'reference'],
        command: 'natural-filesystem',
        clock: SAMPLE_CLOCK,
        reportPath: join(directory, 'natural.json'),
      })
      const binder = join(directory, 'a-authority-conformance.mjs')
      const authorityUrl = new URL('./platform/authority-directory-conformance.ts', import.meta.url).href
      writeFileSync(
        binder,
        `import { bindAuthorityDirectoryContracts } from ${JSON.stringify(authorityUrl)}\nexport async function bindConformance(harness, request) {\n  await bindAuthorityDirectoryContracts(harness, request.command, request.providers, 'unsupported')\n  return { contracts: ['agh.authority-directory'], providers: request.providers }\n}\n`,
      )
      const run = await runConformance({
        contracts: 'all',
        providers: ['default', 'reference'],
        command: 'unsupported-filesystem',
        clock: SAMPLE_CLOCK,
        reportPath: join(directory, 'all.json'),
        binderFiles: [
          binder,
          ...conformanceBinderFiles().filter((file) => !file.endsWith('authority-directory-conformance.ts')),
        ],
      })
      expect(run.report.status).toBe('failed')
      expect(run.report.failures.some((failure) => failure.code === 'mixed-version')).toBe(false)
      expect(
        run.report.assertions
          .slice(0, SCENARIOS.length * 2)
          .every((row) => row.contract === 'agh.authority-directory'),
      ).toBe(true)
      for (const providerId of ['default', 'reference']) {
        const rows = run.report.assertions.filter(
          (row) => row.contract === 'agh.authority-directory' && row.providerId === providerId,
        )
        expect(rows).toHaveLength(SCENARIOS.length)
        expect(rows.map((row) => row.scenario)).toEqual([...SCENARIOS])
        for (const row of rows) {
          expect(row.status).toBe('skipped')
          expect(row.qualification).toBe('required')
          expect(row.diagnostic).toBe(`incompatible/filesystem_unsupported on ${row.build.platform}`)
          expect(run.report.failures).toContainEqual({
            code: 'missing-evidence',
            detail: `required ${row.contract} ${row.scenario} ${row.id} skipped`,
          })
        }
        for (const contract of ['agh.config', 'agh.ui-registry']) {
          const later = run.report.assertions.filter(
            (row) => row.contract === contract && row.providerId === providerId,
          )
          expect(later).toHaveLength(contract === 'agh.config' ? SCENARIOS.length * 2 : SCENARIOS.length)
          expect(later.every((row) => row.status === 'passed')).toBe(true)
        }
      }
      const otherCases = (report: typeof run.report) =>
        report.assertions
          .filter((row) => row.contract !== 'agh.authority-directory')
          .map((row) => ({
            id: row.id,
            contract: row.contract,
            providerId: row.providerId,
            scenario: row.scenario,
            status: row.status,
          }))
      expect(otherCases(run.report)).toEqual(otherCases(supported.report))
      const stored = JSON.parse(readFileSync(run.reportPath, 'utf8'))
      expect(stored.assertions).toEqual(JSON.parse(serializeReport(run.report)).assertions)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 300_000)

  it.each(['anchor_unreadable', 'denied_filesystem', 'disk error'])(
    'records an authority directory failure without treating it as unsupported: %s',
    async (failure) => {
      const defaultDirectory = await import(
        fileURLToPath(
          new URL('../../../packages/host/src/runtime/providers/authority-directory.ts', import.meta.url),
        )
      )
      const authorityDirectory = await import(
        fileURLToPath(new URL('./platform/authority-directory-conformance.ts', import.meta.url))
      )
      const anchor = vi.spyOn(defaultDirectory, 'createDirectoryAnchor').mockImplementation(() => {
        if (failure === 'disk error') throw new Error(failure)
        return {
          ok: false,
          error: {
            code: failure === 'anchor_unreadable' ? 'incompatible' : 'denied',
            detailCode: failure === 'anchor_unreadable' ? failure : 'filesystem_unsupported',
            message: failure,
            retryAdvice: { kind: 'never' },
            diagnosticId: 'anchor-test',
          },
        }
      })
      try {
        const harness = createConformanceHarness()
        await authorityDirectory.bindAuthorityDirectoryContracts(harness, 'failure', ['default'])
        harness.registerCase({
          contract: 'agh.config',
          scenario: 'normal',
          qualification: 'required',
          providerId: 'default',
          run: () => sampleAssertion({ id: 'later-contract' }),
        })
        const report = await harness.run({
          contracts: ['agh.authority-directory', 'agh.config'],
          providers: ['default'],
          command: 'failure',
          clock: SAMPLE_CLOCK,
        })
        const rows = report.assertions.filter((row) => row.contract === 'agh.authority-directory')
        expect(rows).toHaveLength(SCENARIOS.length)
        expect(rows.map((row) => row.scenario)).toEqual([...SCENARIOS])
        const diagnostic =
          failure === 'disk error'
            ? failure
            : failure === 'anchor_unreadable'
              ? `incompatible/${failure}`
              : 'denied/filesystem_unsupported'
        expect(rows.every((row) => row.status === 'failed' && row.diagnostic === diagnostic)).toBe(true)
        expect(report.status).toBe('failed')
        expect(report.assertions.at(-1)).toMatchObject({ id: 'later-contract', status: 'passed' })
      } finally {
        anchor.mockRestore()
      }
    },
  )

  it('parses the command and returns usage without reading a library clock', async () => {
    expect(parseConformanceArgs(['--contracts', 'all', '--providers', 'reference'])).toEqual({
      contracts: 'all',
      providers: ['reference'],
      reportPath: null,
    })
    expect(
      parseConformanceArgs([
        '--providers',
        'default, reference',
        '--contracts',
        'agh.loop,agh.context',
        '--report',
        'out/conformance.json',
      ]),
    ).toEqual({
      contracts: ['agh.loop', 'agh.context'],
      providers: ['default', 'reference'],
      reportPath: 'out/conformance.json',
    })
    expect(() => parseConformanceArgs(['--contracts', 'all'])).toThrow(/usage:/)
    expect(() => parseConformanceArgs(['--contracts', 'all,agh.loop', '--providers', 'reference'])).toThrow(
      /usage:/,
    )
    expect(() =>
      parseConformanceArgs(['--unknown', 'x', '--contracts', 'all', '--providers', 'reference']),
    ).toThrow(/usage:/)
    const lines: string[] = []
    expect(
      await main(
        ['--contracts', 'all'],
        (line) => lines.push(line),
        (line) => lines.push(line),
      ),
    ).toBe(2)
    expect(lines.join('\n')).toMatch(/usage:/)
    for (const name of ['report.ts', 'fixtures.ts']) {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      expect(source).not.toMatch(/Date\.now|new Date/)
    }
    const runner = readFileSync(new URL('./run-conformance.ts', import.meta.url), 'utf8')
    expect(runner.match(/new Date\(/g)).toEqual(['new Date('])
    expect(runner).not.toMatch(/Date\.now/)
    expect(runner).toMatch(/pathToFileURL/)
  })

  it('shares one build identity across config and package bindings for both providers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'conformance-config-'))
    const clock = {
      startedAt: '2026-10-01T00:00:00.000Z',
      finishedAt: '2026-10-01T00:00:01.000Z',
    } as const
    try {
      for (const providers of [['reference'], ['default', 'reference']] as const) {
        const run = await runConformance({
          contracts: ['agh.config', 'agh.package-source'],
          providers: [...providers],
          command: 'conformance',
          clock,
          reportPath: join(directory, `${providers.join('-')}.json`),
        })
        expect(run.report.status).toBe('passed')
        expect(run.report.failures).toEqual([])
        expect(run.report.assertions.length).toBeGreaterThan(0)
        expect(new Set(run.report.assertions.map((row) => JSON.stringify(row.build))).size).toBe(1)
        for (const providerId of providers) {
          const rows = run.report.assertions.filter(
            (item) => item.contract === 'agh.config' && item.providerId === providerId,
          )
          expect(rows.length).toBe(SCENARIOS.length * 2)
          expect(new Set(rows.map((item) => item.scenario))).toEqual(new Set(SCENARIOS))
          expect(rows.every((item) => item.status === 'passed')).toBe(true)
          expect(rows.every((item) => item.perImplementation === true && item.gate === null)).toBe(true)
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('loads conformance modules in sorted path order', async () => {
    const root = dirname(fileURLToPath(new URL('./run-conformance.ts', import.meta.url)))
    const rels = conformanceBinderFiles().map((file) => relative(root, file).split(sep).join('/'))
    const sorted = [...rels].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    expect(rels).toEqual(sorted)
    expect(rels).toContain('platform/config-conformance.ts')
    expect(rels).toContain('platform/packages-conformance.ts')
    expect(rels).toContain('sample-conformance.ts')
    expect(rels).not.toContain('run-conformance.ts')
    expect(rels.some((file) => file.endsWith('.test.ts'))).toBe(false)
    const directory = mkdtempSync(join(tmpdir(), 'conformance-order-'))
    const log = join(directory, 'order.txt')
    const later = join(directory, 'b-bind.mjs')
    const earlier = join(directory, 'a-bind.mjs')
    const source = [
      "import { appendFileSync } from 'node:fs'",
      'export async function bindConformance() {',
      "  appendFileSync(process.env.CONFORMANCE_BIND_LOG, import.meta.filename + '\\n')",
      '  return { contracts: [], providers: [] }',
      '}',
      '',
    ].join('\n')
    writeFileSync(later, source)
    writeFileSync(earlier, source)
    process.env.CONFORMANCE_BIND_LOG = log
    try {
      await runConformance({
        contracts: ['agh.loop'],
        providers: ['default'],
        command: 'order',
        clock: SAMPLE_CLOCK,
        reportPath: join(directory, 'report.json'),
        binderFiles: [later, earlier],
      })
      const names = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((file) => file.split(/[/\\]/).at(-1))
      expect(names).toEqual(['a-bind.mjs', 'b-bind.mjs'])
    } finally {
      delete process.env.CONFORMANCE_BIND_LOG
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails the run when a conformance module does not load', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'conformance-load-'))
    const file = join(directory, 'broken-bind.mjs')
    writeFileSync(file, "throw new Error('explode')\n")
    try {
      await expect(
        runConformance({
          contracts: ['agh.loop'],
          providers: ['default'],
          command: 'load',
          clock: SAMPLE_CLOCK,
          reportPath: join(directory, 'report.json'),
          binderFiles: [file],
        }),
      ).rejects.toThrow(/conformance module failed to load:.*broken-bind\.mjs:.*explode/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails the run when two modules claim one contract', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'conformance-claim-'))
    const claim = [
      'export async function bindConformance() {',
      "  return { contracts: ['agh.shared-claim'], providers: ['default'] }",
      '}',
      '',
    ].join('\n')
    const first = join(directory, 'a-claim.mjs')
    const second = join(directory, 'b-claim.mjs')
    writeFileSync(first, claim)
    writeFileSync(second, claim)
    try {
      await expect(
        runConformance({
          contracts: ['agh.loop'],
          providers: ['default'],
          command: 'claim',
          clock: SAMPLE_CLOCK,
          reportPath: join(directory, 'report.json'),
          binderFiles: [second, first],
        }),
      ).rejects.toThrow(
        /conformance contract claimed by more than one module: agh\.shared-claim: .*a-claim\.mjs, .*b-claim\.mjs/,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
