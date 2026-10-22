import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { packageDirs } from '../assemble/plugin-extension-fixture.js'
import { roleHuman, setupRoleEscalation } from './role-escalation-fixture.js'

it('reoffers the same child decision after process loss while pending, using the pinned Host composition', async () => {
  const homes = join(homedir(), 'agh-real-eval')
  mkdirSync(homes, { recursive: true })
  const home = mkdtempSync(join(homes, 'role-escalation-security-'))
  const fixture = await setupRoleEscalation(
    async () => {
      throw new Error('No preparation effects expected')
    },
    { home },
  )
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
  let third: ReturnType<typeof start> | undefined
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
    third = start('replay')
    expect(await new Promise((resolve) => third!.once('exit', resolve)), output).toBe(0)
    const replay = JSON.parse(readFileSync(join(fixture.dataDir, 'replay-result.json'), 'utf8'))
    expect(replay.decision).toEqual(result.decision)
    expect(replay.calls).toHaveLength(1)
    expect(replay.role.parentTainted).toBe(true)
  } finally {
    if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL')
    if (second?.exitCode === null && second.signalCode === null) second.kill('SIGKILL')
    if (third?.exitCode === null && third.signalCode === null) third.kill('SIGKILL')
    for (const worker of [first, second, third])
      if (worker && worker.exitCode === null && worker.signalCode === null)
        await new Promise((resolve) => worker.once('exit', resolve))
    rmSync(home, { recursive: true, force: true })
  }
}, 110000)

it('review-f1: explicit close survives a real process restart and cannot revive an admitted role', async () => {
  const homes = join(homedir(), 'agh-real-eval')
  mkdirSync(homes, { recursive: true })
  const home = mkdtempSync(join(homes, 'role-closed-epoch-security-'))
  const fixture = await setupRoleEscalation(
    async () => {
      throw new Error('No preparation effects expected')
    },
    { home },
  )
  await fixture.host.close()
  const config = join(home, 'crash-config.json')
  writeFileSync(
    config,
    JSON.stringify({
      dataDir: home,
      packageDirs,
      source: fixture.source,
      target: fixture.target,
      human: roleHuman,
      role: fixture.refs[0],
    }),
  )
  const worker = fileURLToPath(new URL('../fixtures/role-escalation-crash-worker.ts', import.meta.url))
  const children: ReturnType<typeof spawn>[] = []
  let output = ''
  const run = async (phase: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, config, phase], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    child.stdout?.on('data', (chunk) => {
      output += chunk
    })
    child.stderr?.on('data', (chunk) => {
      output += chunk
    })
    expect(await new Promise((resolve) => child.once('exit', resolve)), output).toBe(0)
  }
  try {
    await run('close-admitted')
    const stopped = JSON.parse(readFileSync(join(home, 'closed-state.json'), 'utf8'))
    expect(stopped).toMatchObject({ blocked: 'E_CLOSED', wrote: false })
    await run('resume-closed')
    const restored = JSON.parse(readFileSync(join(home, 'closed-resume-result.json'), 'utf8'))
    for (const question of restored.questions)
      expect(question.decision.handle.sessionId).toBe(stopped.childKey)
    if (restored.wrote) expect(readFileSync(join(home, 'cold.md'), 'utf8')).toBe('Cold child requirements')
    expect({ cards: restored.questions.length, wrote: restored.wrote }).toEqual({ cards: 0, wrote: false })
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => child.once('exit', resolve))
    rmSync(home, { recursive: true, force: true })
  }
}, 60000)
