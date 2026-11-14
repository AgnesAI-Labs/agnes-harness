import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PrepareFailed,
  SessionArchived,
  SessionRegistry,
  Sessions,
  type SessionsDeps,
  SessionTaken,
} from '../../src/runtime/sessions.js'
import { fakeClient } from './fake-sdk.js'
import { tempStore, ticket } from './helpers.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

function setup(fields: Partial<SessionsDeps> = {}) {
  const fake = fakeClient()
  const registry = new SessionRegistry(temp.store)
  const models: string[] = []
  const sessions = new Sessions({
    client: fake.client,
    registry,
    orchestratorDir: () => join(temp.dir, 'state'),
    prepareCommand: () => 'git init -q repo && echo "$SUPERAGENT_TICKET" > repo/ticket',
    environment: (item) => ({ SUPERAGENT_TICKET: item.id }),
    applyModel: async (role) => {
      models.push(role)
    },
    lifetime: new AbortController().signal,
    ...fields,
  })
  return { fake, registry, sessions, models }
}

describe('worker sessions', () => {
  it('creates the ticket directory, runs prepare inside it, then opens the worker session there', async () => {
    const { fake, registry, sessions, models } = setup()
    const dir = join(temp.dir, 'work', 'fix-login')
    const id = await sessions.ensureWorker(ticket('t1', { title: 'Fix login' }), dir)
    // The prepare command ran in the ticket directory with the ticket's variables and put the repository in repo/.
    expect(readFileSync(join(dir, 'repo', 'ticket'), 'utf8').trim()).toBe('t1')
    expect(existsSync(join(dir, 'repo', '.git'))).toBe(true)
    expect(fake.workspaces).toEqual([dir])
    expect(fake.sessions.get(id)?.options).toEqual({
      cwd: dir,
      sessionKey: 'superagent:worker:t1',
      permission: 'full-access',
      bundles: ['@agnes/superagent#worker'],
      preset: 'superagent-worker',
    })
    // The SDK session key is the AGH session id, which the store records.
    expect(id).toBe('superagent:worker:t1')
    expect(registry.role(id)).toEqual({ kind: 'worker', ticketId: 't1' })
    expect(new SessionRegistry(temp.store).role(id)).toEqual({ kind: 'worker', ticketId: 't1' })
    expect(fake.renamed).toEqual([[id, 'Fix login']])
    expect(models).toEqual(['worker'])
  })

  it('fails the ticket without retrying when prepare fails, removing the directory it left empty', async () => {
    const { fake, registry, sessions } = setup({ prepareCommand: () => 'echo no access >&2; exit 3' })
    const dir = join(temp.dir, 'work', 'broken')
    const failed = sessions.ensureWorker(ticket('t2'), dir)
    await expect(failed).rejects.toBeInstanceOf(PrepareFailed)
    await expect(failed).rejects.toThrow(/exit 3.*no access/s)
    expect(existsSync(dir)).toBe(false)
    expect(fake.workspaces).toEqual([])
    expect(registry.ids()).toEqual([])
  })

  it('prepares again a directory whose prepare was stopped part way, and only then counts it as prepared', async () => {
    const dir = join(temp.dir, 'work', 'stopped')
    const lifetime = new AbortController()
    const first = setup({
      prepareCommand: () => 'mkdir repo && touch repo/half && sleep 5 && touch repo/done',
      lifetime: lifetime.signal,
    })
    const stopped = first.sessions.ensureWorker(ticket('t12'), dir)
    await vi.waitFor(() => expect(existsSync(join(dir, 'repo', 'half'))).toBe(true))
    lifetime.abort()
    await expect(stopped).rejects.toThrow(/stopped/)
    expect(existsSync(join(dir, '.superagent-prepared'))).toBe(false)
    // The next launch finds the half-prepared directory, moves it aside whole, and prepares the ticket again.
    const warnings: string[] = []
    const again = setup({
      prepareCommand: () => 'mkdir repo && touch repo/done',
      log: { warn: (message) => warnings.push(message) },
    })
    await again.sessions.ensureWorker(ticket('t12'), dir)
    expect(existsSync(join(dir, 'repo', 'done'))).toBe(true)
    expect(existsSync(join(dir, 'repo', 'half'))).toBe(false)
    expect(existsSync(join(dir, '.superagent-prepared'))).toBe(true)
    const aside = readdirSync(join(temp.dir, 'work')).filter((name) =>
      name.startsWith('stopped.interrupted-'),
    )
    expect(aside).toHaveLength(1)
    expect(existsSync(join(temp.dir, 'work', aside[0]!, 'repo', 'half'))).toBe(true)
    expect(warnings).toEqual([expect.stringContaining(join(temp.dir, 'work', aside[0]!))])
    // A failed check of the prepared directory leaves it unprepared too.
    const checked = join(temp.dir, 'work', 'unchecked')
    const failing = setup({
      prepareCommand: () => 'touch made',
      verify: async () => {
        throw new Error('git config is wrong')
      },
    })
    await expect(failing.sessions.ensureWorker(ticket('t13'), checked)).rejects.toThrow('git config is wrong')
    expect(existsSync(join(checked, '.superagent-prepared'))).toBe(false)
  })

  it('loads an existing session instead of creating another, and an existing directory counts as prepared', async () => {
    const { fake, sessions } = setup()
    const dir = join(temp.dir, 'work', 'again')
    const first = await sessions.ensureWorker(ticket('t3'), dir)
    const reopened = setup({ prepareCommand: () => 'exit 1' })
    // A new process: the session exists in the daemon and the store, not in memory.
    reopened.fake.sessions.set(first, fake.sessions.get(first)!)
    expect(await reopened.sessions.ensureWorker(ticket('t3', { title: 'Renamed' }), dir)).toBe(first)
    expect(reopened.fake.loads).toEqual([first])
    expect(reopened.fake.renamed).toEqual([[first, 'Renamed']])
  })

  it('opens a registered worker session its owner deleted again, under the same key', async () => {
    const { fake, registry, sessions } = setup()
    const dir = join(temp.dir, 'w4')
    const id = await sessions.ensureWorker(ticket('t4'), dir)
    fake.remove(id)
    expect(await sessions.ensureWorker(ticket('t4'), dir)).toBe(id)
    expect(fake.sessions.get(id)?.options).toMatchObject({ sessionKey: id, preset: 'superagent-worker' })
    expect(fake.sessions.get(id)?.deleted).toBeUndefined()
    expect(registry.role(id)).toEqual({ kind: 'worker', ticketId: 't4' })
  })

  it('fails the assignment when the owner archived the worker session, and opens no other', async () => {
    const { fake, sessions } = setup()
    const dir = join(temp.dir, 'w8')
    const id = await sessions.ensureWorker(ticket('t8'), dir)
    fake.sessions.get(id)!.archived = true
    const opened = sessions.ensureWorker(ticket('t8'), dir)
    await expect(opened).rejects.toBeInstanceOf(SessionArchived)
    await expect(opened).rejects.toThrow(/archived.*superagent:worker:t8/)
    expect([...fake.sessions.keys()]).toEqual([id])
  })

  it('never takes over a session under its key that Superagent did not open', async () => {
    const { fake, registry, sessions } = setup()
    fake.make('superagent:worker:t5')
    const opened = sessions.ensureWorker(ticket('t5'), join(temp.dir, 'w5'))
    await expect(opened).rejects.toBeInstanceOf(SessionTaken)
    await expect(opened).rejects.toThrow(/superagent:worker:t5/)
    expect(registry.ids()).toEqual([])
    expect(fake.sessions.get('superagent:worker:t5')?.options).toBeUndefined()
    const main = setup()
    main.fake.make('superagent:orchestrator')
    await expect(main.sessions.ensureOrchestrator()).rejects.toBeInstanceOf(SessionTaken)
    // Another principal's session under the key: the daemon denies both opening and creating it.
    const other = setup()
    other.fake.foreign.add('superagent:worker:t11')
    await expect(other.sessions.ensureWorker(ticket('t11'), join(temp.dir, 'w11'))).rejects.toBeInstanceOf(
      SessionTaken,
    )
  })

  it('adopts a session it created but had not recorded yet, as after a stop in between', async () => {
    const { fake, registry, sessions } = setup()
    registry.intend({ kind: 'worker', ticketId: 't9' }, 'superagent:worker:t9')
    fake.make('superagent:worker:t9')
    expect(await sessions.ensureWorker(ticket('t9'), join(temp.dir, 'w9'))).toBe('superagent:worker:t9')
    expect(registry.role('superagent:worker:t9')).toEqual({ kind: 'worker', ticketId: 't9' })
    expect(fake.sessions.get('superagent:worker:t9')?.options).toBeUndefined()
  })

  it('names the session with a title the daemon accepts', async () => {
    const { fake, sessions } = setup()
    await sessions.ensureWorker(
      ticket('t10', { title: `${'x'.repeat(100)}\nsecond line` }),
      join(temp.dir, 'w10'),
    )
    expect(fake.renamed.at(-1)?.[1]).toBe('x'.repeat(80))
  })
})

