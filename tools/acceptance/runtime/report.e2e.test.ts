import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SCENARIOS } from '../../../packages/extension-api/testkit/index.js'
import { filesystemSupportsLocalRename } from '../../../packages/host/src/runtime/maintenance/bootstrap-locator.js'
import { getConformanceBuildIdentity } from './build-identity.js'
import { SAMPLE_CLOCK } from './fixtures.js'
import { serializeReport } from './report.js'
import { conformanceBinderFiles, runConformance } from './run-conformance.js'

// Every selection runs real recover processes. Keep the full catalog in the heavy tier,
// partitioned by provider so a slow implementation cannot consume the other's deadline.
async function measuredSelection(directory: string, options: Parameters<typeof runConformance>[0]) {
  const files = options.binderFiles ?? conformanceBinderFiles()
  const wrappers = files.map((file, index) => {
    const wrapper = join(directory, `${options.command}-measured-${index.toString().padStart(3, '0')}.mjs`)
    writeFileSync(
      wrapper,
      `
import { bindConformance as bind } from ${JSON.stringify(pathToFileURL(file).href)}
export async function bindConformance(harness, request) {
  return bind({ ...harness, registerCase(row) {
    harness.registerCase({ ...row, async run(input) {
      const start = performance.now()
      try { return await row.run(input) }
      finally { console.info(JSON.stringify({
        selection: request.command, contract: row.contract, provider: row.providerId,
        scenario: row.scenario, elapsedMs: performance.now() - start
      })) }
    } })
  } }, request)
}
`,
    )
    return wrapper
  })
  const start = performance.now()
  try {
    return await runConformance({ ...options, binderFiles: wrappers })
  } finally {
    console.info(JSON.stringify({ selection: options.command, elapsedMs: performance.now() - start }))
  }
}

describe('full conformance report selection', () => {
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
  it.each(['default', 'reference'])(
    'finishes the full %s selection when the authority directory refuses the filesystem',
    async (providerId) => {
      const directory = mkdtempSync(join(tmpdir(), 'conformance-unsupported-'))
      try {
        const supported = await measuredSelection(directory, {
          contracts: 'all',
          providers: [providerId],
          command: 'natural-filesystem',
          clock: SAMPLE_CLOCK,
          reportPath: join(directory, 'natural.json'),
        })
        const directoryRows = supported.report.assertions.filter(
          (row) => row.contract === 'agh.authority-directory',
        )
        expect(directoryRows).toHaveLength(SCENARIOS.length)
        expect(directoryRows.map((row) => row.scenario)).toEqual([...SCENARIOS])
        // Probe the temporary volume independently of the reported statuses: local
        // writable NTFS/ReFS must execute every scenario rather than silently skip.
        const unsupported = !filesystemSupportsLocalRename(directory)
        expect(directoryRows.every((row) => row.status === (unsupported ? 'skipped' : 'passed'))).toBe(true)
        if (unsupported) {
          for (const row of directoryRows) {
            expect(row.diagnostic).toBe(`incompatible/filesystem_unsupported on ${row.build.platform}`)
            expect(supported.report.failures).toContainEqual({
              code: 'missing-evidence',
              detail: `required ${row.contract} ${row.scenario} ${row.id} skipped`,
            })
          }
        }
        const uiRows = supported.report.assertions.filter((row) => row.contract === 'agh.ui-registry')
        expect(uiRows).toHaveLength(SCENARIOS.length)
        expect(uiRows.every((row) => row.status === 'passed')).toBe(true)
        const binder = join(directory, 'a-authority-conformance.mjs')
        const authorityUrl = new URL('./platform/authority-directory-conformance.ts', import.meta.url).href
        writeFileSync(
          binder,
          `import { bindAuthorityDirectoryContracts } from ${JSON.stringify(authorityUrl)}\nexport async function bindConformance(harness, request) {\n  await bindAuthorityDirectoryContracts(harness, request.command, request.providers, 'unsupported')\n  return { contracts: ['agh.authority-directory'], providers: request.providers }\n}\n`,
        )
        const run = await measuredSelection(directory, {
          contracts: 'all',
          providers: [providerId],
          command: 'unsupported-filesystem',
          clock: SAMPLE_CLOCK,
          reportPath: join(directory, 'all.json'),
          binderFiles: [
            binder,
            ...conformanceBinderFiles().filter(
              (file) => !file.endsWith('authority-directory-conformance.ts'),
            ),
          ],
        })
        expect(run.report.status).toBe('failed')
        expect(
          new Set(
            [...supported.report.assertions, ...run.report.assertions].map((row) =>
              JSON.stringify(row.build),
            ),
          ),
        ).toEqual(new Set([JSON.stringify(getConformanceBuildIdentity())]))
        expect(run.report.failures.some((failure) => failure.code === 'mixed-version')).toBe(false)
        expect(
          run.report.assertions
            .slice(0, SCENARIOS.length)
            .every((row) => row.contract === 'agh.authority-directory'),
        ).toBe(true)
        {
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
        expect(stored.startedAt).toBe(SAMPLE_CLOCK.startedAt)
        expect(stored.assertions).toEqual(JSON.parse(serializeReport(run.report)).assertions)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    300_000,
  )
})
