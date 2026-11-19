// A Feishu Source over a synthetic bot CLI, on a real store, registry and engine.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { type SourceContextDeps, sourceContextOf } from '../../src/app/source-context.js'
import { Store } from '../../src/app/store.js'
import { type Assessor, Engine, type Executor, type Trigger } from '../../src/core/index.js'
import type { Commands } from '../../src/infra/commands.js'
import { HealthBoard } from '../../src/infra/health.js'
import { SettingsSchema, settingsPolicy } from '../../src/policy.js'
import { feishuTriggerId, registerFeishu } from '../../src/sources/feishu.js'
import { feishuLink } from '../../src/sources/feishu-io.js'
import { githubKind } from '../../src/sources/github.js'
import type { SourceHost } from '../../src/sources/host.js'
import { SourceRegistry } from '../../src/sources/registry.js'
import { testDeployment } from '../fixtures/deployment.js'
import { BOT, fakeCli } from './fake-cli.js'

export const MEMBER = 'ou_alice'
export type FeishuHost = ReturnType<typeof feishuHost>
/**
 * The Feishu Source registered on `fake` (default: every read) with chats `oc_team` (@ only) and `oc_observed` (all),
 * Alice allowed, the bot `cli_ci` listed, and Eval in `auto` mode. `close()` removes everything.
 */
export function feishuHost(
  options: {
    fake?: ReturnType<typeof fakeCli>
    commands?: Commands
    deployment?: ReturnType<typeof testDeployment>
    feishu?: Record<string, unknown>
    policy?: Record<string, unknown>
    configured?: () => boolean
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-source-'))
  const store = new Store(join(directory, 'db.sqlite'))
  store.saveSettings(
    SettingsSchema.parse({
      policy: {
        sources: {
          feishu: {
            allowed: [{ id: MEMBER, name: 'Alice' }],
            syncChat: 'oc_team',
            bots: [{ id: 'cli_ci', name: 'CI' }],
            ...options.policy,
          },
          github: { allowed: [{ id: 'alice' }] },
        },
      },
      eval: { mode: 'auto' },
      sources: {
        feishu: {
          enabled: true,
          config: {
            cli: BOT.cli,
            chats: [
              { chatId: 'oc_team', listen: 'mentions' },
              { chatId: 'oc_observed', listen: 'all' },
            ],
            ...options.feishu,
          },
        },
      },
    }),
  )
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(githubKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = {
    start: vi.fn(async () => {}),
    deliver: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({
    repo: store,
    scope: sources,
    policy: () => settingsPolicy(store.settings(), sources),
    assessor,
    executor,
    outbox,
  })
  const receive = vi.fn(async (trigger: Trigger) => {
    const result = engine.receive(trigger)
    engine.evaluateDue()
    return result
  })
  const fake = options.fake ?? fakeCli()
  const deployment = options.deployment ?? { ...testDeployment(), feishu: { ...BOT } }
  const deps: SourceContextDeps = {
    store,
    engine,
    outbox: { send: (message) => void store.receipts.add(message) },
    commands: options.commands ?? fake.commands,
    sources,
    deployment,
    ready: Promise.resolve(),
    configured: options.configured ?? (() => true),
    receive,
  }
  const host: SourceHost = { sources, context: (kind) => sourceContextOf(deps, kind) }
  const logs: string[] = []
  const link = feishuLink((line) => logs.push(line))
  const registered = registerFeishu(host, link)
  return {
    store,
    deployment,
    engine,
    sources,
    host,
    fake,
    link,
    logs,
    receive,
    assessor,
    executor,
    ctx: registered.context,
    kind: registered.kind,
    health: board.all,
    run: registered.run,
    /** The Trigger stored for a Feishu message id. */
    trigger: (messageId: string) => store.triggers.get(feishuTriggerId(messageId)),
    close() {
      registered.unregister()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
