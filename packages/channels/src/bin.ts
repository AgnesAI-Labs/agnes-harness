#!/usr/bin/env -S pnpm exec tsx
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChannelAdapter } from './adapter.js'
import { ChannelError, isChannelError } from './errors.js'
import { loadManifest } from './manifest.js'
import { createChannelClient } from './runner/client.js'
import {
  type Connect,
  loadConfig,
  loadSecrets,
  parseConnect,
  type RunnerConfig,
  redact,
  validateLocalDaemonTarget,
} from './runner/config.js'
import { createRunner, type Runner, type RunnerDeps } from './runner/runner.js'
import { installShutdown } from './runner/shutdown.js'
import { createRunnerSupervisor } from './runner/supervisor.js'

const USAGE =
  'usage: agnes-channel <id> --config <file> [--connect <target>] [--tenant <id>] [--agent <id>] [--verify] [--verify-live]'

type Writable = { write(chunk: string): unknown }
type Signals = {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export type ChannelMainIO = {
  stdout: Writable
  stderr: Writable
  signals: Signals
  exit(code: number): void
}

export type ChannelMainDeps = {
  loadConfig(path: string): Promise<RunnerConfig>
  loadManifest: typeof loadManifest
  loadSecrets: typeof loadSecrets
  createAdapter(id: string, manifestPath: string): Promise<ChannelAdapter>
  createClient(config: RunnerConfig, id: string): RunnerDeps['client']
  createRunner(dependencies: RunnerDeps): Runner
  verifyLive(argv: string[]): Promise<number>
}

type ParsedArgs = {
  id: string
  configPath: string
  verify: boolean
  verifyLive: boolean
  connect?: string
  tenant?: string
  agent?: string
  liveArgs: string[]
}

const defaultIO: ChannelMainIO = {
  stdout: process.stdout,
  stderr: process.stderr,
  signals: process,
  exit(code) {
    process.exit(code)
  },
}

const defaultDeps: ChannelMainDeps = {
  loadConfig,
  loadManifest,
  loadSecrets,
  async createAdapter(id, manifestPath) {
    if (id !== 'dingtalk') throw new ChannelError('E_CONFIG_INVALID', `unknown channel ${id}`)
    return (await import('./adapters/dingtalk/index.js')).default(manifestPath)
  },
  createClient: createChannelClient,
  createRunner,
  async verifyLive(argv) {
    return (await import('../scripts/dingtalk-verify.js')).main(argv)
  },
}

export async function main(
  argv: string[],
  io: ChannelMainIO = defaultIO,
  dependencies: ChannelMainDeps = defaultDeps,
): Promise<number> {
  let secrets: Record<string, string> = {}
  try {
    const args = parseArgs(argv)
    if (args.id !== 'dingtalk') {
      throw new ChannelError('E_CONFIG_INVALID', `unknown channel ${args.id}`)
    }
    if (args.verifyLive) {
      return dependencies.verifyLive(args.liveArgs)
    }

    const manifestPath = fileURLToPath(new URL(`./adapters/${args.id}/channel.json`, import.meta.url))
    const config = await dependencies.loadConfig(args.configPath)
    if (config.channel !== args.id) {
      throw new ChannelError(
        'E_CONFIG_INVALID',
        `config channel ${config.channel} does not match requested channel ${args.id}`,
      )
    }
    applyOverrides(config, args)
    validateLocalDaemonTarget(config)
    const manifest = await dependencies.loadManifest(manifestPath)
    secrets = await dependencies.loadSecrets(config.credentialsFile, manifest)
    if (args.verify) {
      io.stdout.write(`ok: ${manifest.id} ${manifest.version}\n`)
      return 0
    }

    const log = logger(io.stderr, secrets)
    const refsPath = join(
      process.env.AGNES_CHANNEL_STATE_DIR ?? join(dirname(args.configPath), 'state'),
      args.id,
      'refs.sqlite',
    )
    const supervisor = createRunnerSupervisor(async () => {
      const adapter = await dependencies.createAdapter(args.id, manifestPath)
      const client = dependencies.createClient(config, args.id)
      const runner = dependencies.createRunner({ adapter, cfg: config, secrets, client, log, refsPath })
      return { client, runner }
    }, log)
    await supervisor.start()
    installShutdown(supervisor, {
      drainMs: 5_000,
      exit: io.exit,
      signalSource: io.signals,
    })
    return -1
  } catch (error) {
    const message = isChannelError(error)
      ? error.message
      : 'E_CONNECT_FAILED: channel startup failed; inspect redacted runner logs'
    io.stderr.write(`${redact(secrets, message)}\n`)
    return 2
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const id = argv[0]
  if (id === undefined || id.length === 0 || id.startsWith('-')) {
    throw new ChannelError('E_CONFIG_INVALID', USAGE)
  }
  let configPath: string | undefined
  let connect: string | undefined
  let tenant: string | undefined
  let agent: string | undefined
  let verify = false
  let verifyLive = false
  const liveArgs: string[] = []
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index]
    if (option === '--verify') {
      verify = true
      continue
    }
    if (option === '--verify-live') {
      verifyLive = true
      continue
    }
    if (option === '--simulate-disconnect') {
      liveArgs.push(option)
      continue
    }
    if (!['--config', '--connect', '--tenant', '--agent', '--chat', '--timeout'].includes(option ?? '')) {
      throw new ChannelError('E_CONFIG_INVALID', `unknown option ${option ?? ''}`)
    }
    const value = argv[++index]
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new ChannelError('E_CONFIG_INVALID', `${option} requires a value`)
    }
    if (option === '--config') configPath = value
    else if (option === '--connect') connect = value
    else if (option === '--tenant') tenant = value
    else if (option === '--agent') agent = value
    else liveArgs.push(option as string, value)
  }
  if (configPath === undefined) throw new ChannelError('E_CONFIG_INVALID', '--config is required')
  if (verify && verifyLive) {
    throw new ChannelError('E_CONFIG_INVALID', '--verify and --verify-live are mutually exclusive')
  }
  if (!verifyLive && liveArgs.length > 0) {
    throw new ChannelError(
      'E_CONFIG_INVALID',
      '--chat, --timeout and --simulate-disconnect require --verify-live',
    )
  }
  if (verifyLive && (connect !== undefined || tenant !== undefined || agent !== undefined)) {
    throw new ChannelError(
      'E_CONFIG_INVALID',
      '--verify-live does not accept --connect, --tenant or --agent overrides',
    )
  }
  liveArgs.unshift('--config', configPath)
  return {
    id,
    configPath,
    verify,
    verifyLive,
    liveArgs,
    ...(connect === undefined ? {} : { connect }),
    ...(tenant === undefined ? {} : { tenant }),
    ...(agent === undefined ? {} : { agent }),
  }
}

function applyOverrides(config: RunnerConfig, args: ParsedArgs): void {
  if (args.connect !== undefined) config.connect = parseConnectOverride(args.connect)
  if (args.tenant !== undefined) config.tenant = args.tenant
  if (args.agent !== undefined) config.agent = args.agent
}

function parseConnectOverride(value: string): Connect {
  try {
    return parseConnect(value)
  } catch {
    throw new ChannelError('E_CONFIG_INVALID', '--connect must be unix:<path> or ws[s]://<host>')
  }
}

function logger(output: Writable, secrets: Record<string, string>): RunnerDeps['log'] {
  const write = (level: string, message: string, meta?: Record<string, unknown>): void => {
    const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`
    output.write(`${redact(secrets, `[${level}] ${message}${suffix}`)}\n`)
  }
  return {
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main(process.argv.slice(2)).then((exitCode) => {
    if (exitCode >= 0) process.exitCode = exitCode
  })
}
