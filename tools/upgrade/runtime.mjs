import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { run } from './distributions.mjs'

export async function connect(source, home) {
  const { createClient, memoryJournal } = await import(
    pathToFileURL(join(source, 'packages/sdk/src/index.node.ts')).href
  )
  const owner = JSON.parse(await readFile(join(home, 'daemon/owner.json'), 'utf8'))
  const sdk = createClient({
    transport: { kind: 'unix', path: owner.socketPath },
    auth: { kind: 'local' },
    journal: memoryJournal(),
    timeouts: { request: 90_000 },
  })
  await sdk.initialize()
  const call = sdk.call.bind(sdk)
  sdk.call = async (method, ...args) => {
    try {
      return await call(method, ...args)
    } catch (cause) {
      if (cause instanceof Error) cause.message = `Upgrade RPC ${method}: ${cause.message}`
      throw cause
    }
  }
  return sdk
}

export async function runtime(distribution, home, cwd) {
  const env = { PATH: process.env.PATH, HOME: home, AGH_HOME: home, AGNES_PROFILE: 'local-dev' }
  const entry = join(distribution, 'agnes.mjs')
  const command = (args) => run(process.execPath, [entry, ...args], { cwd, env, timeout: 120_000 })
  await command(['sessions', '--json'])
  const owner = JSON.parse(await readFile(join(home, 'daemon/owner.json'), 'utf8'))
  return {
    owner,
    command,
    async stop() {
      await command(['daemon', 'stop'])
    },
    async crash() {
      // Kill only the daemon owned by this newly created home; orphan workers are not allowed.
      // Freeze supervision before enumerating: a worker spawned after ps would escape the kill
      // list and correctly keep managed recovery fenced by its still-live process identity.
      process.kill(owner.pid, 'SIGSTOP')
      const { stdout } = await run('ps', ['-axo', 'pid=,ppid='])
      const rows = stdout
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number))
      const descendants = (pid) =>
        rows.filter((row) => row[1] === pid).flatMap(([child]) => [...descendants(child), child])
      const children = descendants(owner.pid)
      for (const pid of children) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
      process.kill(owner.pid, 'SIGKILL')
      await eventually(() => {
        try {
          process.kill(owner.pid, 0)
        } catch (error) {
          if (error.code === 'ESRCH') return true
          throw error
        }
        return false
      }, 'crashed daemon exit')
      // The earlier writer's bounded lease remains authoritative after process loss. Wait for
      // natural expiry rather than deleting a claim or changing clocks to force an upgrade.
      const db = new DatabaseSync(join(home, 'data/sessions.db'), { readOnly: true })
      let expires
      try {
        expires = db.prepare('SELECT max(until) AS expires FROM writer_claims').get().expires
      } finally {
        db.close()
      }
      const wait = Math.max(0, Number(expires ?? 0) - Date.now() + 50)
      assert.ok(wait <= 60_000, 'previous writer lease exceeds bounded upgrade recovery budget')
      console.info(`Crash recovery: waiting ${wait}ms for the previous writer lease`)
      if (wait) await delay(wait)
    },
  }
}

export async function eventually(probe, label) {
  for (let i = 0; i < 600; i++) {
    if (await probe()) return
    await delay(100)
  }
  throw new Error(`Upgrade deadline: ${label}`)
}

export async function packages(sdk) {
  const command = async () => ({
    profile: 'local-dev',
    clientId: await sdk.clientId(),
    commandId: crypto.randomUUID(),
  })
  const complete = async (receipt) => {
    let result
    await eventually(async () => {
      result = await sdk.packages.operation.get({ profile: 'local-dev', operationId: receipt.operationId })
      return ['completed', 'failed', 'cancelled', 'rolled-back'].includes(result.state)
    }, 'package operation')
    assert.equal(result.state, 'completed', JSON.stringify(result))
    return result
  }
  return { command, complete }
}
