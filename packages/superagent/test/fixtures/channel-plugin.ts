// A channel plugin package for a real daemon, in the manner of packages/daemon/test/channel-targets.e2e.test.ts: an
// in-process adapter whose traffic goes through files in an exchange directory, so a test outside the daemon drives
// it. The test drops each inbound event as `in-<n>.json`; `history.json` holds the messages the reads answer from;
// every send is appended to `sent.jsonl` and every read to `reads.jsonl`.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHANNEL_CONFIG_SCHEMA,
  channelServiceCapabilities,
  managedServiceCapabilities,
} from '@agnes/extension-api'
import type {
  ChannelEvent,
  ChannelMessage,
  ChatTarget,
  MessageEvent,
} from '@agnes/extension-api/channel-contract'

export const CHANNEL_PACKAGE = '@acme/test-chat'
const manifest = {
  id: 'test-chat',
  displayName: 'Test chat',
  version: '0.1.0',
  connection: { modes: ['stream'], default: 'stream' },
  capabilities: {
    edit: false,
    card: false,
    thread: true,
    attachment: false,
    reactions: false,
    typing: false,
    voice: false,
  },
  credentials: {
    required: [],
    optional: [],
    exposes: ['kind', 'channel', 'accountId', 'userId', 'chatId', 'chatType'],
  },
  limits: { textChars: 4000, cardBytes: 65536, editWindowMs: 0 },
  events: { supported: ['message', 'groupJoin'] },
  directory: { supported: false, unit: 'dept' },
}

function source(exchange: string, instance: string, workspace: string, reads: boolean): string {
  return `
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const exchange = ${JSON.stringify(exchange)}
const manifest = ${JSON.stringify(manifest)}
const READS = ${reads ? '{ messages: true, threads: true, history: true, chats: true, members: true }' : 'undefined'}
const PAGE = 2
let sent = 0
const history = () => (existsSync(join(exchange, 'history.json')) ? JSON.parse(readFileSync(join(exchange, 'history.json'), 'utf8')) : [])
const record = (method, args) => appendFileSync(join(exchange, 'reads.jsonl'), JSON.stringify({ method, args }) + '\\n')
const page = (rows, cursor) => {
  const start = cursor === undefined ? 0 : Number(cursor)
  return { rows: rows.slice(start, start + PAGE), ...(start + PAGE < rows.length ? { cursor: String(start + PAGE) } : {}) }
}
const adapter = () => {
  let timer
  return {
    manifest,
    async connect(options) {
      timer = setInterval(() => {
        for (const file of readdirSync(exchange).filter((name) => /^in-.*\\.json$/.test(name)).sort()) {
          const event = JSON.parse(readFileSync(join(exchange, file), 'utf8'))
          rmSync(join(exchange, file))
          options.onEvent(event)
        }
      }, 50)
    },
    async disconnect() { clearInterval(timer) },
    toSession() { return null },
    resolveScope(event) { return { scope: event.chat.id, isDirectMessage: event.chat.type === 'dm' } },
    render() { return null },
    async send(target, message) {
      const messageId = 'om_sent' + ++sent
      appendFileSync(join(exchange, 'sent.jsonl'), JSON.stringify({ target, message, messageId }) + '\\n')
      return { chatId: target.chatId, messageId, chatType: 'group' }
    },
    async update() {},
    renderApproval() { return { blocks: [] } },
    onApprovalAction() { return null },
    credentialOf(event) {
      return { kind: 'channel', channel: manifest.id, accountId: event.accountId, userId: event.sender.userId, chatId: event.chat.id, chatType: event.chat.type }
    },
    capabilities() { return READS ? { ...manifest.capabilities, read: READS } : manifest.capabilities },
    ...(READS ? {
      async fetchMessages(chatId, ids) {
        record('fetchMessages', [chatId, ids])
        return history().filter((event) => event.chat.id === chatId && ids.includes(event.messageId))
      },
      async listThread(chatId, threadId, opts) {
        record('listThread', [chatId, threadId, opts])
        const rows = history()
          .filter((event) => event.chat.id === chatId && (event.chat.threadId === threadId || event.messageId === threadId))
          .sort((a, b) => (opts.order === 'asc' ? 1 : -1) * a.at.localeCompare(b.at))
        const { rows: events, cursor } = page(rows, opts.cursor)
        return { events, ...(cursor ? { cursor } : {}) }
      },
      async listHistory(chatId, opts) {
        record('listHistory', [chatId, { start: opts.start, end: opts.end }])
        const rows = history()
          .filter((event) => event.chat.id === chatId && event.at >= opts.start && event.at <= opts.end)
          .sort((a, b) => a.at.localeCompare(b.at))
        const { rows: events, cursor } = page(rows, opts.cursor)
        return { events, ...(cursor ? { cursor } : {}) }
      },
      async listChats(opts) {
        record('listChats', [])
        const { rows, cursor } = page([{ id: 'oc_team', name: 'Team' }], opts.cursor)
        return { chats: rows, ...(cursor ? { cursor } : {}) }
      },
      async listMembers(chatId, opts) {
        record('listMembers', [chatId])
        const { rows, cursor } = page([{ userId: 'ou_alice', displayName: 'Alice' }], opts.cursor)
        return { members: rows, ...(cursor ? { cursor } : {}) }
      },
    } : {}),
  }
}
export const main = {
  inject: ['profileRuntime', 'services', 'providers'],
  apply(ctx) {
    ctx.profileRuntime.registerChannel(
      { id: manifest.id, version: '1.0.0', manifest, create: adapter },
      { instances: [{ id: ${JSON.stringify(instance)}, workspace: ${JSON.stringify(workspace)}, agent: 'default', credentialRefs: {}, allowFrom: [], requireMention: true }] },
    )
  },
}
`
}

