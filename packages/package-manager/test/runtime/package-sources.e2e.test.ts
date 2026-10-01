import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  identifyPackage,
  installedDir,
  readPackageTree,
  sha256Hex,
} from '../../src/runtime/source-snapshot.js'

const provider = fileURLToPath(new URL('../../src/runtime/providers/package-source.ts', import.meta.url))
const root = fileURLToPath(new URL('../../../..', import.meta.url))

function runChild(
  args: readonly string[],
  onReady?: (child: ChildProcess) => void,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', provider, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
    }, 15_000)
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
    child.on('exit', (code, signal) => finish({ code, signal }))
  })
}

describe('package source process recovery', () => {
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
