import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as W from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'

type ChildOutput = {
  pid: number
  frame?: W.ActionFrame
  transition?: W.ProviderTransition
  error?: W.RuntimeError
  forbiddenCalls: number
  drain?: unknown
}
const fixturePath = fileURLToPath(new URL('./fixtures/compaction-author-cold-process.ts', import.meta.url))

describe('Compaction author wrapper cold process', () => {
  it('restores an explicit continuation after SIGKILL and refuses unavailable authority without effects', async () => {
    const taskTmpRoot = realpathSync(tmpdir())
    const directory = realpathSync(mkdtempSync(join(taskTmpRoot, 'agnes-compaction-author-cold-')))
    if (dirname(directory) !== taskTmpRoot) throw new Error('Fixture directory escaped temporary root')
    const snapshot = join(directory, 'committed-frame.json')
    const child = spawn(process.execPath, ['--import', 'tsx', fixturePath, 'start'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = '',
      errors = ''
    child.stderr.on('data', (chunk) => {
      errors += chunk.toString()
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    void exited.catch(() => {})
    const ready = new Promise<ChildOutput>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Compaction fixture startup timed out: ${errors}`)),
        15_000,
      )
      child.stdout.on('data', (chunk) => {
        output += chunk.toString()
        const end = output.indexOf('\n')
        if (end < 0) return
        clearTimeout(timer)
        try {
          resolve(JSON.parse(output.slice(0, end)) as ChildOutput)
        } catch (error) {
          reject(error)
        }
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (!output.includes('\n')) reject(new Error(`Compaction fixture exited: ${code} ${errors}`))
      })
    })
    try {
      const first = await ready
      expect(first.pid).toBe(child.pid)
      expect(first.forbiddenCalls).toBe(0)
      expect(first.transition).toMatchObject({
        expectedProviderRevision: 0,
        children: [],
        next: { kind: 'continue' },
      })
      if (!first.frame || !first.transition) throw new Error('Committed continuation missing')
      // F02-style test commit, not a production State transaction or a compaction history write.
      const frame = { ...first.frame, providerRevision: 1, continuation: first.transition.continuation }
      writeFileSync(snapshot, JSON.stringify(frame), { mode: 0o600 })
      const retained = readFileSync(snapshot, 'utf8')
      expect(child.kill('SIGKILL')).toBe(true)
      expect(await exited).toMatchObject({ signal: 'SIGKILL' })

      const restart = (alteration?: string): ChildOutput => {
        const restored = spawnSync(
          process.execPath,
          ['--import', 'tsx', fixturePath, 'resume', snapshot, ...(alteration ? [alteration] : [])],
          { encoding: 'utf8', timeout: 30_000, windowsHide: true },
        )
        if (restored.error || restored.status !== 0)
          throw new Error(`Compaction cold restart failed: ${restored.stderr}`, { cause: restored.error })
        const value = JSON.parse(restored.stdout) as ChildOutput
        expect(value.pid).not.toBe(first.pid)
        expect(value.forbiddenCalls).toBe(0)
        expect(readFileSync(snapshot, 'utf8')).toBe(retained)
        return value
      }
      const restored = restart()
      expect(restored.error).toBeUndefined()
      expect(restored.transition).toMatchObject({
        expectedProviderRevision: 1,
        continuation: frame.continuation,
        children: [],
        next: {
          kind: 'fail',
          error: { code: 'incompatible', detailCode: 'compaction_source_owner_unavailable' },
        },
      })
      expect(restored.drain).toMatchObject({
        ok: true,
        value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [] },
      })
      for (const [alteration, detailCode] of [
        ['start', 'action_phase_mismatch'],
        ['codec', 'state_codec_mismatch'],
        ['schema', 'author_schema_invalid'],
        ['input', 'fixture_original_input_mismatch'],
      ] as const) {
        const denied = restart(alteration)
        expect(denied.error).toMatchObject({ detailCode })
        expect(denied.transition).toBeUndefined()
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited.catch(() => undefined)
      rmSync(directory, { recursive: true, force: true })
    }
  }, 90_000)
})
