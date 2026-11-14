import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelInstance, ChannelProvider, ProfileManagedInit } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import type { MessageEvent } from '../src/adapter.js'
import type { RunnerConfig } from '../src/runner/config.js'
import { createFakeClient, FAKE_MANIFEST, FakeChannel } from '../testkit/index.js'

/** One channel row over the fake adapter and client, for tests that start the real bridge. */
export async function bridgeFixture(cleanups: (() => Promise<unknown>)[]) {
  const root = await mkdtemp(join(tmpdir(), 'agh-channel-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const stored = new Map<string, JsonValue>()
  let shutdown: Parameters<ProfileManagedInit['onShutdown']>[0] | undefined
  const instance: ChannelInstance = {
    id: 'first',
    workspace: root,
    agent: '@example/agent#main',
    credentialRefs: {},
    allowFrom: [],
    requireMention: true,
  }
  const init = {
    store: {
      scan: ({ prefix, limit, cursor }: { prefix: string; limit: number; cursor?: string }) => {
        const rows = [...stored]
          .filter(([key]) => key.startsWith(prefix) && (!cursor || key > cursor))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => ({ key, value }))
        return {
          rows: rows.slice(0, limit),
          ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.key } : {}),
        }
      },
      delete: (key: string) => stored.delete(key),
      transaction: <T>(work: () => T) => work(),
      get: (key: string) => stored.get(key),
      set: (key: string, value: JsonValue) => stored.set(key, structuredClone(value)),
    },
    signal: new AbortController().signal,
    config: { instances: [instance] },
    assertCurrent: () => {},
    ready: () => {},
    onShutdown: (fn: typeof shutdown) => {
      shutdown = fn
    },
  } as unknown as ProfileManagedInit
  const adapters: FakeChannel[] = []
  const clients: ReturnType<typeof createFakeClient>[] = []
  const provider: ChannelProvider = {
    id: 'fake',
    version: '1.0.0',
    manifest: FAKE_MANIFEST,
    create() {
      const adapter = new FakeChannel()
      adapters.push(adapter)
      return adapter
    },
  }
  const options = {
    owner: 'plugin/example',
    stateDirectory: join(root, 'state'),
    resolveSecret: () => 'synthetic-secret',
    createClient: (_config: RunnerConfig) => {
      const client = createFakeClient()
      clients.push(client)
      return client
    },
    log: { info() {}, warn() {}, error() {} },
  }
  cleanups.push(async () => shutdown?.('disable'))
  return {
    root,
    init,
    options,
    provider,
    adapters,
    clients,
    stop: async () => shutdown?.('disable'),
  }
}

let counter = 0
/** A mentioned text message; `chat` and `sender` default to a group and an ordinary user. */
export function groupMessage(text: string, extra: Partial<MessageEvent> = {}): MessageEvent {
  counter += 1
  return {
    kind: 'message',
    eventId: `event-${counter}`,
    messageId: `message-${counter}`,
    accountId: 'account',
    text,
    attachments: [],
    at: new Date().toISOString(),
    chat: { id: 'group-a', type: 'group' },
    sender: { userId: 'user', raw: {} },
    mentions: { bot: true, replyToBot: false, quoteBot: false },
    ...extra,
  }
}
