import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { executionGovernorPath, runOwnedExecution } from '../../src/runtime/platform/resource-owners.js'
import { limits } from './sandbox-exec-fixture.js'

describe.skipIf(process.platform !== 'darwin')('native mandatory hard-limit admission', () => {
  it.each(['memoryBytes', 'processes'] as const)(
    'refuses %s before a short-lived allocation or fork can have effects',
    async (field) => {
      const directory = mkdtempSync(join(tmpdir(), 'hard-gate-burst-'))
      try {
        const probe = join(directory, 'burst'),
          effect = join(directory, 'effect')
        execFileSync('cc', [
          '-O2',
          '-o',
          probe,
          fileURLToPath(new URL('./resource-burst.c', import.meta.url)),
        ])
        // Actual observations miss a completed excursion; their peak cannot qualify a hard gate.
        const diagnostic = JSON.parse(execFileSync(probe, [field], { encoding: 'utf8' }))
        expect(diagnostic.before).toBeLessThan(diagnostic.excursion)
        expect(diagnostic.after).toBeLessThan(diagnostic.excursion)
        expect(diagnostic.excursion).toBeGreaterThan(1)
        for (const binary of [
          executionGovernorPath(),
          fileURLToPath(
            new URL('../../../../examples/runtime-reference/dist/native/execution-owner', import.meta.url),
          ),
        ]) {
          const budget = { ...limits, [field]: 1 }
          const child = spawn(binary, [...Object.values(budget).map(String), probe, field, effect], {
            stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
            env: {},
          })
          let record = '',
            output = ''
          child.stdio[3]?.on('data', (b) => {
            record += b.toString()
          })
          child.stdout?.on('data', (b) => {
            output += b.toString()
          })
          child.stderr?.resume()
          const pipe = child.stdio[4]
          if (pipe && 'end' in pipe) pipe.end()
          const code = await new Promise<number | null>((resolve, reject) => {
            child.once('error', reject)
            child.once('close', resolve)
          })
          expect(code).toBe(125)
          expect(JSON.parse(record)).toEqual({ refused: 'exec_limit_memoryBytes_unsupported' })
          expect(output).toBe('')
          expect(existsSync(effect)).toBe(false)
        }
        await expect(
          runOwnedExecution({
            argv: [probe, field, effect],
            cwd: directory,
            env: {},
            stdin: new Uint8Array(),
            limits: { ...limits, [field]: 1 },
            signal: new AbortController().signal,
            observed: () => {
              throw new Error('Admission refusal must never invent a process sample')
            },
          }),
        ).rejects.toThrow('exec_limit_memoryBytes_unsupported')
        expect(existsSync(effect)).toBe(false)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