describe('main session and pending inputs', () => {
  it('opens the main session with the router bundle in the state directory', async () => {
    const { fake, sessions, registry, models } = setup()
    const id = await sessions.ensureOrchestrator()
    expect(fake.sessions.get(id)?.options).toMatchObject({
      cwd: join(temp.dir, 'state'),
      sessionKey: 'superagent:orchestrator',
      permission: 'full-access',
      bundles: ['@agnes/superagent#router'],
      preset: 'superagent-router',
    })
    expect(registry.role(id)).toEqual({ kind: 'orchestrator' })
    expect(models).toEqual(['orchestrator'])
    expect(await sessions.ensureOrchestrator()).toBe(id)
  })

  it('reads the real session state and removes the named pending items only', async () => {
    const { fake, sessions } = setup()
    const id = await sessions.ensureOrchestrator()
    const session = fake.sessions.get(id)!
    session.pending.push(
      { itemId: 'i1', commandId: 'superagent:a', preview: 'a' },
      { itemId: 'i2', preview: 'b' },
    )
    session.jobs.push({ id: 'j1', owner: 'agent', status: 'running', command: 'npm test' })
    session.jobs.push({ id: 'j2', owner: 'human', status: 'running', command: 'top' })
    session.running = true
    expect(await sessions.state(id)).toEqual({
      running: true,
      pending: [{ itemId: 'i1', commandId: 'superagent:a' }, { itemId: 'i2' }],
      jobs: 1,
    })
    await sessions.dropPending(id, ['i1'])
    expect((await sessions.state(id)).pending).toEqual([{ itemId: 'i2' }])
    await sessions.cancel(id)
    expect((await sessions.state(id)).running).toBe(false)
  })

  it('finds the role of a child session through its key', () => {
    const { registry } = setup()
    registry.record({ kind: 'worker', ticketId: 't6' }, 'superagent:worker:t6')
    expect(registry.owner('superagent:worker:t6/01HX/01HY')).toEqual({
      role: { kind: 'worker', ticketId: 't6' },
      child: true,
    })
    expect(registry.owner('superagent:worker:t7')).toBeUndefined()
    expect(registry.owner('superagent:owner-made/01HX')).toBeUndefined()
  })
})
