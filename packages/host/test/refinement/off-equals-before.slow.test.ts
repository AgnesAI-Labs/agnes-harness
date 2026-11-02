import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { maskVolatile, normalizeForBaseline, runScriptedSession } from './scripted-session.js'

const baselineFile = fileURLToPath(new URL('../fixtures/refinement/off-baseline.json', import.meta.url))
const apis = ['anthropic-messages', 'openai-completions'] as const

type Baseline = Record<(typeof apis)[number], string[]>

/** The one deferred-tool row the normalizer drops (a newline inside the JSON body is the two characters `\n`). */
const PROPOSE_ROW = 'harness_propose — Propose a change to prompts, memory, skills or subagent specs.\\n'

/** Runs the session once per api; `masked` is the first request before the normalizer ran. */
async function record(): Promise<{ baseline: Baseline; masked: Record<(typeof apis)[number], string> }> {
  const baseline = {} as Baseline
  const masked = {} as Record<(typeof apis)[number], string>
  for (const api of apis) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-refinement-baseline-')))
    try {
      const dataDir = join(root, 'data')
      const workspace = join(root, 'workspace')
      mkdirSync(dataDir)
      mkdirSync(workspace)
      const requests = await runScriptedSession({ dataDir, workspace, api })
      const volatileFree = maskVolatile(
        requests.map((request) => request.raw),
        { dataDir, workspace },
      )
      masked[api] = volatileFree[0] ?? ''
      baseline[api] = volatileFree.map(normalizeForBaseline)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  return { baseline, masked }
}

/** The request bodies are one long line each, so name the first differing byte instead of dumping both. */
function firstDifference(expected: string, actual: string): string {
  let at = 0
  while (at < expected.length && at < actual.length && expected[at] === actual[at]) at++
  const around = (text: string) => JSON.stringify(text.slice(Math.max(0, at - 80), at + 80))
  return `first difference at byte ${at}\n  baseline: ${around(expected)}\n  actual:   ${around(actual)}`
}

describe('refinement off', () => {
  it('RSI off sends the same bytes as before', async () => {
    const { baseline: actual, masked } = await record()
    if (process.env.AGH_RECORD_REFINEMENT_BASELINE === '1') {
      writeFileSync(baselineFile, `${JSON.stringify(actual, null, 2)}\n`)
      return
    }
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as Baseline
    for (const api of apis) {
      expect(actual[api].length, `${api} request count`).toBe(baseline[api].length)
      for (const [index, request] of actual[api].entries()) {
        const expected = baseline[api][index] ?? ''
        if (request !== expected)
          throw new Error(`${api} request ${index}: ${firstDifference(expected, request)}`)
      }
      // The normalizer is not vacuous and removes that one row and nothing else.
      expect(masked[api].split(PROPOSE_ROW), api).toHaveLength(2)
      expect(masked[api].replace(PROPOSE_ROW, ''), api).toBe(actual[api][0])
      expect(baseline[api].join('')).not.toContain('harness_propose')
    }
  })
})
