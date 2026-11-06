import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { heavyShard } from './run-heavy-shard.mjs'

const browsers = [
  'packages/web/test/multi-tab-transport.e2e.test.ts',
  'tools/e2e-web/agent-sweep.e2e.test.ts',
]
const { lists } = JSON.parse(readFileSync(new URL('./heavy-shards.json', import.meta.url), 'utf8')) as {
  lists: string[][]
}
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

it('selects every current and future heavy file once across six shards, with browser and registry ownership on six', () => {
  expect(lists).toHaveLength(5)
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => /\.(?:e2e|slow)\.test\.(?:ts|tsx|jsx)$/.test(path))
  const future = 'packages/example/future.e2e.test.ts'
  const shards = [1, 2, 3, 4, 5, 6].map((index) => heavyShard(`${index}/6`, lists))
  const ordinary = [1, 2, 3, 4, 5, 6].map((index) => heavyShard(`${index}/6`, lists, undefined, true))
  const ownersOf = (selections: typeof shards, file: string) =>
    selections.flatMap((shard, index) =>
      (shard.files ? shard.files.includes(file) : !shard.exclude?.includes(file)) ? [index + 1] : [],
    )
  for (const file of [...new Set([...files, future])]) {
    const owners = ownersOf(shards, file)
    expect(owners, file).toHaveLength(1)
    expect(ownersOf(ordinary, file), file).toEqual(browsers.includes(file) ? [] : owners)
    if (
      browsers.includes(file) ||
      file === 'packages/host-infrastructure/test/refinement-registry-processes.e2e.test.ts'
    )
      expect(owners, file).toEqual([6])
  }
})

it('excludes only browser files when requested while preserving local full selections and future complements', () => {
  const sample = [[browsers[0] as string, 'a.e2e.test.ts']]
  expect(heavyShard('1/2', sample, () => true)).toEqual({ files: [browsers[0], 'a.e2e.test.ts'] })
  expect(heavyShard('1/2', sample, () => true, true)).toEqual({ files: ['a.e2e.test.ts'] })
  const last = heavyShard('2/2', sample, () => true, true)
  expect(last.exclude).toContain(browsers[0])
  expect(last.exclude).toContain(browsers[1])
  expect(last.exclude).toContain('a.e2e.test.ts')
  expect(last.exclude).not.toContain('future.slow.test.ts')
})

it('refuses an explicitly selected shard that becomes empty instead of accidentally running all heavy files', () => {
  expect(() => heavyShard('1/2', [[browsers[0] as string]], () => true, true)).toThrow(/empty/)
})

it('consumes --without-browser before invoking Vitest and keeps platform holdouts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agh-heavy-cli-'))
  directories.push(directory)
  writeFileSync(
    join(directory, 'probe.cjs'),
    'console.log(JSON.stringify({args:process.argv.slice(2),exclude:process.env.AGNES_TEST_EXCLUDE}))\n',
  )
  const windows = process.platform === 'win32'
  const executable = join(directory, windows ? 'pnpm.cmd' : 'pnpm')
  writeFileSync(
    executable,
    windows
      ? `@"${process.execPath}" "%~dp0probe.cjs" %*\r\n`
      : '#!/usr/bin/env node\nimport("./probe.cjs")\n',
  )
  chmodSync(executable, 0o755)
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./run-heavy-shard.mjs', import.meta.url)),
      '--shard=6/6',
      '--without-browser',
      '--maxWorkers=1',
    ],
    {
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')),
        PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
        AGNES_TEST_EXCLUDE: 'platform-held.e2e.test.ts',
      },
    },
  )
  expect(result.status, result.stderr).toBe(0)
  const invoked = JSON.parse(result.stdout)
  expect(invoked.args).toEqual(['exec', 'vitest', 'run', '--project', 'heavy', '--maxWorkers=1'])
  expect(invoked.exclude.split(',')).toEqual(
    expect.arrayContaining([...browsers, 'platform-held.e2e.test.ts']),
  )
})
