import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { packageDirs } from '../assemble/plugin-extension-fixture.js'
import { roleHuman, setupRoleEscalation } from './role-escalation-fixture.js'

it('reoffers the same child decision after process loss while pending, using the pinned Host composition', async () => {
  const fixture = await setupRoleEscalation(async () => {
    throw new Error('No preparation effects expected')
  })
  await fixture.host.close()
  const config = join(fixture.dataDir, 'crash-config.json')
  writeFileSync(
    config,
    JSON.stringify({
      dataDir: fixture.dataDir,
      packageDirs,
      source: fixture.source,
      target: fixture.target,
      human: roleHuman,
      role: fixture.refs[0],
    }),
  )
  const worker = fileURLToPath(new URL('../fixtures/role-escalation-crash-worker.ts', import.meta.url))
  let output = ''
  const start = (phase: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, config, phase], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    return child
  }
  const first = start('hold')
  let second: ReturnType<typeof start> | undefined
  try {
    await vi.waitFor(
      () => {
        if (first.exitCode !== null) throw new Error(output)
        expect(existsSync(join(fixture.dataDir, 'hold-question.json'))).toBe(true)
      },
      { timeout: 20000 },
    )
    const original = JSON.parse(readFileSync(join(fixture.dataDir, 'hold-question.json'), 'utf8'))
    expect(original.delegation.role).toBe(fixture.refs[0])
    expect(existsSync(join(fixture.dataDir, 'cold.md'))).toBe(false)
    const stopped = new Promise((resolve) => first.once('exit', resolve))
    first.kill('SIGKILL')
    await stopped
    // The crashed writer cannot release its lease. Let the real 30s lease expire; do not edit storage.
    await new Promise((resolve) => setTimeout(resolve, 31000))
    second = start('allow')
    const exit = await new Promise((resolve) => second!.once('exit', resolve))
    expect(exit, output).toBe(0)
    const result = JSON.parse(readFileSync(join(fixture.dataDir, 'cold-result.json'), 'utf8'))
    expect(result.question.decision.handle).toEqual(original.decision.handle)
    expect(result.question.sessionKey).toBe('parent')
    expect(result.role.parentTainted).toBe(true)
    expect(result.decision.result.answeredBy).toEqual(roleHuman)
    expect(result.decision.consumption).not.toBeNull()
    expect(result.calls).toHaveLength(1)
    expect(readFileSync(join(fixture.dataDir, 'cold.md'), 'utf8')).toBe('Cold child requirements')
  } finally {
    if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL')
    if (second?.exitCode === null && second.signalCode === null) second.kill('SIGKILL')
  }
}, 110000)
