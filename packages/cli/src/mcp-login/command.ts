import { createInterface } from 'node:readline'
import type { NodeClient } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import { type McpLoginUi, mcpLoginFailureText, runMcpLogin, runMcpLogout } from './run.js'

type Stream = NodeJS.WritableStream & { isTTY?: boolean }
type CommandIO = Readonly<{
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: Stream
  stderr: Stream
}>

const SERVER = /^[a-z][a-z0-9._-]{0,127}$/
const PROFILE = /^[a-z][a-z0-9._-]{0,127}$/

/** `agh mcp login|logout <serverId> [--profile <name>]`. */
export async function runMcpLoginCommand(input: {
  action: 'login' | 'logout'
  args: readonly string[]
  io: CommandIO
  boot(
    profile: string | undefined,
  ): Promise<Readonly<{ client: NodeClient; profileName: string; close(): Promise<void> }>>
  fetchImpl?: Parameters<typeof runMcpLogin>[0]['fetchImpl']
  openBrowser?: (url: string) => void
}): Promise<number> {
  const { action, io } = input
  const { serverId, profile } = parseArgs(action, input.args)
  const booted = await input.boot(profile)
  try {
    const target = { client: booted.client, profile: profile ?? booted.profileName, serverId }
    if (action === 'logout') {
      await runMcpLogout(target)
      io.stdout.write(`Signed out of ${serverId}.\n`)
      return ExitCode.OK
    }
    const cancel = new AbortController()
    const outcome = await runMcpLogin({
      ...target,
      ui: terminalUi(io, cancel),
      signal: cancel.signal,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.openBrowser ? { openBrowser: input.openBrowser } : {}),
    })
    if (outcome.kind === 'cancelled') {
      io.stderr.write('Sign-in cancelled.\n')
      return ExitCode.ERROR
    }
    if (outcome.kind === 'timed-out') {
      io.stderr.write('Sign-in timed out after 5 minutes.\n')
      return ExitCode.TIMEOUT
    }
    io.stdout.write(
      `${outcome.kind === 'signed-in' ? 'Signed in to' : 'Already signed in to'} ${serverId}.\n`,
    )
    if (outcome.reconnectFailed === undefined) return ExitCode.OK
    io.stderr.write(
      `The sign-in is saved, but reconnecting ${serverId} failed: ${outcome.reconnectFailed}. Run agh mcp status ${serverId} to see why.\n`,
    )
    return ExitCode.ERROR
  } catch (error) {
    io.stderr.write(`agh mcp ${action}: ${mcpLoginFailureText(serverId, error)}\n`)
    return ExitCode.ERROR
  } finally {
    await booted.close().catch(() => undefined)
  }
}

function parseArgs(action: string, args: readonly string[]): { serverId: string; profile?: string } {
  const usage = `usage: agh mcp ${action} <serverId> [--profile <name>]`
  const positional: string[] = []
  let profile: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--profile') {
      profile = args[++i]
      if (profile === undefined || !PROFILE.test(profile)) throw new UsageError(`${usage}: invalid profile`)
    } else if (arg.startsWith('-')) throw new UsageError(usage)
    else positional.push(arg)
  }
  const [serverId] = positional
  if (positional.length !== 1 || serverId === undefined) throw new UsageError(usage)
  if (!SERVER.test(serverId)) throw new UsageError(`${usage}: invalid server id`)
  return { serverId, ...(profile ? { profile } : {}) }
}

/**
 * The address goes to stdout, everything else to stderr. Only a terminal on both ends can paste;
 * otherwise the sign-in waits for the browser and says how to reach the callback from elsewhere.
 */
function terminalUi(io: CommandIO, cancel: AbortController): McpLoginUi {
  const interactive = io.stdin.isTTY === true && io.stdout.isTTY === true
  return {
    show({ serverId, authorizationUrl }) {
      io.stdout.write(`Sign in to ${serverId} in your browser:\n${authorizationUrl}\n`)
      const redirect = new URL(authorizationUrl).searchParams.get('redirect_uri') ?? ''
      const port = URL.canParse(redirect) ? new URL(redirect).port : ''
      io.stderr.write(
        interactive
          ? 'Finish the sign-in in the browser. If the browser is on another machine, paste the address it ends on here.\n'
          : `Waiting for the browser to return to ${redirect}. If the browser runs on another machine, forward that port first (ssh -L ${port}:localhost:${port} <this host>), or run this command in an interactive terminal (ssh -t) to paste the address instead.\n`,
      )
    },
    paste(signal) {
      if (!interactive) return Promise.resolve(undefined)
      return new Promise((resolve) => {
        const prompt = createInterface({ input: io.stdin, output: io.stderr, terminal: true })
        const finish = (text: string | undefined) => {
          signal.removeEventListener('abort', stop)
          resolve(text)
          prompt.close()
        }
        const stop = () => finish(undefined)
        signal.addEventListener('abort', stop, { once: true })
        // End of input or Ctrl-C cancels, like an empty line.
        prompt.once('close', () => resolve(''))
        prompt.on('SIGINT', () => {
          finish('')
          cancel.abort()
        })
        prompt.question('Address (empty line cancels): ', (answer) => finish(answer))
      })
    },
    progress(text) {
      io.stderr.write(`${text}…\n`)
    },
  }
}
