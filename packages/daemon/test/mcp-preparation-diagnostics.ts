import type { McpServerConfig } from '@agnes/base'
import { type McpSandboxContext, sandboxMcpConfig } from '../../resource-control-worker/src/mcp-sandbox.js'

/** A failure-only independent probe, never a retry of the MCP operation or its server process. */
export async function mcpPreparationDiagnostics(
  config: McpServerConfig,
  context: McpSandboxContext,
  prepare = sandboxMcpConfig,
): Promise<Record<string, unknown>> {
  try {
    await prepare(config, context, AbortSignal.timeout(10_000))
    return { probe: 'mcp-sandbox-prepare', state: 'ready' }
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown; killed?: unknown; cmd?: unknown } | null
    const code = failure?.code
    const signal = failure?.signal
    return {
      probe: 'mcp-sandbox-prepare',
      state: 'failed',
      stage:
        typeof failure?.cmd === 'string' && failure.cmd.startsWith('/usr/bin/otool ')
          ? 'runtime-inspection'
          : 'sandbox-prepare',
      code:
        (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 255) ||
        (typeof code === 'string' &&
          [
            'ETIMEDOUT',
            'ENOENT',
            'EACCES',
            'EPERM',
            'ABORT_ERR',
            'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            'E_MCP_SANDBOX_UNAVAILABLE',
          ].includes(code))
          ? code
          : 'UNCLASSIFIED',
      ...(typeof signal === 'string' &&
      ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS'].includes(signal)
        ? { signal }
        : {}),
      ...(typeof failure?.killed === 'boolean' ? { killed: failure.killed } : {}),
    }
  }
}