/**
 * Writes the channel plugin into `directory` with its exchange directory: one channel instance `instance` whose
 * adapter declares every read (`reads`), or none, as the released Feishu plugin does. Returns how a test drives it.
 */
export function writeChannelPlugin(
  directory: string,
  options: { instance: string; workspace: string; reads: boolean },
) {
  const exchange = join(directory, 'exchange')
  mkdirSync(exchange, { recursive: true })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: CHANNEL_PACKAGE,
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      exports: './index.mjs',
      agnes: {
        plugins: [
          {
            id: 'ext:acme/test-chat/main',
            export: 'main',
            apiRange: '^5.15.0',
            runtime: 'in-process',
            inject: ['profileRuntime', 'services', 'providers'],
            capabilities: {
              store: true,
              network: ['*'],
              services: [
                ...managedServiceCapabilities('channel', CHANNEL_CONFIG_SCHEMA),
                ...channelServiceCapabilities(),
              ],
              managedServices: [
                {
                  id: 'channel',
                  scope: 'profile',
                  artifact: { kind: 'in-process' },
                  healthPath: '/health',
                  listeners: [],
                  startupTimeoutMs: 30_000,
                  shutdownTimeoutMs: 5_000,
                  apiVersion: '1.0.0',
                  requires: [],
                },
              ],
            },
          },
        ],
      },
    }),
  )
  writeFileSync(
    join(directory, 'index.mjs'),
    source(exchange, options.instance, options.workspace, options.reads),
  )
  let inbound = 0
  const lines = <T>(file: string): T[] =>
    existsSync(join(exchange, file))
      ? readFileSync(join(exchange, file), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as T)
      : []
  const history: MessageEvent[] = []
  return {
    directory,
    /** Delivers an event through the adapter; a message is also kept in the history the reads answer from. */
    emit(event: ChannelEvent, keep = true) {
      if (keep && event.kind === 'message' && !history.some((item) => item.messageId === event.messageId)) {
        history.push(event)
        writeFileSync(join(exchange, 'history.json'), JSON.stringify(history))
      }
      const name = `in-${String(++inbound).padStart(4, '0')}.json`
      writeFileSync(join(exchange, `${name}.tmp`), JSON.stringify(event))
      renameSync(join(exchange, `${name}.tmp`), join(exchange, name))
    },
    sent: () => lines<{ target: ChatTarget; message: ChannelMessage; messageId: string }>('sent.jsonl'),
    reads: () => lines<{ method: string; args: unknown[] }>('reads.jsonl'),
  }
}
