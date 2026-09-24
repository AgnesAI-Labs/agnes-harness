#!/usr/bin/env tsx
import { fileURLToPath } from 'node:url'
import type {
  DingtalkGateway,
  DingtalkTarget,
  RawCardCallback,
  RawRobotMessage,
} from '../src/adapters/dingtalk/gateway.js'
import { createRealGateway } from '../src/adapters/dingtalk/gateway-real.js'
import { loadManifest } from '../src/manifest.js'
import { loadConfig, loadSecrets } from '../src/runner/config.js'

export type VerifyArgs = {
  config: string
  chat?: string
  simulateDisconnect: boolean
  timeoutMs: number
}
export type VerifyResult = { ok: true; detail?: string } | { ok: false; reason: string }

export function parseVerifyArgs(argv: string[]): VerifyArgs {
  const values = new Map<string, string>()
  let simulateDisconnect = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--simulate-disconnect') {
      simulateDisconnect = true
      continue
    }
    if (arg !== '--config' && arg !== '--chat' && arg !== '--timeout') {
      throw new Error(`unknown verification option: ${arg ?? ''}`)
    }
    const value = argv[++index]
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`)
    }
    values.set(arg.slice(2), value)
  }
  const config = values.get('config')
  if (config === undefined) throw new Error('--config required')
  const timeoutMs = Number(values.get('timeout') ?? 120_000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new Error('--timeout must be an integer from 1 through 600000 milliseconds')
  }
  const chat = values.get('chat')
  return { config, ...(chat === undefined ? {} : { chat }), simulateDisconnect, timeoutMs }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout after ${timeoutMs} ms waiting for ${what}`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : 'verification failed')

export async function verifyInbound(gateway: DingtalkGateway, timeoutMs: number): Promise<VerifyResult> {
  const incoming = deferred<RawRobotMessage>()
  const controller = new AbortController()
  try {
    await gateway.start(
      {
        onMessage: (message) => {
          if (
            message.conversationType === '2' &&
            (message.isInAtList || (message.atUsers ?? []).length > 0)
          ) {
            incoming.resolve(message)
          }
        },
        onCard: () => undefined,
        onDisconnect: () => undefined,
      },
      controller.signal,
    )
    const message = await withTimeout(incoming.promise, timeoutMs, 'a group @mention')
    return { ok: true, detail: `msgId=${message.msgId} conversationType=${message.conversationType}` }
  } catch (error) {
    return { ok: false, reason: reason(error) }
  } finally {
    controller.abort()
    await gateway.stop().catch(() => undefined)
  }
}

export async function verifyCard(
  gateway: DingtalkGateway,
  target: DingtalkTarget,
  timeoutMs: number,
): Promise<VerifyResult> {
  const outTrackId = `agnes-verify-${Date.now()}`
  const callback = deferred<RawCardCallback>()
  const controller = new AbortController()
  try {
    await gateway.start(
      {
        onMessage: () => undefined,
        onCard: (event) => {
          if (event.outTrackId === outTrackId) callback.resolve(event)
        },
        onDisconnect: () => undefined,
      },
      controller.signal,
    )
    await gateway.createCard(
      outTrackId,
      {
        cardParamMap: {
          title: 'Agnes 核验',
          markdown: '请点击下面的确认按钮',
          buttons: JSON.stringify([{ text: '确认', value: 'verify:ok', color: 'blue' }]),
        },
      },
      target,
    )
    const event = await withTimeout(callback.promise, timeoutMs, 'the card button callback')
    return { ok: true, detail: `userId=${event.userId}` }
  } catch (error) {
    return { ok: false, reason: reason(error) }
  } finally {
    controller.abort()
    await gateway.stop().catch(() => undefined)
  }
}

export async function verifyReconnect(
  gateway: DingtalkGateway,
  options: { simulate: boolean; waitMs: number },
): Promise<VerifyResult> {
  const handlers = {
    onMessage: () => undefined,
    onCard: () => undefined,
    onDisconnect: () => undefined,
  }
  let controller = new AbortController()
  try {
    await gateway.start(handlers, controller.signal)
    if (!options.simulate) {
      process.stdout.write(`请在 ${Math.round(options.waitMs / 1_000)} 秒内断开网络再恢复……\n`)
      await new Promise((resolve) => setTimeout(resolve, options.waitMs))
    }
    controller.abort()
    await gateway.stop()
    if (options.simulate) await new Promise((resolve) => setTimeout(resolve, options.waitMs))
    controller = new AbortController()
    await gateway.start(handlers, controller.signal)
    return { ok: true, detail: options.simulate ? 'simulated stop/start' : 'restart after outage succeeded' }
  } catch (error) {
    return { ok: false, reason: `restart after outage failed: ${reason(error)}` }
  } finally {
    controller.abort()
    await gateway.stop().catch(() => undefined)
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseVerifyArgs(argv)
  const config = await loadConfig(args.config)
  const manifest = await loadManifest(
    fileURLToPath(new URL('../src/adapters/dingtalk/channel.json', import.meta.url)),
  )
  const secrets = await loadSecrets(config.credentialsFile, manifest)
  const gateway = createRealGateway({
    ...(secrets.cardTemplateId === undefined ? {} : { cardTemplateId: secrets.cardTemplateId }),
  })
  gateway.setCredentials({
    clientId: secrets.clientId as string,
    clientSecret: secrets.clientSecret as string,
    ...(secrets.robotCode === undefined ? {} : { robotCode: secrets.robotCode }),
  })
  const results: Array<[string, VerifyResult]> = []
  results.push(['① 收一条群 @', await verifyInbound(gateway, args.timeoutMs)])
  if (args.chat !== undefined) {
    results.push([
      '② 发卡片并收按钮回调',
      await verifyCard(gateway, { conversationId: args.chat, conversationType: '2' }, args.timeoutMs),
    ])
  } else {
    results.push(['② 发卡片并收按钮回调', { ok: false, reason: '--chat required for card verification' }])
  }
  results.push([
    '③ 断网重连',
    await verifyReconnect(gateway, { simulate: args.simulateDisconnect, waitMs: 60_000 }),
  ])
  for (const [name, result] of results) {
    process.stdout.write(
      `${result.ok ? 'PASS' : 'FAIL'} ${name} ${result.ok ? (result.detail ?? '') : result.reason}\n`,
    )
  }
  return results.every(([, result]) => result.ok) ? 0 : 1
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().then((exitCode) => {
    process.exitCode = exitCode
  })
}
