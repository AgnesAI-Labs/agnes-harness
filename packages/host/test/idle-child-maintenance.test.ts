import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import type { InferenceEvent, JsonValue, Provider, RequestBody } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { createTestHost } from '../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
const directories: string[] = []
const hosts: Array<Awaited<ReturnType<typeof createTestHost>>['host']> = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()))
  vi.useRealTimers()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const text = (value: string): InferenceEvent[] => [
  { type: 'text_delta', delta: value },
  { type: 'done', reason: 'stop' },
]
const tool = (name: string, args: Record<string, JsonValue>): InferenceEvent[] => [
  { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
  { type: 'done', reason: 'toolUse' },
]

async function spawnedHost(idleMs?: number) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-idle-child-')))
  directories.push(dataDir)
  const models = [fakeModel({ route: 'gw', id: 'm1' })]
  const parent = new ScriptedProvider({
    models,
    scripts: [
      tool('tool_describe', { name: 'subagent_spawn' }),
      tool('subagent_spawn', { task: 'return the result', isolation: 'shared', wait: true }),
      text('parent completed'),
    ],
    onExhausted: 'error',
  })
  const child = new ScriptedProvider({
    models,
    scripts: [text('durable child result')],
    onExhausted: 'error',
  })
  const provider: Provider = {
    models: () => models,
    infer: (request: RequestBody, options) =>
      (request.sessionKey === 'parent' ? parent : child).infer(request, options),
  }
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    provider,
    disableSessionTitle: true,
    limits: {
      'lease.ttl_ms': 14_400_000,
      ...(idleMs === undefined ? {} : { 'subagent.idle_retire_ms': idleMs }),
    },
  })
  hosts.push(host)
  const binding = host.acceptWorkspaceBinding(
    { version: 1, sessionKey: 'parent', workspaceId: 'a'.repeat(64), revision: 1, canonicalRoot: dataDir },
    'parent',
  )
  const session = await host.createSession({ key: 'parent', binding })
  writeFileSync(join(dataDir, 'retained-result.txt'), 'keep the working files')
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text: 'delegate the task' }],
    actor: session.d.actor,
    kind: 'prompt',
  })
  expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
    reason: 'completed',
  })
  const listing = await session.d.children.list?.()
  expect(listing).toHaveLength(1)
  const first = listing?.[0]
  if (!first) throw new Error('Base spawn did not publish a child')
  const key = first.id
  expect(first).toMatchObject({ status: 'idle', continuable: true })
  expect(host.kernel.get(key)).toBeDefined()
  return { host, session, key, dataDir }
}

it('the production Host timer retires a Base-spawned child at sixty minutes while a disabled Host retains its own child', async () => {
  // Keep unrelated I/O deadlines real; only the production periodic clock advances.
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  const enabled = await spawnedHost()
  const disabled = await spawnedHost(0)
  // Skip unrelated per-second status publications, then exercise real Host ticks at 59 and 60 minutes.
  vi.setSystemTime(Date.now() + 3_480_000)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(enabled.host.kernel.get(enabled.key)).toBeDefined()
  await vi.advanceTimersByTimeAsync(60_000)
  await expect.poll(() => enabled.host.kernel.get(enabled.key) === undefined).toBe(true)
  expect(disabled.host.kernel.get(disabled.key)).toBeDefined()
  expect(await enabled.session.d.children.list?.()).toMatchObject([
    { id: enabled.key, status: 'completed', continuable: false, text: 'durable child result' },
  ])
  expect(await enabled.session.d.children.inspect?.(enabled.key)).toMatchObject({
    text: 'durable child result',
  })
  expect(readFileSync(join(enabled.dataDir, 'retained-result.txt'), 'utf8')).toBe('keep the working files')
  await expect(
    enabled.session.d.children.sendMessage?.(enabled.key, 'again', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
  await enabled.host.close()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(disabled.host.kernel.get(disabled.key)).toBeDefined()
}, 30_000)
