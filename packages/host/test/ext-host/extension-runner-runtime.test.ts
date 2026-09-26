import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  loadBundledExtensionRuntime,
  resolveExtensionRunnerRuntime,
} from '../../src/ext-host/extension-runner-runtime.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agnes-runner-runtime-'))
  directories.push(root)
  const output = join(root, 'isolation')
  mkdirSync(output)
  const runner = join(output, 'hooks-runner.mjs')
  writeFileSync(runner, 'process.stdin.resume()\n')
  const sha256 = createHash('sha256').update(readFileSync(runner)).digest('hex')
  writeFileSync(
    join(output, 'hooks-runner.manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      entry: 'hooks-runner.mjs',
      sha256,
      node: { minimum: '24.10.0', major: 24 },
    }),
  )
  return output
}

it('prefers the Agnes-bundled runtime and returns only explicit runtime and bundle reads', () => {
  const artifactDirectory = fixture()
  const runtime = resolveExtensionRunnerRuntime({
    artifactDirectory,
    bundledNode: { executable: process.execPath, readRoots: [dirname(process.execPath)] },
    configuredNode: { executable: process.execPath, readRoots: [tmpdir()] },
    hostNode: false,
    probe: () => ({ node: '24.10.0' }),
  })
  expect(runtime.source).toBe('bundled')
  expect(runtime.readPaths).toEqual([dirname(process.execPath), runtime.runner])
  expect(runtime.runner).toMatch(/hooks-runner\.mjs$/)
})

it('rejects an OpenClaw/Electron executable instead of setting ELECTRON_RUN_AS_NODE', () => {
  const artifactDirectory = fixture()
  expect(() =>
    resolveExtensionRunnerRuntime({
      artifactDirectory,
      hostNode: { executable: process.execPath, readRoots: [dirname(process.execPath)] },
      probe: () => ({ node: '24.14.0', electron: '41.2.0' }),
    }),
  ).toThrow(/no supported Node 24 runtime.*Electron-based/)
})

it('falls through a rejected bundled candidate to an explicitly configured standard Node', () => {
  const artifactDirectory = fixture()
  const runtime = resolveExtensionRunnerRuntime({
    artifactDirectory,
    bundledNode: { executable: '/bin/sh', readRoots: ['/bin'] },
    configuredNode: { executable: process.execPath, readRoots: [dirname(process.execPath)] },
    hostNode: false,
    // The resolver probes canonical paths, and /bin/sh is a symlink on many Linux systems
    // (/bin -> /usr/bin, sh -> dash). Treat everything except the configured Node as Electron.
    probe: (executable) =>
      executable === realpathSync(process.execPath)
        ? { node: '24.14.0' }
        : { node: '24.14.0', electron: '41.2.0' },
  })
  expect(runtime.source).toBe('configured')
})

it('fails closed when the packaged runner no longer matches its manifest', () => {
  const artifactDirectory = fixture()
  const runner = join(artifactDirectory, 'hooks-runner.mjs')
  writeFileSync(runner, `${readFileSync(runner, 'utf8')}\n// tampered\n`)
  expect(() =>
    resolveExtensionRunnerRuntime({ artifactDirectory, hostNode: false, probe: () => ({ node: '24.10.0' }) }),
  ).toThrow('runner digest mismatch')
})

it.each(['darwin-arm64', 'linux-x64', 'win32-x64'])(
  'loads and verifies the aggregate CLI/daemon runtime package manifest for %s',
  (target) => {
    const artifactDirectory = fixture()
    const root = join(artifactDirectory, '..')
    const nodeRoot = join(root, 'node', target)
    const nodeEntry = target.startsWith('win32-') ? 'node.exe' : 'bin/node'
    const executable = join(nodeRoot, nodeEntry)
    mkdirSync(dirname(executable), { recursive: true })
    // This tests manifest layout and integrity; the version probe below is deliberately injected.
    copyFileSync(process.execPath, executable)
    chmodSync(executable, 0o755)
    const nodeSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex')
    const runnerManifest = JSON.parse(
      readFileSync(join(artifactDirectory, 'hooks-runner.manifest.json'), 'utf8'),
    ) as { sha256: string }
    writeFileSync(
      join(root, 'runtime.manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        target,
        node: {
          version: '24.10.0',
          executable: `node/${target}/${nodeEntry}`,
          sha256: nodeSha256,
          upstreamArchiveSha256: 'a'.repeat(64),
        },
        runner: { directory: 'isolation', entry: 'hooks-runner.mjs', sha256: runnerManifest.sha256 },
      }),
    )
    const packaged = loadBundledExtensionRuntime(root, target)
    const runtime = resolveExtensionRunnerRuntime({
      ...packaged,
      hostNode: false,
      probe: () => ({ node: '24.10.0' }),
    })
    expect(runtime.source).toBe('bundled')
    expect(runtime.executable).toBe(realpathSync(executable))
    writeFileSync(executable, 'tampered runtime')
    expect(() => loadBundledExtensionRuntime(root, target)).toThrow('packaged Node digest or path mismatch')
  },
)
