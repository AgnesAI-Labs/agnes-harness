/** Real synthetic CLI processes; no daemon, model, AGH IM plugin or real Feishu account. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { consumeFeishu } from '../../src/app/feishu-stream.js'
import { workerProbe } from '../../src/deployment.js'
import { resolveFeishuBot } from '../../src/feishu-setup.js'
import { Commands, FeishuNotDispatched } from '../../src/infra/commands.js'
import { feishuReadTool } from '../../src/runtime/feishu-read-tool.js'
import { feishuTriggerId } from '../../src/sources/feishu.js'
import { nodeCommand } from '../fixtures/commands.js'
import { testDeployment } from '../fixtures/deployment.js'
import { BOT, cliMessage, liveEvent, message } from '../sources/fake-cli.js'
import { feishuHost } from '../sources/feishu-host.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const directory = () => {
  const root = mkdtempSync(join(tmpdir(), 'sa-cli-'))
  roots.push(root)
  return root
}
const until = async (read: () => boolean) => {
  const end = Date.now() + 10000
  while (!read()) {
    if (Date.now() > end) throw new Error('Synthetic CLI did not reach the expected state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
function botCli(root: string, stream: string, botId = BOT.botId) {
  return nodeCommand(
    join(root, 'lark-bot'),
    `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const log = ${JSON.stringify(join(root, 'calls'))}
appendFileSync(log, JSON.stringify(args) + '\\n')
const data = value => console.log(JSON.stringify({ ok: true, data: value }))
if (args[0] === 'auth') console.log(JSON.stringify({ appId: 'cli_app', brand: 'feishu', identities: { bot: { status: 'ready' } } }))
else if (args[0] === 'config') console.log('strict-mode: bot')
else if (args[2] === '/open-apis/bot/v3/info') console.log(JSON.stringify({ bot: { open_id: ${JSON.stringify(botId)}, app_name: 'Test bot' } }))
else if (args[0] === 'event') { ${stream} }
else if (args[1] === '+chat-list') data({ chats: [], has_more: false })
else if (args[2] === '/open-apis/im/v1/messages') data({ items: [], has_more: false })
else if (args[1] === '+messages-mget') data({ messages: [${JSON.stringify(cliMessage(message('om_1', { mentioned: true })))}] })
else if (args[1] === '+messages-reply') { let text = ''; for await (const chunk of process.stdin) text += chunk; appendFileSync(${JSON.stringify(join(root, 'reply'))}, text); data({ message_id: 'om_sent' }) }
else process.exit(2)
`,
  )
}
it('validates a bot wrapper, receives a request, creates and continues one ticket, reads and replies through that CLI', async () => {
  const root = directory(),
    life = new AbortController()
  const first = { ...liveEvent(message('om_1', { mentioned: true })), create_time: new Date().toISOString() }
  const second = {
    ...liveEvent(message('om_2', { quoted: 'om_1', text: 'also the header' })),
    create_time: new Date().toISOString(),
  }
  const cli = botCli(
    root,
    `const marker = ${JSON.stringify(join(root, 'connected'))}; const initial = !existsSync(marker); writeFileSync(marker, '1'); console.error('[event] ready'); console.log(${JSON.stringify(JSON.stringify(first))}); setTimeout(() => console.log(${JSON.stringify(JSON.stringify(second))}), 500); setTimeout(() => console.log(${JSON.stringify(JSON.stringify(first))}), 600); if (initial) setTimeout(() => process.exit(1), 800); setInterval(() => {}, 1000)`,
  )
  const deployment = {
    ...testDeployment(),
    stateDir: root,
    feishu: await resolveFeishuBot(
      { stateDir: root } as never,
      { cli },
      workerProbe(root, root, life.signal),
    ),
  }
  const commands = new Commands(() => deployment, { HOME: root }, life.signal)
  const h = feishuHost({ deployment, commands, feishu: { cli } })
  const running = h.run(life.signal)
  try {
    await until(() => !!h.trigger('om_1'))
    const decision = h.engine.decide(feishuTriggerId('om_1'), {
      kind: 'accept',
      title: 'Fix title',
      scope: 'title',
      reason: 'requested',
    })
    const ticket = h.store.tickets.get(decision.ticketId!)!
    expect(ticket).toBeDefined()
    const tool = feishuReadTool(
      {
        store: h.store,
        io: () => ({ commands, bot: deployment.feishu, stateDir: root, assertCurrent() {} }),
      },
      ticket,
    )
    expect(
      await tool.execute({ chat_id: 'oc_team', message_ids: ['om_1'], order: 'asc', limit: 20 }, life.signal),
    ).toMatchObject({ messages: [{ id: 'om_1' }] })
    const outbound = {
      id: 'reply-key',
      kind: 'reply' as const,
      text: 'Acknowledged',
      channel: h.trigger('om_1')!.channel!,
    }
    expect(await h.kind.channel!.send({ commands }, outbound)).toBe('sent')
    expect(await h.kind.channel!.send({ commands }, outbound)).toBe('sent')
    expect(readFileSync(join(root, 'reply'), 'utf8')).toBe('Acknowledged')
    await until(() => !!h.trigger('om_2'))
    expect(h.trigger('om_2')?.threads).toEqual(h.trigger('om_1')?.threads)
    expect(h.store.threads.get('feishu:oc_team:om_1')?.subscriptions).toContain(ticket.id)
    await until(
      () =>
        h.link.listening &&
        readFileSync(join(root, 'calls'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[])
          .filter((args) => args[0] === 'event').length >= 2,
    )
    expect(h.store.read.threadTriggers('feishu:oc_team:om_1', 20)).toHaveLength(2)
    // A changed same-path wrapper must not read using the old deployment identity.
    botCli(root, '', 'ou_changed')
    await expect(commands.lark(['im', '+messages-mget', '--message-ids', 'om_1'])).rejects.toBeInstanceOf(
      FeishuNotDispatched,
    )
    const saved = h.store.settings()
    h.store.saveSettings({
      ...saved,
      sources: { ...saved.sources, feishu: { enabled: false, config: { cli } } },
    })
    await until(() => !h.link.listening)
  } finally {
    life.abort()
    await running
    h.close()
  }
}, 30000)

it('rejects missing, signed-out, non-bot and malformed identities without retaining CLI diagnostics', async () => {
  const root = directory(),
    cli = nodeCommand(join(root, 'fake'), '')
  const machine = { stateDir: root } as never
  await expect(resolveFeishuBot(machine, {}, async () => '')).rejects.toMatchObject({
    code: 'feishuCliUnset',
  })
  await expect(
    resolveFeishuBot(machine, { cli: join(root, 'absent') }, async () => ''),
  ).rejects.toMatchObject({ code: 'feishuCliMissing' })
  for (const mode of ['signedOut', 'user', 'badBot']) {
    const probe = async (args: string[]) => {
      if (args[1] === 'auth')
        return JSON.stringify({
          appId: 'cli_app',
          identities: { bot: { status: mode === 'signedOut' ? 'expired' : 'ready' } },
        })
      if (args[1] === 'config') return `strict-mode: ${mode === 'user' ? 'user' : 'bot'}`
      return 'credential-secret-marker'
    }
    await expect(resolveFeishuBot(machine, { cli }, probe)).rejects.toMatchObject({
      code:
        mode === 'signedOut' ? 'feishuBotNotReady' : mode === 'user' ? 'feishuUserIdentity' : 'feishuNoBot',
    })
  }
  await expect(
    resolveFeishuBot(machine, { cli }, async () => {
      throw new Error('credential-secret-marker')
    }),
  ).rejects.not.toThrow('credential-secret-marker')
})
it.each(['timeout', 'line', 'queue'])(
  'bounds consumer %s and redacts its diagnostics',
  async (kind) => {
    const root = directory(),
      controller = new AbortController()
    const body =
      kind === 'timeout'
        ? "console.error('TOKEN=secret'); setInterval(() => {}, 1000)"
        : kind === 'line'
          ? "console.error('[event] ready'); process.stdout.write('x'.repeat(1100000)); setInterval(() => {}, 1000)"
          : "console.error('[event] ready'); setTimeout(() => { for (let i=0;i<200;i++) console.log('{}') }, 20); setInterval(() => {}, 1000)"
    const cli = nodeCommand(join(root, 'stream'), body)
    const pending = consumeFeishu({
      cli,
      signal: controller.signal,
      readyMs: kind === 'timeout' ? 500 : 3000,
      graceMs: 50,
      ready() {},
      warning() {},
      receive: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
      },
    })
    await expect(pending).rejects.toThrow(
      kind === 'timeout' ? 'deadline' : kind === 'line' ? 'byte limit' : 'queue exceeded',
    )
  },
  5000,
)
it('buffers an event before readiness and aborts the owned process tree including a stubborn descendant', async () => {
  const root = directory(),
    controller = new AbortController(),
    pidfile = join(root, 'pid')
  const cli = nodeCommand(
    join(root, 'stream'),
    `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const c = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' }); writeFileSync(${JSON.stringify(pidfile)}, String(c.pid)); console.log('{}'); setTimeout(() => console.error('[event] ready'), 100); setInterval(()=>{},1000)`,
  )
  let received = false
  await consumeFeishu({
    cli,
    signal: controller.signal,
    graceMs: 100,
    ready() {},
    warning() {},
    async receive() {
      received = true
      controller.abort()
    },
  })
  expect(received).toBe(true)
  const pid = Number(readFileSync(pidfile, 'utf8'))
  await until(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  })
}, 15000)
