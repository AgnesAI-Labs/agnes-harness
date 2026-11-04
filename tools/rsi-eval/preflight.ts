// One tiny real call to the configured upstream, through the usage proxy, before a long run starts: it
// says in plain words whether the key is missing, the account is out of balance, the key is refused, the
// model name is wrong or the upstream cannot be reached, so none of that is found out 30 runs in.
//
// It costs a few tokens. The key is read from the environment variable the run config names (`keyEnv`),
// sent to the upstream and nowhere else; it is never printed or written, and is removed from whatever
// the upstream answers before that is shown.
//
// Usage: pnpm exec tsx tools/rsi-eval/preflight.ts --config <run-config.json>
// Exit code 0 when the upstream answered, 1 when it did not.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { errorBodyPreview } from './infra.js'
import { readConfig } from './prime/run-prime.js'
import type { RunConfig } from './types.js'
import { startUsageProxy } from './usage-proxy.js'

const PROMPT = 'Reply with the single word: ok'

/** The request that asks the configured model for a few tokens, in the wire format of the config's API. */
export const preflightRequest = (
  cfg: Pick<RunConfig, 'api' | 'model'>,
  key: string,
): { path: string; headers: Record<string, string>; body: object } | undefined => {
  switch (cfg.api) {
    case 'anthropic-messages':
      return {
        path: '/v1/messages',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: { model: cfg.model, max_tokens: 8, messages: [{ role: 'user', content: PROMPT }] },
      }
    case 'openai-completions':
      return {
        path: '/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        body: { model: cfg.model, max_tokens: 8, messages: [{ role: 'user', content: PROMPT }] },
      }
    case 'openai-responses':
      return {
        path: '/responses',
        headers: { authorization: `Bearer ${key}` },
        body: { model: cfg.model, max_output_tokens: 16, input: PROMPT },
      }
    default:
      return undefined
  }
}

export type PreflightResult = { ok: boolean; message: string }

const MODEL_WORDS = /model/i
const MODEL_PROBLEM = /not.?found|invalid|unknown|does not exist|not exist|unsupported|not supported|no such/i

/** What an upstream answer means for a run that is about to start, in words for the person who starts it. */
export const explainPreflight = (
  status: number,
  body: string,
  cfg: Pick<RunConfig, 'model' | 'keyEnv' | 'upstream'>,
): PreflightResult => {
  const shown = body === '' ? '' : ` Upstream said: ${body}`
  if (status === 200) return { ok: true, message: `the upstream answered 200 for model ${cfg.model}` }
  if (status === 401 || status === 403)
    return {
      ok: false,
      message: `the key was refused (HTTP ${status}). Check the value of ${cfg.keyEnv}: it may be wrong, expired or not allowed to use this model.${shown}`,
    }
  if (status === 402)
    return {
      ok: false,
      message: `the account is out of balance or quota (HTTP 402). Top it up before starting.${shown}`,
    }
  if (status === 429)
    return {
      ok: false,
      message: `the upstream is rate limiting this key right now (HTTP 429). Wait and try again.${shown}`,
    }
  if (status === 404 || status === 400 || status === 422) {
    if (MODEL_WORDS.test(body) && MODEL_PROBLEM.test(body))
      return {
        ok: false,
        message: `the model name looks wrong: the upstream does not accept "${cfg.model}" (HTTP ${status}). Check "model" in the run config.${shown}`,
      }
    return {
      ok: false,
      message: `the upstream rejected the request (HTTP ${status}). If this is 404, check "upstream" (${cfg.upstream}) and "api" in the run config; if it is 400, check "model" (${cfg.model}).${shown}`,
    }
  }
  if (status === 502 && /unreachable/.test(body))
    return {
      ok: false,
      message: `the upstream cannot be reached at ${cfg.upstream}. Check the address and the network.${shown}`,
    }
  if (status >= 500)
    return {
      ok: false,
      message: `the upstream has a server problem (HTTP ${status}). Try again later.${shown}`,
    }
  return { ok: false, message: `unexpected answer from the upstream (HTTP ${status}).${shown}` }
}

/**
 * Sends the request through a usage proxy of its own (on the config's proxy port, or `port`) to the
 * configured upstream and explains the answer. The proxy's log goes to a temporary folder.
 */
export async function runPreflight(
  cfg: RunConfig,
  env: Record<string, string | undefined>,
  options: { port?: number } = {},
): Promise<PreflightResult> {
  const key = env[cfg.keyEnv]
  if (key === undefined || key.trim() === '')
    return {
      ok: false,
      message: `the API key is missing: environment variable ${cfg.keyEnv} (the run config's keyEnv) is not set. No call was made.`,
    }
  const request = preflightRequest(cfg, key)
  if (!request)
    return {
      ok: false,
      message: `the preflight does not know the API "${cfg.api}"; check "api" in the run config.`,
    }
  const dir = mkdtempSync(join(tmpdir(), 'rsi-preflight-'))
  let proxy: Awaited<ReturnType<typeof startUsageProxy>> | undefined
  try {
    try {
      proxy = await startUsageProxy({
        upstream: cfg.upstream,
        port: options.port ?? cfg.proxyPort,
        logFile: join(dir, 'usage.jsonl'),
        redact: [key],
      })
    } catch (error) {
      return {
        ok: false,
        message: `cannot start the usage proxy on port ${options.port ?? cfg.proxyPort}: ${error instanceof Error ? error.message : String(error)}. Is another evaluation still running?`,
      }
    }
    const response = await fetch(`http://127.0.0.1:${proxy.port}/run/preflight${request.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    return explainPreflight(response.status, errorBodyPreview(text, [key]), cfg)
  } catch (error) {
    return {
      ok: false,
      message: `the call failed before the upstream answered: ${errorBodyPreview(error instanceof Error ? error.message : String(error), [key])}`,
    }
  } finally {
    await proxy?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const main = async (): Promise<void> => {
  const index = process.argv.indexOf('--config')
  const file = index < 0 ? undefined : process.argv[index + 1]
  if (!file) throw new Error('usage: preflight.ts --config <run-config.json>')
  const cfg = readConfig(resolve(file))
  const result = await runPreflight(cfg, process.env)
  console.log(result.ok ? `preflight OK: ${result.message}` : `preflight FAILED: ${result.message}`)
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
