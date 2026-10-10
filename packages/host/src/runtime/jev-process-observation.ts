import { canonicalJson, sha256Hex } from '@agnes/core'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type { FrozenIntent, JsonValue } from '@agnes/jev-runtime'

const CODEC = 'agnes-host-builtin-foreground-exec-v1'
const observed = new WeakMap<object, { intentDigest: string; disposition: 'acknowledged' | 'unknown' }>()

/** Only the private observer's exact metadata object can attest process completion. */
export function observedBuiltinProcessDisposition(
  intent: FrozenIntent,
  meta: JsonValue | undefined,
): 'acknowledged' | 'unknown' | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  const evidence = observed.get(meta)
  return evidence?.intentDigest === sha256Hex(canonicalJson(intent)) ? evidence.disposition : undefined
}

/** Observe the genuine exec return beneath a verified builtin shell without interpreting its output.
 * The caller has verified the complete builtin contract and current definition revision.
 */
export async function observeBuiltinProcess(
  intent: FrozenIntent,
  context: ToolContext,
  invoke: (context: ToolContext) => Promise<ToolResult>,
): Promise<{ result: ToolResult; meta: JsonValue }> {
  const foreground = intent.arguments.background !== true
  let execCalls = 0
  let code: number | null = null
  let timedOut: boolean | null = null
  let signal: string | null = null
  let terminatedNormally = false
  const scoped: ToolContext = {
    ...context,
    async exec(argv, options) {
      execCalls++
      const receipt = await context.exec(argv, options)
      // ToolContext exposes a smaller public result. Require the Host adapter's explicit
      // timeout attestation; a transport omitting it must not silently become normal completion.
      const timeout = 'timedOut' in receipt ? receipt.timedOut : undefined
      const endingSignal = 'signal' in receipt ? receipt.signal : undefined
      code = Number.isSafeInteger(receipt.code) ? receipt.code : null
      timedOut = typeof timeout === 'boolean' ? timeout : null
      signal =
        typeof endingSignal === 'string' && /^SIG[A-Z0-9]+$/.test(endingSignal)
          ? endingSignal
          : endingSignal === undefined
            ? null
            : 'UNVERIFIED'
      terminatedNormally =
        execCalls === 1 &&
        foreground &&
        code !== null &&
        code >= 0 &&
        timedOut === false &&
        endingSignal === undefined &&
        !context.signal.aborted &&
        argv.length === 2 &&
        argv[0] === '$SHELL' &&
        argv[1] === intent.arguments.command &&
        options?.cwd === (intent.arguments.cwd ?? context.cwd)
      return receipt
    },
  }
  // A throw after exec returned does not attest that the enclosing tool completed.
  const result = await invoke(scoped)
  const intentDigest = sha256Hex(canonicalJson(intent))
  const disposition =
    terminatedNormally && execCalls === 1 && !context.signal.aborted && !('deferred' in result)
      ? 'acknowledged'
      : 'unknown'
  const meta = Object.freeze({
    builtinProcessAttempt: Object.freeze({
      codec: CODEC,
      intentId: intent.id,
      tool: intent.tool,
      toolRevision: intent.toolRevision,
      intentDigest,
      foreground,
      execCalls,
      completed: true,
      code,
      timedOut,
      signal,
    }),
  })
  observed.set(meta, { intentDigest, disposition })
  return { result, meta }
}
