import { type ChildProcess, spawn } from 'node:child_process'
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
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildRuntimeTarget,
  decodeRuntimeTargetBytes,
  encodeRuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import {
  identifyPackage,
  installedDir,
  readPackageTree,
  sha256Hex,
} from '../../src/runtime/source-snapshot.js'

const provider = fileURLToPath(new URL('./package-source-process-fixture.ts', import.meta.url))
const root = fileURLToPath(new URL('../../../..', import.meta.url))

function runChild(
  args: readonly string[],
  onReady?: (child: ChildProcess) => void,
  options: {
    entry?: string
    execArgv?: readonly string[]
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
  } = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...(options.execArgv ?? ['--import', 'tsx']), options.entry ?? provider, ...args],
      {
        cwd: options.cwd ?? root,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: { code: number | null; signal: NodeJS.Signals | null }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, stdout, stderr })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      if (!settled) {
        settled = true
        reject(new Error(`package source child timed out\n${stderr}\n${stdout}`))
      }
    }, options.timeoutMs ?? 15_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (onReady !== undefined && stdout.includes('READY\n')) onReady(child)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => finish({ code, signal }))
  })
}

describe('package source process recovery', () => {
  it('keeps a bundled worker probe free of package source process-fixture side effects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pkg-bundled-probe-'))
    const output = join(directory, 'build')
    const probe = join(directory, 'probe')
    const home = join(directory, 'home')
    mkdirSync(probe)
    mkdirSync(home)
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !name.startsWith('AGNES_') &&
            !name.startsWith('AGH_') &&
            !name.startsWith('VITEST_') &&
            name !== 'NODE_OPTIONS',
        ),
      ),
      HOME: home,
      AGH_HOME: home,
    }
    try {
      const built = await runChild(['--output-dir', output], undefined, {
        entry: join(root, 'packages/cli/tools/build-local.ts'),
        env,
        timeoutMs: 90_000,
      })
      expect(built.code, built.stderr + built.stdout).toBe(0)
      const artifact = encodeRuntimeTargetArtifact(
        buildRuntimeTarget({
          rows: [],
          resourceRevision: 'b'.repeat(64),
          compositeRevision: 'c'.repeat(64),
          resources: { mcp: [], skills: {} },
        }),
      )
      const targetFile = join(probe, 'runtime-target.json')
      writeFileSync(targetFile, decodeRuntimeTargetBytes(artifact))
      // Bundled import.meta.url names the executable. A symlink argv path can hide import side effects.
      const result = await runChild([], undefined, {
        entry: realpathSync(join(output, 'worker.mjs')),
        execArgv: [],
        cwd: probe,
        env: {
          ...env,
          AGNES_WORKER_KIND: 'probe',
          AGNES_WORKER_KEY: `@probe:${artifact.digest}`,
          AGNES_RUNTIME_TARGET_FILE: targetFile,
        },
      })
      expect(result, result.stderr).toEqual({ code: 0, signal: null, stdout: '', stderr: '' })
      expect(readdirSync(probe)).toEqual(['runtime-target.json'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('keeps an owned partial after the process is killed and verifies the bytes afterwards', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pkg-e2e-'))
    const cache = join(directory, 'cache')
    const packageDir = join(directory, 'acme.tools', '1.0.0')
    try {
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify({ id: 'acme.tools', version: '1.0.0' }))
      writeFileSync(join(packageDir, 'readme.txt'), 'process')
      const tree = readPackageTree(packageDir)
      expect(tree.ok).toBe(true)
      if (!tree.ok) return
      const identified = identifyPackage(tree.value)
      expect(identified.ok).toBe(true)
      if (!identified.ok) return
      const bytes = join(directory, 'archive.tar')
      writeFileSync(bytes, identified.value.archive)
      const digest = identified.value.treeDigest
      const held = await runChild(['hold-fetch', cache, digest, bytes], (child) => child.kill('SIGKILL'))
      expect(held.signal).toBe('SIGKILL')
      expect(existsSync(join(cache, 'staging', digest, 'PARTIAL'))).toBe(true)
      expect(existsSync(join(cache, 'staging', digest, 'archive.tar'))).toBe(false)
      expect(readFileSync(join(cache, 'staging', digest, 'OWNER'), 'utf8')).toBe('agh.default/package-source')
      expect(existsSync(installedDir(cache))).toBe(false)
      const recovered = await runChild(['recover-fetch', cache, digest, bytes])
      expect(recovered.code).toBe(0)
      expect(recovered.stdout).toBe(`STAGED ${digest} ${sha256Hex(identified.value.archive)}\n`)
      expect(existsSync(join(cache, 'staging', digest, 'archive.tar'))).toBe(true)
      expect(existsSync(join(cache, 'staging', digest, 'PARTIAL'))).toBe(false)
      expect(existsSync(installedDir(cache))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
