import { afterEach, expect, it, vi } from 'vitest'
import { startChannelBridge } from '../src/bridge.js'
import type { RunnerConfig } from '../src/runner/config.js'
import { createRunner } from '../src/runner/runner.js'
import { createFakeClient, FakeChannel } from '../testkit/index.js'
import { bridgeFixture, groupMessage } from './bridge-fixture.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const config: RunnerConfig = {
  channel: 'fake',
  connect: { kind: 'unix', path: '/tmp/agnes.sock' },
  tenant: 'tenant',
  agent: 'agent',
  credentialsFile: '/dev/null',
  allowFrom: [],
  requireMention: true,
  ackReaction: 'off',
  workspace: '/workspace',
  outbound: { costLine: false },
  directory: { sync: false },
  healthz: { enabled: false, port: 9877 },
}

it('never routes a bot sender to a session and treats a sender without a kind as a user', async () => {
  const client = createFakeClient()
  const adapter = new FakeChannel()
  const runner = createRunner({
    adapter,
    cfg: config,
    secrets: {},
    client,
    log: { info() {}, warn() {}, error() {} },
  })
  cleanups.push(() => runner.stop())
  await runner.start()
  // One chat, one lane: had the bot message been routed, it would be submitted before the others.
  adapter.emit(groupMessage('@bot from a bot', { sender: { userId: 'ci', kind: 'bot', raw: {} } }))
  adapter.emit(groupMessage('@bot from an older adapter', { sender: { userId: 'legacy', raw: {} } }))
  adapter.emit(groupMessage('@bot from a user', { sender: { userId: 'person', kind: 'user', raw: {} } }))
  await vi.waitFor(() => expect(client.calls.filter((call) => call.method === 'followUp')).toHaveLength(2))
  const submitted = client.calls
    .filter((call) => call.method === 'followUp')
    .map((call) => JSON.stringify(call.args[0]))
  expect(submitted[0]).toContain('from an older adapter')
  expect(submitted[1]).toContain('from a user')
  expect(JSON.stringify(client.calls)).not.toContain('from a bot')
})

it('does not offer a bot-only chat as a session binding target', async () => {
  const f = await bridgeFixture(cleanups)
  const runtime = await startChannelBridge(f.provider, f.init, f.options)
  const adapter = f.adapters[0]!
  adapter.emit(groupMessage('@bot build failed', { sender: { userId: 'ci', kind: 'bot', raw: {} } }))
  adapter.emit(groupMessage('@bot hello', { chat: { id: 'group-b', type: 'group' } }))
  const view = (await runtime.session!({ id: 'web-session', workspace: f.root })) as {
    instances: { targets: { label: string }[] }[]
  }
  expect(view.instances[0]!.targets.map((target) => target.label)).toEqual(['group-b'])
})
