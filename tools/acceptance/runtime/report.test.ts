import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { judgeReport as judgeFromKit, SCENARIOS } from '../../../packages/extension-api/testkit/index.js'
import { SAMPLE_CLOCK, sampleAssertion, sampleDraft } from './fixtures.js'
import { judgeReport, mergeReports, serializeReport, writeReport } from './report.js'
import { conformanceBinderFiles, main, parseConformanceArgs, runConformance } from './run-conformance.js'

describe('conformance report entry', () => {
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
      expect(run.report.failures).toContainEqual({
        code: 'missing-evidence',
        detail: 'required agh.loop missing examples/runtime-reference/src/providers/loop.ts',
      })
      expect(run.report.startedAt).toBe(SAMPLE_CLOCK.startedAt)
      const stored = JSON.parse(readFileSync(run.reportPath, 'utf8')) as { startedAt: string; status: string }
      expect(stored).toMatchObject({ startedAt: SAMPLE_CLOCK.startedAt, status: 'failed' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)

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

  it('passes the config contract for the default provider and the reference provider', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'conformance-config-'))
    const clock = {
      startedAt: '2026-10-01T00:00:00.000Z',
      finishedAt: '2026-10-01T00:00:01.000Z',
    } as const
    try {
      for (const providers of [['reference'], ['default', 'reference']] as const) {
        const run = await runConformance({
          contracts: ['agh.config'],
          providers: [...providers],
          command: 'conformance',
          clock,
          reportPath: join(directory, `${providers.join('-')}.json`),
        })
        expect(run.report.status).toBe('passed')
        expect(run.report.failures).toEqual([])
        expect(run.report.assertions.length).toBeGreaterThan(0)
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
