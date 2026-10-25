import { AGNES_ERRORS, JSONRPC_ERRORS, publicErrorHelp } from '@agnes/protocol'
import {
  isResourceOperationFailure,
  ResourceUsageError,
  resourceOperationFailureWasRendered,
} from '@agnes/resource-control-cli'
import { TransportClosed } from '@agnes/sdk'
import { BootError, CommandError, ExitCode, UsageError } from './errors.js'
import { resolveLocale } from './tui/locale.js'

// Split from bin.ts so `agh --help` does not load the protocol, SDK and resource-control modules
// that only a failing command needs to word its error.

/** The resource command layer only raises these for backend-confirmed terminal outcomes. */
export function safeResourceFailureLine(error: unknown): string | undefined {
  if (!isResourceOperationFailure(error)) return undefined
  return `${error.code}: ${error.message} operation ${error.operationId}`
}

/** A daemon disappearing during a client command is operational, not a CLI programming failure. */
export function safeDaemonDisconnectLine(error: unknown): string | undefined {
  const kind = (error as { kind?: unknown } | null)?.kind
  if (!(error instanceof TransportClosed) && kind !== 'transport-closed') return undefined
  // The daemon names why it ended the connection; match the fixed code only, never its message.
  const cause = (error as { info?: { error?: { code?: unknown; data?: { code?: unknown } } } }).info?.error
  if (cause?.code === AGNES_ERRORS.OVERLOADED && cause.data?.code === 'OVERLOADED')
    return 'DAEMON_OVERLOADED: local Daemon closed the connection because this command fell behind reading it; retry the command, and report it if it persists.'
  return 'DAEMON_CONNECTION_CLOSED: local Daemon connection closed; retry the command.'
}

type RpcFailureShape = Readonly<{
  kind?: unknown
  code?: unknown
  data?: Readonly<{ code?: unknown }>
}>

/**
 * These are the only confirmed resource-operation JSON-RPC outcomes that can occur while a local
 * command is finishing. Match their wire shape so the handling survives the local/SEA bundle edge;
 * do not interpolate server messages or data because either can contain untrusted diagnostics.
 */
export function safeExpectedResourceRpcFailureLine(error: unknown): string | undefined {
  const value = error as RpcFailureShape | null
  if (value?.kind !== 'json-rpc') return undefined
  if (value.code === JSONRPC_ERRORS.INVALID_REQUEST && value.data?.code === 'SHUTTING_DOWN')
    return 'DAEMON_SHUTTING_DOWN: local Daemon is shutting down; retry the command.'
  if (value.code === AGNES_ERRORS.SEMANTIC_REJECTED && value.data?.code === 'RESOURCE_OPERATION_TERMINAL')
    return 'RESOURCE_OPERATION_TERMINAL: resource operation has already reached a terminal state.'
  return undefined
}

/**
 * Refusals a session command meets because of what the operator asked for or has configured: a
 * `--model`/`--preset` this profile does not carry, or a home with no provider at all. Each gets
 * one fixed line saying what to do next. Same rule as above: the server's message and data are not
 * interpolated.
 */
export function safeExpectedSessionRpcFailureLine(error: unknown): string | undefined {
  const value = error as RpcFailureShape | null
  if (value?.kind !== 'json-rpc') return undefined
  if (value.code === AGNES_ERRORS.PRESET_SWITCH_REJECTED)
    return 'PRESET_SWITCH_REJECTED: the requested preset or model is not available in this profile; `agh doctor provider` lists the configured routes.'
  if (value.code === AGNES_ERRORS.SEMANTIC_REJECTED && value.data?.code === 'PROVIDER_UNCONFIGURED')
    return 'PROVIDER_UNCONFIGURED: no model provider is configured for this profile; run `agh config` to add one.'
  if (value.code === AGNES_ERRORS.SEMANTIC_REJECTED && value.data?.code === 'LEGACY_LEDGER_FORMAT')
    return 'LEGACY_LEDGER_FORMAT: this session was created by an older version and cannot be opened by this one; start a new session.'
  return undefined
}

/** The exit code and stderr line for a command that threw; no server text or stack reaches stderr. */
export function reportCommandFailure(
  e: unknown,
  command: string | undefined,
  io: { env: NodeJS.ProcessEnv; stderr: NodeJS.WritableStream },
): number {
  const help = publicErrorHelp(e, resolveLocale(io.env))
  if (help) {
    io.stderr.write(`${help.code}: ${help.reason} ${help.action}\n`)
    return ExitCode.ERROR
  }
  const safeFailure =
    safeResourceFailureLine(e) ??
    safeExpectedResourceRpcFailureLine(e) ??
    safeExpectedSessionRpcFailureLine(e) ??
    safeDaemonDisconnectLine(e)
  if (safeFailure !== undefined) {
    if (!resourceOperationFailureWasRendered(e)) io.stderr.write(`${safeFailure}\n`)
    return ExitCode.ERROR
  }
  if (
    e instanceof UsageError ||
    e instanceof BootError ||
    e instanceof CommandError ||
    e instanceof ResourceUsageError
  ) {
    io.stderr.write(
      `${e.message.replace(/[\r\n]+/g, ' ')}; run agh${command ? ` ${command}` : ''} --help for usage\n`,
    )
    return e instanceof ResourceUsageError ? ExitCode.USAGE : e.code
  }
  // Unknown failures have no public display contract; keep logs and arbitrary data out of stderr.
  io.stderr.write('agh: The request failed. Inspect its status with agh doctor.\n')
  return ExitCode.ERROR
}
