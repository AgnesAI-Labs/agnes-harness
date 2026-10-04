import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AssertionRecord,
  discoverContracts,
  PROVIDER_ABSENT,
  SCENARIOS,
} from '../../../packages/extension-api/testkit/index.js'
import { filesystemSupportsLocalRename } from '../../../packages/host/src/runtime/maintenance/bootstrap-locator.js'
import { getConformanceBuildIdentity } from './build-identity.js'
import { SAMPLE_CLOCK } from './fixtures.js'
import { serializeReport } from './report.js'
import { conformanceBinderFiles, runConformance } from './run-conformance.js'

// Every selection runs real recover processes. Keep the full catalog in the heavy tier,
// partitioned by contract and provider; replay only measured records to judge the full catalog.
async function measuredSelection(
  directory: string,
  options: Parameters<typeof runConformance>[0],
  assemblyPart: 'all' | 'plan' | 'prepare' | 'publish' | 'admission' = 'all',
) {
  const files = options.binderFiles ?? conformanceBinderFiles()
  const wrappers = files.map((file, index) => {
    const wrapper = join(
      directory,
      `${options.command}-${assemblyPart}-measured-${index.toString().padStart(3, '0')}.mjs`,
    )
    if (!existsSync(wrapper))
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
  } }, request${file.endsWith('assembly-conformance.ts') ? `, ${JSON.stringify(assemblyPart)}` : ''})
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

  const contracts = [
    'agh.authority-directory',
    ...discoverContracts()
      .map((row) => row.contract)
      .filter((name) => name !== 'agh.authority-directory'),
  ]
  const partitions = contracts.flatMap<{
    contract: string
    part: 'all' | 'plan' | 'prepare' | 'publish' | 'admission'
    key: string
  }>((contract) =>
    contract === 'agh.assembly'
      ? (['plan', 'prepare', 'publish', 'admission'] as const).map((part) => ({
          contract,
          part,
          key: `${contract}-${part}`,
        }))
      : [{ contract, part: 'all' as const, key: contract }],
  )
  describe.each(['default', 'reference'])('provider %s', (providerId) => {
    let directory: string
    let binder: string
    const natural = new Map<string, readonly AssertionRecord[]>()
    const refused = new Map<string, readonly AssertionRecord[]>()
    beforeAll(() => {
      directory = mkdtempSync(join(tmpdir(), 'conformance-partitions-'))
      binder = join(directory, 'a-authority-conformance.mjs')
      const authorityUrl = new URL('./platform/authority-directory-conformance.ts', import.meta.url).href
      writeFileSync(
        binder,
        `import { bindAuthorityDirectoryContracts } from ${JSON.stringify(authorityUrl)}
export async function bindConformance(harness, request) {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.authority-directory'))
    return { contracts: [], providers: [] }
  await bindAuthorityDirectoryContracts(harness, request.command, request.providers, 'unsupported')
  return { contracts: ['agh.authority-directory'], providers: request.providers }
}
`,
      )
    })
    it.each(
      partitions.flatMap((partition) =>
        (['natural-filesystem', 'unsupported-filesystem'] as const).map((command) => ({
          ...partition,
          command,
        })),
      ),
    )(
      'finishes $key for $command',
      async ({ contract, part, key, command }) => {
        const run = await measuredSelection(
          directory,
          {
            contracts: [contract],
            providers: [providerId],
            clock: SAMPLE_CLOCK,
            command,
            reportPath: join(directory, `${key}-${command}.json`),
            ...(command === 'unsupported-filesystem'
              ? {
                  binderFiles: [
                    binder,
                    ...conformanceBinderFiles().filter(
                      (file) => !file.endsWith('authority-directory-conformance.ts'),
                    ),
                  ],
                }
              : {}),
          },
          part,
        )
        const records = command === 'natural-filesystem' ? natural : refused
        records.set(key, run.report.assertions)
        expect(run.report.assertions.length).toBeGreaterThan(0)
      },
      300_000,
    )

    // Full selection and catalog gates still go through the original runner. The
    // replay binder cannot manufacture evidence: it returns only completed partitions.
    afterAll(async () => {
      try {
        expect([...natural.keys()].sort()).toEqual(partitions.map(({ key }) => key).sort())
        expect([...refused.keys()].sort()).toEqual(partitions.map(({ key }) => key).sort())
        const cases = (rows: readonly AssertionRecord[]) =>
          rows.map((row) => ({
            id: row.id,
            contract: row.contract,
            providerId: row.providerId,
            scenario: row.scenario,
            status: row.status,
          }))
        for (const { contract, key } of partitions)
          if (contract !== 'agh.authority-directory')
            expect(cases(refused.get(key) ?? [])).toEqual(cases(natural.get(key) ?? []))
        const replay = async (rows: Map<string, readonly AssertionRecord[]>, command: string) => {
          const source = join(directory, `${command}-records.json`)
          writeFileSync(
            source,
            JSON.stringify(
              partitions
                .flatMap(({ key }) => rows.get(key) ?? [])
                .filter(
                  (row) =>
                    // Recreate only synthetic missing-binding rows in the full runner, so
                    // their build is inherited from the full selection as before partitioning.
                    row.providerDigest !== PROVIDER_ABSENT || row.consumer !== 'unregistered',
                ),
            ),
          )
          const file = join(directory, `${command}-replay.mjs`)
          writeFileSync(
            file,
            `import { readFileSync } from 'node:fs'
const rows = JSON.parse(readFileSync(${JSON.stringify(source)}, 'utf8'))
export async function bindConformance(harness, request) {
  for (const row of rows) harness.registerCase({ ...row, async run() {
    return { ...row, command: request.command }
  } })
  return { contracts: ${JSON.stringify(contracts)}, providers: request.providers }
}
`,
          )
          return runConformance({
            contracts: 'all',
            providers: [providerId],
            command,
            clock: SAMPLE_CLOCK,
            reportPath: join(directory, `${command}-all.json`),
            binderFiles: [file],
          })
        }
        const supported = await replay(natural, 'natural-filesystem')
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

        const run = await replay(refused, 'unsupported-filesystem')
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
        if (directory) rmSync(directory, { recursive: true, force: true })
      }
    })
  })
})
