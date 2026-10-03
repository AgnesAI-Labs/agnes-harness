import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import {
  type RoutingRecoveryKind,
  routingProofDigest,
  routingRecoverySeed,
} from './fixtures/routing-recovery-source.js'

interface Observation {
  phase: string
  pid: number
  proof: unknown
}
function message(child: ChildProcess): Promise<Observation> {
  return new Promise((resolve, reject) => {
    let errors = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Worker deadline: ${errors}`))
    }, 15000)
    const data = (chunk: Buffer) => {
      errors += chunk.toString()
    }
    const receive = (value: Observation) => {
      cleanup()
      resolve(value)
    }
    const exit = (code: number | null) => {
      cleanup()
      reject(new Error(`Worker exited ${code}: ${errors}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', receive)
      child.off('exit', exit)
      child.stderr?.off('data', data)
    }
    child.on('message', receive)
    child.once('exit', exit)
    child.stderr?.on('data', data)
  })
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await exit
}
it.each(['default', 'reference'] as const)(
  'rebuilds the actual %s routing provider in a fresh PID after SIGKILL with the exact original input and selection',
  async (kind: RoutingRecoveryKind) => {
    const directory = mkdtempSync(join(tmpdir(), 'routing-recovery-'))
    const sourceFile = join(directory, 'source.json'),
      resultFile = join(directory, 'selection.json')
    const children: ChildProcess[] = []
    try {
      const seed = routingRecoverySeed(kind)
      const code = createHash('sha256')
      for (const path of [
        '../../src/runtime/providers/routing.ts',
        '../../../../examples/runtime-reference/src/providers/routing.ts',
        '../../../extension-api/src/runtime/routing-authoring.ts',
      ])
        code.update(readFileSync(fileURLToPath(new URL(path, import.meta.url))))
      writeFileSync(
        sourceFile,
        JSON.stringify({ seed, code: code.digest('hex'), digest: routingProofDigest(seed) }),
        { flag: 'wx', mode: 0o400 },
      )
      const run = (mode: string) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(new URL('./fixtures/routing-recovery-worker.ts', import.meta.url)),
            mode,
            sourceFile,
            resultFile,
          ],
          {
            cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: { PATH: process.env.PATH, LANG: 'C' },
          },
        )
        children.push(child)
        return child
      }
      const first = run('first'),
        selected = await message(first)
      expect(selected.phase).toBe('selected')
      expect(selected.pid).toBe(first.pid)
      expect(first.exitCode).toBeNull()
      const beforeSource = readFileSync(sourceFile),
        beforeResult = readFileSync(resultFile)
      const proof = JSON.parse(beforeResult.toString()) as {
        result: unknown
        route: { route: unknown }
        inputDigest: string
        configurationDigest: string
      }
      expect(validateRuntime('DataRef', proof.result).ok).toBe(true)
      expect(validateRuntime('RoutingSelectResult', proof.route).ok).toBe(true)
      expect(proof.inputDigest).toBe(canonicalJsonDigest(seed.input))
      expect(proof.configurationDigest).toBe(canonicalJsonDigest(seed.configuration))
      await stop(first)
      expect(first.signalCode).toBe('SIGKILL')
      chmodSync(resultFile, 0o400)
      const fresh = run('recover'),
        recovered = await message(fresh)
      expect(recovered.phase).toBe('recovered')
      expect(recovered.pid).toBe(fresh.pid)
      expect(recovered.pid).not.toBe(selected.pid)
      expect(recovered.proof).toEqual(selected.proof)
      expect(readFileSync(sourceFile)).toEqual(beforeSource)
      expect(readFileSync(resultFile)).toEqual(beforeResult)
    } finally {
      await Promise.all(children.map(stop))
      rmSync(directory, { recursive: true, force: true })
    }
  },
  30000,
)
