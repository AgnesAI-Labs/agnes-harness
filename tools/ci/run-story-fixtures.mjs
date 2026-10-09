import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { verifyStoryResult } from './story-results.mjs'

// Select maintained contract tests rather than duplicating them in a second story suite.
const fixtures = JSON.parse(readFileSync(new URL('./story-fixtures.json', import.meta.url)))
const output = resolve(process.env.AGH_STORY_TEST_OUTPUT ?? '.agnes-tmp/story-fixtures')
mkdirSync(output, { recursive: true })
for (const fixture of fixtures) {
  const report = resolve(output, `${fixture.id}.json`)
  rmSync(report, { force: true })
  console.log(`Story: ${fixture.id}; highlights ${fixture.highlights.join(', ')}`)
  const run = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    [
      'exec',
      'vitest',
      'run',
      fixture.file,
      '--testNamePattern',
      fixture.testNamePattern,
      '--maxWorkers=1',
      '--retry=0',
      '--reporter=default',
      '--reporter=json',
      '--reporter=./tools/guards/src/zero-test-reporter.mjs',
      `--outputFile.json=${report}`,
    ],
    { stdio: 'inherit' },
  )
  if (run.error) throw run.error
  if (run.status !== 0) process.exit(run.status ?? 1)
  const count = verifyStoryResult(JSON.parse(readFileSync(report, 'utf8')), fixture.testNamePattern)
  console.log(`${fixture.id}: ${count} passed; no retries or selected skips.`)
}
