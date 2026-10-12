import { canonicalJson, sha256Hex } from '@agnes/core'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type { FrozenIntent, JsonValue } from '@agnes/jev-runtime'

const CODEC = 'agnes-host-builtin-foreground-exec-v1'
const observed = new WeakMap<object, { intentDigest: string; disposition: 'acknowledged' | 'unknown' }>()
const encoder = new TextEncoder()

/** Bound each channel independently so stdout cannot crowd stderr out of the model view. */
function streamExcerpt(text: string): { text: string; truncated: boolean } {
  const limit = 1024
  if (encoder.encode(JSON.stringify(text)).length <= limit) return { text, truncated: false }
  const points = Array.from(text)
  const excerpt = (count: number) => {
    const tail = Math.floor(count / 4)
    return `${points.slice(0, count - tail).join('')}\n[excerpt omitted]\n${tail ? points.slice(-tail).join('') : ''}`
  }
  let low = 0
  let high = Math.min(points.length, limit)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encoder.encode(JSON.stringify(excerpt(middle))).length <= limit) low = middle
    else high = middle - 1
  }
  return { text: excerpt(low), truncated: true }
}

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
  let process: Record<string, JsonValue> | undefined
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
      if (
        foreground &&
        execCalls === 1 &&
        argv.length === 2 &&
        argv[0] === '$SHELL' &&
        argv[1] === intent.arguments.command &&
        options?.cwd === (intent.arguments.cwd ?? context.cwd)
      ) {
        const stdout = streamExcerpt(receipt.stdout)
        const stderr = streamExcerpt(receipt.stderr)
        process = {
          exitCode: code,
          timedOut,
          signal,
          stdout: stdout.text,
          stderr: stderr.text,
          outputTruncated: typeof receipt.truncated === 'boolean' ? receipt.truncated : null,
          stdoutExcerptTruncated: stdout.truncated,
          stderrExcerptTruncated: stderr.truncated,
        }
      }
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
  return {
    result:
      process === undefined || execCalls !== 1 || 'deferred' in result
        ? result
        : {
            ...result,
            structured: {
              codec: 'agnes-host-tool-fact-v1',
              tool: 'shell',
              process,
              interpretation: { executionCompleted: true, verification: 'not_assessed' },
              coverage: {
                complete:
                  process.outputTruncated === false &&
                  process.stdoutExcerptTruncated === false &&
                  process.stderrExcerptTruncated === false,
              },
            },
          },
    meta,
  }
}
