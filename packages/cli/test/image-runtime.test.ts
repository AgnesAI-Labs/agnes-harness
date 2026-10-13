import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  copyImageRuntime,
  hostImageCodecPackage,
  IMAGE_RUNTIME_ROOTS,
  isInsideDirectory,
  probeImageRuntime,
} from '../tools/image-runtime.js'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agh-image-runtime-'))
  made.push(dir)
  return dir
}

function writePackage(directory: string, manifest: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
}

describe('copyImageRuntime', () => {
  // The native codec is loaded only in child processes, so Windows can delete the copy afterwards.
  it('copies sharp with this host codec so a bundled worker beside it can load it', async () => {
    const out = temporary()
    await copyImageRuntime(out)
    const modules = join(out, 'node_modules')
    expect(readdirSync(modules).sort()).toEqual([...IMAGE_RUNTIME_ROOTS].sort())
    expect(existsSync(join(modules, 'sharp', 'package.json'))).toBe(true)
    expect(existsSync(join(modules, hostImageCodecPackage(), 'package.json'))).toBe(true)
    // A relative directory is resolved before it reaches createRequire in the child.
    const probe = probeImageRuntime(relative(process.cwd(), out))
    expect(probe.width).toBe(4)
    expect(relative(realpathSync(out), probe.resolved)).toBe(join('node_modules', 'sharp', 'lib', 'index.js'))
  }, 60_000)

  it('reports a failed probe with the child error, not the probe script', () => {
    const empty = temporary()
    let message = ''
    try {
      probeImageRuntime(empty)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/^Image runtime probe failed for /)
    expect(message).toContain("Cannot find module 'sharp'")
    expect(message).not.toContain('createRequire')
  })

  it('refuses a source tree where the platform codec was not installed', async () => {
    const source = temporary()
    writePackage(source, { name: 'fixture' })
    writePackage(join(source, 'node_modules', 'sharp'), {
      name: 'sharp',
      version: '0.34.5',
      optionalDependencies: { [hostImageCodecPackage()]: '0.34.5' },
    })
    await expect(copyImageRuntime(temporary(), source)).rejects.toThrow(
      `Image runtime codec ${hostImageCodecPackage()} is not installed`,
    )
  })

  it('refuses a dependency the single-executable build would not copy', async () => {
    const source = temporary()
    writePackage(source, { name: 'fixture' })
    writePackage(join(source, 'node_modules', 'sharp'), {
      name: 'sharp',
      version: '0.34.5',
      dependencies: { 'left-pad': '1.3.0' },
    })
    writePackage(join(source, 'node_modules', 'left-pad'), { name: 'left-pad', version: '1.3.0' })
    await expect(copyImageRuntime(temporary(), source)).rejects.toThrow(
      'Image runtime package left-pad is outside IMAGE_RUNTIME_ROOTS',
    )
  })
})

describe('isInsideDirectory', () => {
  // Windows: the native realpath expands 8.3 short names; the loader's JavaScript realpath keeps them.
  const expand = (path: string): string => path.replace('/RUNNER~1/', '/runneradmin/')
  const loaded = '/work/RUNNER~1/Temp/out/node_modules/sharp/lib/index.js'

  it('canonicalises both sides with the same realpath', () => {
    expect(isInsideDirectory('/work/RUNNER~1/Temp/out', loaded, expand)).toBe(true)
    expect(isInsideDirectory('/work/runneradmin/Temp/out', loaded, expand)).toBe(true)
  })

  it('rejects paths outside or equal to the directory', () => {
    expect(isInsideDirectory('/work/RUNNER~1/Temp/other', loaded, expand)).toBe(false)
    expect(isInsideDirectory('/work/RUNNER~1/Temp/out', '/work/RUNNER~1/Temp/out', expand)).toBe(false)
  })
})

describe('distribution wiring', () => {
  const cli = fileURLToPath(new URL('../', import.meta.url))
  const source = (path: string): string => readFileSync(join(cli, path), 'utf8')

  it('the local build copies the image runtime after the system runtime', () => {
    const build = source('tools/build-local.ts')
    const body = build.slice(build.indexOf('async function buildLocal('))
    expect(body).toMatch(
      /await copySystemRuntime\([^)]*\)\s*\n(?:\s*\/\/[^\n]*\n)*\s*await copyImageRuntime\(out\)/,
    )
  })

  it('the single-executable build copies exactly the image runtime roots from the local build', () => {
    const build = source('sea/build.mjs')
    expect(build).toContain("import { IMAGE_RUNTIME_ROOTS } from '../tools/image-runtime-roots.mjs'")
    expect(build).toMatch(
      /for \(const name of IMAGE_RUNTIME_ROOTS\)\s*cpSync\(join\(local, 'node_modules', name\), join\(out, 'node_modules', name\)/,
    )
  })
})
