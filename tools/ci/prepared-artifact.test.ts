import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const helper = fileURLToPath(new URL('./prepared-artifact.mjs', import.meta.url))
const cache = fileURLToPath(new URL('../e2e-web/build-cache.mjs', import.meta.url))
type Manifest = Record<string, unknown> & { files: Array<{ path: string; mode: number }> }
const directories: string[] = []
function fixtureEnvironment(overrides: NodeJS.ProcessEnv, inherited: NodeJS.ProcessEnv = process.env) {
  const names = new Set(Object.keys(overrides).map((key) => key.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !names.has(key.toLowerCase()))),
    ...overrides,
  }
}
const environment = fixtureEnvironment({
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '1',
  ImageOS: 'fixture-os',
  ImageVersion: 'fixture-image',
})
function temporary() {
  const path = mkdtempSync(join(tmpdir(), 'agh-prepared-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
function fixture() {
  const cwd = temporary()
  const artifact = join(temporary(), 'artifact')
  const write = (path: string, value: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), value)
  }
  const git = (...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' })
  git('-c', 'init.templateDir=', 'init', '--initial-branch=main')
  git('config', 'user.name', 'CI fixture')
  git('config', 'user.email', 'ci@example.invalid')
  write('.gitignore', 'dist/\noutputs/\n*.tsbuildinfo\n')
  write('package.json', '{"packageManager":"pnpm@10.34.5"}')
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n')
  write('tsconfig.json', '{"files":[],"references":[{"path":"packages/example"}]}')
  write(
    'packages/example/tsconfig.json',
    '{"compilerOptions":{"rootDir":"src","outDir":"dist","declaration":true,"composite":true},"include":["src/*.ts"]}',
  )
  write('packages/example/src/index.ts', 'export const value = 1\n')
  write(
    'tools/e2e-web/tsconfig.json',
    '{"compilerOptions":{"rootDir":".","outDir":"../../outputs/e2e-types","declaration":true,"composite":true},"include":["browser.ts"]}',
  )
  write('tools/e2e-web/browser.ts', 'export const browser = true\n')
  git('add', '.')
  expect(git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture').status).toBe(0)
  const generated = [
    'packages/example/dist/index.js',
    'packages/example/dist/index.d.ts',
    'packages/example/tsconfig.tsbuildinfo',
    'outputs/e2e-types/browser.js',
    'outputs/e2e-types/browser.d.ts',
    'outputs/e2e-types/tsconfig.tsbuildinfo',
  ]
  for (const path of generated) write(path, `generated ${path}\n`)
  const native = [
    'packages/system-node/dist/native/agnes-system.node',
    ...(['darwin', 'linux'].includes(process.platform)
      ? ['packages/host-infrastructure/dist/native/pty-relay']
      : []),
    ...(process.platform === 'darwin'
      ? [
          'packages/host-infrastructure/dist/native/macos-process-identity',
          'packages/host-computer-use/dist/native/macos-live-app-identity',
        ]
      : []),
  ]
  for (const path of native) {
    write(path, 'native fixture\n')
    chmodSync(join(cwd, path), 0o755)
  }
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [helper, ...args], {
      cwd,
      env: fixtureEnvironment(overrides, environment),
      encoding: 'utf8',
    })
  const manifest = () => JSON.parse(readFileSync(join(artifact, 'manifest.json'), 'utf8')) as Manifest
  const rewrite = (change: (value: Manifest) => void) => {
    const value = manifest()
    change(value)
    writeFileSync(join(artifact, 'manifest.json'), JSON.stringify(value))
  }
  const local = () => {
    const paths = [
      'agnes.mjs',
      'agnes-main.mjs',
      'daemon.mjs',
      'daemon-main.mjs',
      'worker.mjs',
      'worker-main.mjs',
      'web/index.html',
      'node_modules/example/index.js',
      'node_modules/@agnes/system-node/dist/native/agnes-system.node',
      process.platform === 'win32' ? 'ripgrep/rg.exe' : 'ripgrep/rg',
      ...native.filter((path) => !path.endsWith('.node')).map((path) => `native/${path.split('/').at(-1)}`),
    ]
    for (const path of paths) {
      write(`packages/cli/dist/local/${path}`, 'local fixture\n')
      chmodSync(
        join(cwd, 'packages/cli/dist/local', path),
        path.startsWith('native/') || path.startsWith('ripgrep/') ? 0o755 : 0o644,
      )
    }
    const hash = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {sourceHash} from ${JSON.stringify(pathToFileURL(cache).href)}; console.log(await sourceHash())`,
      ],
      { cwd, encoding: 'utf8' },
    )
    expect(hash.status, hash.stderr).toBe(0)
    write(
      'packages/cli/dist/local/.e2e-build.json',
      JSON.stringify({
        hash: hash.stdout.trim(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      }),
    )
  }
  return { cwd, artifact, write, run, generated, native, manifest, rewrite, local }
}
function success(result: ReturnType<typeof spawnSync>) {
  expect(result.stderr?.toString()).toBe('')
  expect(result.status).toBe(0)
}

describe('prepared CI artifacts', () => {
  it('roundtrips all compiler outputs without CLI distribution, source native helpers or workspace files', () => {
    const f = fixture()
    f.write('packages/cli/dist/local/secret.txt', 'not a type output')
    f.write('packages/example/dist/test-workspace/private.json', 'not emitted')
    success(f.run(['pack', 'types', f.artifact]))
    expect(
      f
        .manifest()
        .files.map((file: { path: string }) => file.path)
        .sort(),
    ).toEqual(f.generated.sort())
    for (const path of f.generated) rmSync(join(f.cwd, path))
    success(f.run(['restore', f.artifact]))
    expect(readFileSync(join(f.cwd, 'packages/example/dist/index.d.ts'), 'utf8')).toContain('generated')
  })

  it('includes JSON compiler outputs selected by resolveJsonModule', () => {
    const f = fixture()
    f.write(
      'packages/example/tsconfig.json',
      '{"compilerOptions":{"rootDir":"src","outDir":"dist","declaration":true,"composite":true,"resolveJsonModule":true},"include":["src/*.ts","src/*.json"]}',
    )
    f.write('packages/example/src/lock.json', '{"fixture":true}')
    f.write('packages/example/dist/lock.json', '{"fixture":true}')
    success(f.run(['pack', 'types', f.artifact]))
    rmSync(join(f.cwd, 'packages/example/dist/lock.json'))
    success(f.run(['restore', f.artifact]))
    expect(readFileSync(join(f.cwd, 'packages/example/dist/lock.json'), 'utf8')).toBe('{"fixture":true}')
  })

  it('uses the referenced project owner when compiler roots overlap', () => {
    const f = fixture()
    f.write(
      'packages/example/tsconfig.json',
      '{"compilerOptions":{"rootDir":"src","outDir":"dist","declaration":true,"composite":true},"include":["src/*.ts"],"references":[{"path":"tsconfig.shared.json"}]}',
    )
    f.write(
      'packages/example/tsconfig.shared.json',
      '{"compilerOptions":{"rootDir":"src","outDir":"dist/shared","declaration":true,"composite":true},"include":["src/index.ts"]}',
    )
    for (const path of [
      'packages/example/dist/shared/index.js',
      'packages/example/dist/shared/index.d.ts',
      'packages/example/dist/tsconfig.shared.tsbuildinfo',
    ])
      f.write(path, 'shared owner\n')
    rmSync(join(f.cwd, 'packages/example/dist/index.js'))
    rmSync(join(f.cwd, 'packages/example/dist/index.d.ts'))
    success(f.run(['pack', 'types', f.artifact]))
    expect(f.manifest().files.some((file) => file.path === 'packages/example/dist/shared/index.d.ts')).toBe(
      true,
    )
    expect(f.manifest().files.some((file) => file.path === 'packages/example/dist/index.d.ts')).toBe(false)
  })

  it('refuses compiler layouts that emit into node_modules', () => {
    const f = fixture()
    f.write(
      'packages/example/tsconfig.json',
      '{"compilerOptions":{"rootDir":"src","outDir":"node_modules","declaration":true,"composite":true},"include":["src/*.ts"]}',
    )
    f.write('packages/example/node_modules/index.js', 'fixture\n')
    f.write('packages/example/node_modules/index.d.ts', 'fixture\n')
    expect(f.run(['pack', 'types', f.artifact]).status).not.toBe(0)
  })

  it('rejects missing expected compiler output before publishing an artifact', () => {
    const f = fixture()
    rmSync(join(f.cwd, 'packages/example/dist/index.d.ts'))
    expect(f.run(['pack', 'types', f.artifact]).status).not.toBe(0)
    expect(existsSync(f.artifact)).toBe(false)
  })

  it.each(['sha', 'runId', 'node', 'pnpm', 'lockHash', 'sourceHash'])(
    'fails closed on mismatched %s before restoring files',
    (field) => {
      const f = fixture()
      success(f.run(['pack', 'types', f.artifact]))
      f.rewrite((value) => {
        value[field] = 'wrong'
      })
      rmSync(join(f.cwd, f.generated[0] as string))
      expect(f.run(['restore', f.artifact]).status).not.toBe(0)
      expect(existsSync(join(f.cwd, f.generated[0] as string))).toBe(false)
    },
  )

  it('rejects changed Web tool build inputs even in a dirty checkout at the same SHA', () => {
    const f = fixture()
    success(f.run(['pack', 'types', f.artifact]))
    f.write('tools/e2e-web/browser.ts', 'export const browser = false\n')
    expect(f.run(['restore', f.artifact]).status).not.toBe(0)
  })

  it('allows a failed-only consumer rerun to use the original producer attempt', () => {
    const f = fixture()
    success(f.run(['pack', 'types', f.artifact]))
    expect(f.manifest().producerAttempt).toBe('1')
    success(f.run(['restore', f.artifact], { ...environment, GITHUB_RUN_ATTEMPT: '2' }))
  })

  it('validates types across platforms using the producer source-hash identity', () => {
    const f = fixture()
    success(f.run(['pack', 'types', f.artifact]))
    const hash = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {sourceHash} from ${JSON.stringify(pathToFileURL(cache).href)}; console.log(await sourceHash({platform:'linux',arch:'x64'}))`,
      ],
      { cwd: f.cwd, encoding: 'utf8' },
    )
    expect(hash.status, hash.stderr).toBe(0)
    f.rewrite((value) => {
      value.platform = 'linux'
      value.arch = 'x64'
      value.sourceHash = hash.stdout.trim()
      value.osRelease = 'other'
      value.imageOS = 'other'
      value.imageVersion = 'other'
    })
    success(f.run(['restore', f.artifact]))
  })

  describe.each(['native', 'local'])('%s compatibility', (kind) => {
    it.each(['platform', 'arch', 'osMajor', 'imageOS', 'nodeAbi', 'napi'])(
      'refuses reuse on a different %s',
      (field) => {
        const f = fixture()
        if (kind === 'local') f.local()
        success(f.run(['pack', kind, f.artifact]))
        f.rewrite((value) => {
          value[field] = 'other'
        })
        expect(f.run(['restore', f.artifact]).status).not.toBe(0)
      },
    )

    it('accepts different weekly image revisions with the same image family and runtime', () => {
      const f = fixture()
      if (kind === 'local') f.local()
      success(f.run(['pack', kind, f.artifact], { ...environment, ImageVersion: '20261030.294.1' }))
      expect(f.manifest().imageVersion).toBe('20261030.294.1')
      success(f.run(['restore', f.artifact], { ...environment, ImageVersion: '20261102.0473.1' }))
    })
  })

  it('roundtrips the source owners native helper executable modes', () => {
    const f = fixture()
    const observedModes = f.native.map((path) => ({ path, mode: statSync(join(f.cwd, path)).mode & 0o777 }))
    success(f.run(['pack', 'native', f.artifact]))
    expect(f.manifest().nodeAbi).toBe(process.versions.modules)
    expect(f.manifest().napi).toBe(process.versions.napi)
    expect(
      f
        .manifest()
        .files.map((file: { path: string }) => file.path)
        .sort(),
    ).toEqual(f.native.sort())
    for (const path of f.native) rmSync(join(f.cwd, path))
    success(f.run(['restore', f.artifact]))
    if (process.platform !== 'win32')
      expect(statSync(join(f.cwd, f.native[0] as string)).mode & 0o777).toBe(0o755)
    else
      for (const { path, mode } of observedModes) {
        expect(f.manifest().files.find((file) => file.path === path)?.mode).toBe(mode)
        expect(statSync(join(f.cwd, path)).mode & 0o777).toBe(mode)
      }
  })

  it('refuses absent native outputs and lost executable bits', () => {
    const f = fixture()
    if (process.platform !== 'win32') {
      const executable = f.native.find((path) => path.endsWith('pty-relay')) as string
      chmodSync(join(f.cwd, executable), 0o644)
      expect(f.run(['pack', 'native', f.artifact]).status).not.toBe(0)
    }
    rmSync(join(f.cwd, f.native[0] as string))
    expect(f.run(['pack', 'native', f.artifact]).status).not.toBe(0)
  })

  it.each([
    'missing-manifest',
    'missing-payload',
    'corrupt-payload',
    'missing-entry',
    'wrong-mode',
    'unsafe-path',
  ])('rejects %s without changing the checkout', (damage) => {
    const f = fixture()
    success(f.run(['pack', 'types', f.artifact]))
    if (damage === 'missing-manifest') rmSync(join(f.artifact, 'manifest.json'))
    if (damage === 'missing-payload') rmSync(join(f.artifact, 'payload.tar'))
    if (damage === 'corrupt-payload') {
      const data = readFileSync(join(f.artifact, 'payload.tar'))
      data[512] = (data[512] ?? 0) ^ 1
      writeFileSync(join(f.artifact, 'payload.tar'), data)
    }
    if (damage === 'missing-entry')
      f.rewrite((value) => {
        value.files.pop()
      })
    if (damage === 'wrong-mode')
      f.rewrite((value) => {
        value.files[0].mode = 0o755
      })
    if (damage === 'unsafe-path')
      f.rewrite((value) => {
        value.files[0].path = '../outside'
      })
    rmSync(join(f.cwd, f.generated[0] as string))
    expect(f.run(['restore', f.artifact]).status).not.toBe(0)
    expect(existsSync(join(f.cwd, f.generated[0] as string))).toBe(false)
  })

  it('roundtrips local distribution preserving Node bootstraps at 0644 and native executables at 0755', () => {
    const f = fixture()
    f.local()
    const observedModes = [
      'agnes.mjs',
      'daemon.mjs',
      'worker.mjs',
      process.platform === 'win32' ? 'ripgrep/rg.exe' : 'ripgrep/rg',
      'node_modules/@agnes/system-node/dist/native/agnes-system.node',
    ].map((name) => {
      const path = `packages/cli/dist/local/${name}`
      return { path, mode: statSync(join(f.cwd, path)).mode & 0o777 }
    })
    success(f.run(['pack', 'local', f.artifact]))
    rmSync(join(f.cwd, 'packages/cli/dist/local'), { recursive: true })
    success(f.run(['restore', f.artifact]))
    expect(readFileSync(join(f.cwd, 'packages/cli/dist/local/node_modules/example/index.js'), 'utf8')).toBe(
      'local fixture\n',
    )
    if (process.platform !== 'win32') {
      for (const name of ['agnes.mjs', 'daemon.mjs', 'worker.mjs'])
        expect(statSync(join(f.cwd, 'packages/cli/dist/local', name)).mode & 0o777).toBe(0o644)
      expect(statSync(join(f.cwd, 'packages/cli/dist/local/ripgrep/rg')).mode & 0o777).toBe(0o755)
      expect(statSync(join(f.cwd, 'packages/cli/dist/local/native/pty-relay')).mode & 0o777).toBe(0o755)
    } else
      for (const { path, mode } of observedModes) {
        expect(f.manifest().files.find((file) => file.path === path)?.mode).toBe(mode)
        expect(statSync(join(f.cwd, path)).mode & 0o777).toBe(mode)
      }
  })

  it('refuses stale local stamps and missing distribution native helpers', () => {
    const f = fixture()
    f.local()
    f.write('packages/example/src/index.ts', 'export const value = 2\n')
    expect(f.run(['pack', 'local', f.artifact]).status).not.toBe(0)
    f.local()
    rmSync(
      join(f.cwd, 'packages/cli/dist/local/node_modules/@agnes/system-node/dist/native/agnes-system.node'),
    )
    expect(f.run(['pack', 'local', f.artifact]).status).not.toBe(0)
  })

  it('rejects local paths that Windows would normalize into parent traversal', () => {
    if (process.platform === 'win32') return
    const f = fixture()
    f.local()
    f.write('packages/cli/dist/local/.. /outside', 'fixture\n')
    expect(f.run(['pack', 'local', f.artifact]).status).not.toBe(0)
  })

  it('refuses local trees containing credentials or symlinks', () => {
    const f = fixture()
    f.local()
    f.write('packages/cli/dist/local/.env', 'fixture')
    expect(f.run(['pack', 'local', f.artifact]).status).not.toBe(0)
    rmSync(join(f.cwd, 'packages/cli/dist/local/.env'))
    if (process.platform !== 'win32') {
      symlinkSync(temporary(), join(f.cwd, 'packages/cli/dist/local/link'))
      expect(f.run(['pack', 'local', f.artifact]).status).not.toBe(0)
    }
  })

  it.each(['symlink-entry', 'hardlink-entry', 'traversal-entry', 'duplicate-entry', 'omitted-entry'])(
    'rejects malicious tar %s before any restoration',
    (damage) => {
      const f = fixture()
      success(f.run(['pack', 'types', f.artifact]))
      let data = readFileSync(join(f.artifact, 'payload.tar'))
      const size = Number.parseInt(data.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8)
      const firstLength = 512 + Math.ceil(size / 512) * 512
      if (damage === 'omitted-entry') data = data.subarray(firstLength)
      else if (damage === 'duplicate-entry') data = Buffer.concat([data.subarray(0, firstLength), data])
      else {
        if (damage === 'traversal-entry') {
          data.fill(0, 0, 100)
          data.write('../escape', 0)
        } else data[156] = damage === 'symlink-entry' ? 50 : 49
        data.fill(32, 148, 156)
        const checksum = data.subarray(0, 512).reduce((sum, byte) => sum + byte, 0)
        data.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8)
      }
      writeFileSync(join(f.artifact, 'payload.tar'), data)
      rmSync(join(f.cwd, f.generated[0] as string))
      expect(f.run(['restore', f.artifact]).status).not.toBe(0)
      expect(existsSync(join(f.cwd, f.generated[0] as string))).toBe(false)
    },
  )

  it('requires producer metadata and keeps explicitly named artifact directories independent', () => {
    const f = fixture()
    expect(f.run(['pack', 'types', f.artifact], { ...environment, GITHUB_RUN_ID: '' }).status).not.toBe(0)
    expect(f.run(['pack', 'types', f.artifact], { ...environment, GITHUB_RUN_ATTEMPT: '' }).status).not.toBe(
      0,
    )
    success(f.run(['pack', 'types', f.artifact]))
    const second = join(temporary(), 'second-producer')
    success(f.run(['pack', 'types', second], { ...environment, GITHUB_RUN_ATTEMPT: '2' }))
    expect(JSON.parse(readFileSync(join(second, 'manifest.json'), 'utf8')).producerAttempt).toBe('2')
    expect(f.manifest().producerAttempt).toBe('1')
    success(f.run(['restore', f.artifact], { ...environment, GITHUB_RUN_ATTEMPT: '' }))
  })

  it('does not overwrite an outside file through an existing destination hardlink', () => {
    const f = fixture()
    success(f.run(['pack', 'types', f.artifact]))
    const destination = join(f.cwd, 'packages/example/dist/index.d.ts')
    const outside = join(temporary(), 'outside')
    rmSync(destination)
    writeFileSync(outside, 'outside fixture\n')
    linkSync(outside, destination)
    success(f.run(['restore', f.artifact]))
    expect(readFileSync(outside, 'utf8')).toBe('outside fixture\n')
    expect(readFileSync(destination, 'utf8')).toContain('generated')
  })

  it('refuses generated output symlinks and destination parent symlink escapes', () => {
    if (process.platform === 'win32') return
    const f = fixture()
    success(f.run(['pack', 'types', f.artifact]))
    rmSync(join(f.cwd, 'packages/example/dist'), { recursive: true })
    const outside = temporary()
    symlinkSync(outside, join(f.cwd, 'packages/example/dist'))
    expect(f.run(['restore', f.artifact]).status).not.toBe(0)
    expect(existsSync(join(outside, 'index.js'))).toBe(false)
    expect(f.run(['pack', 'types', join(temporary(), 'other')]).status).not.toBe(0)
  })
})
