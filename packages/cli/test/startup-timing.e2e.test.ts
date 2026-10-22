import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const launcher = resolve(import.meta.dirname, '../bin/agh')
const built = existsSync(resolve(import.meta.dirname, '../dist/local/agnes.mjs'))

function run(timing: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'agh-timing-'))
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, AGH_HOME: home }
    if (timing) env.AGH_TIMING = '1'
    else delete env.AGH_TIMING
    return spawnSync(process.execPath, [launcher, '--version'], { env, encoding: 'utf8' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

it.skipIf(!built)(
  'marks launcher, bootstrap and main-loaded in order on stderr only, and only when asked',
  () => {
    const plain = run(false)
    const timed = run(true)
    expect(plain.stderr).toBe('')
    expect(timed.stdout).toBe(plain.stdout)
    const marks = [...timed.stderr.matchAll(/^agh-timing (\S+) (\d+\.\d)$/gm)]
    expect(marks.map((m) => m[1])).toEqual(['launcher', 'bootstrap', 'main-loaded'])
    const times = marks.map((m) => Number(m[2]))
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  },
)
