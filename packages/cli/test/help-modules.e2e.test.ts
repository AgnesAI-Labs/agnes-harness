import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const dist = resolve(import.meta.dirname, '../dist/local')
const built = existsSync(join(dist, 'agnes-main.mjs'))

// esbuild wraps every bundled module in `__esm`, which runs its top level the first time the module
// is needed. The patched copy reports each module as it runs, so this sees what `--help` evaluates.
const WRAPPER = 'return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;'
const REPORTING_WRAPPER =
  'if (fn) { const name = __getOwnPropNames(fn)[0]; res = (0, fn[name])(fn = 0); process.stderr.write(`agh-module-init ${name}\\n`) } return res;'

function initialisedModules(...argv: string[]): string[] {
  const source = readFileSync(join(dist, 'agnes-main.mjs'), 'utf8')
  expect(source).toContain(WRAPPER)
  const copy = join(dist, `agnes-main.modules-${process.pid}.mjs`)
  const home = mkdtempSync(join(tmpdir(), 'agh-help-modules-'))
  try {
    writeFileSync(copy, source.replace(WRAPPER, REPORTING_WRAPPER))
    const run = spawnSync(process.execPath, [copy, ...argv], {
      env: { ...process.env, AGH_HOME: home },
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    return run.stderr
      .split('\n')
      .filter((line) => line.startsWith('agh-module-init '))
      .map((line) => line.slice('agh-module-init '.length))
  } finally {
    rmSync(copy, { force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

it.skipIf(!built)(
  '--help evaluates neither the SDK, the Host, nor the protocol schemas and validators',
  () => {
    const modules = initialisedModules('--help')
    // The probe sees the modules that do run, so an empty list would mean it saw nothing at all.
    expect(modules).toContain('src/args.ts')
    const heavy = modules.filter((name) =>
      /(^|\/)(sdk|host|daemon|protocol-validation)\/src\/|protocol\/gen\/|protocol\/src\/index\.ts|typebox|\/ajv\//.test(
        name,
      ),
    )
    expect(heavy).toEqual([])
  },
)
