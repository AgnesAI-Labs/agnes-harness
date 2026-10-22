import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { main } from '../src/bin.js'

const VERSION = '9.8.7-test'
let dir: string
let bootstrap: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agh-bootstrap-version-'))
  // The main bundle is replaced by a file that records its own load and then throws.
  writeFileSync(
    join(dir, 'agnes-main.mjs'),
    "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./loaded', import.meta.url), ''); throw new Error('main bundle must not load')\n",
  )
  bootstrap = join(dir, 'agnes.mjs')
  await build({
    entryPoints: [join(import.meta.dirname, '../launch/bootstrap.ts')],
    outfile: bootstrap,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    define: {
      AGNES_BOOTSTRAP_MAIN: JSON.stringify('./agnes-main.mjs'),
      AGNES_BOOTSTRAP_HOME_DIR: JSON.stringify('.agh'),
      AGNES_BOOTSTRAP_VERSION: JSON.stringify(VERSION),
    },
  })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function runBootstrap(...argv: string[]) {
  rmSync(join(dir, 'loaded'), { force: true })
  const result = spawnSync(process.execPath, [bootstrap, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, AGH_HOME: join(dir, 'home') },
  })
  return { ...result, loaded: existsSync(join(dir, 'loaded')) }
}

async function entryLine(flag: string): Promise<string> {
  let out = ''
  const code = await main([flag], {
    env: { AGH_HOME: join(dir, 'home') },
    stdin: process.stdin,
    stdout: {
      write: (text: string) => {
        out += text
        return true
      },
    } as unknown as NodeJS.WritableStream,
    stderr: process.stderr,
    cwd: dir,
    agnesVersion: VERSION,
  })
  expect(code).toBe(0)
  return out
}

it.each(['--version', '-v'])(
  'answers %s from the bootstrap with the line the entry prints, never loading the bundle',
  async (flag) => {
    const fromBootstrap = runBootstrap(flag)
    expect(fromBootstrap.status).toBe(0)
    expect(fromBootstrap.loaded).toBe(false)
    expect(fromBootstrap.stderr).toBe('')
    expect(fromBootstrap.stdout).toBe(await entryLine(flag))
    expect(fromBootstrap.stdout).toBe(`agh ${VERSION} node ${process.versions.node} protocol _agnes/v1\n`)
  },
)

it('still loads the main bundle for every other argv, --version among other arguments included', () => {
  for (const argv of [['--help'], ['sessions', '--version'], ['--version', '--json'], []]) {
    const result = runBootstrap(...argv)
    expect(result.loaded, argv.join(' ')).toBe(true)
    expect(result.status, argv.join(' ')).not.toBe(0)
  }
  expect(readFileSync(bootstrap, 'utf8')).toContain(VERSION)
})
