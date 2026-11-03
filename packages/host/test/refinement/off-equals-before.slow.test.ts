import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  firstDifference,
  maskVolatile,
  normalizeForBaseline,
  PROPOSE_ROW,
  runScriptedSession,
} from './scripted-session.js'

const baselineFile = fileURLToPath(new URL('../fixtures/refinement/off-baseline.json', import.meta.url))
const apis = ['anthropic-messages', 'openai-completions'] as const

type Baseline = Record<(typeof apis)[number], string[]>

/** Runs the session once per api and returns the masked, normalized requests. */
async function record(): Promise<Baseline> {
  const baseline = {} as Baseline
  for (const api of apis) {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-refinement-baseline-')))
    try {
      const dataDir = join(root, 'data')
      const workspace = join(root, 'workspace')
      mkdirSync(dataDir)
      mkdirSync(workspace)
      const requests = await runScriptedSession({ dataDir, workspace, api })
      // Off, nothing of saved task experience is touched: no workspace registry is ever created.
      expect(existsSync(join(dataDir, 'refinement', 'workspaces'))).toBe(false)
      const volatileFree = maskVolatile(
        requests.map((request) => request.raw),
        { dataDir, workspace },
      )
      baseline[api] = volatileFree.map(normalizeForBaseline)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  return baseline
}

// The request bytes are produced by cross-platform code and are pinned on Linux and macOS. A Windows
// host adds a PowerShell description to the prompt while it assembles (the host resolves PowerShell,
// and the prompt prefers that description over the platform's shell), so that assembly is not part of
// this gate and could not be verified here. Follow-up: make `pinnedPlatform().matches` return false
// on win32 and run one Windows diagnostic. The helper tests in the second describe boot no host and run everywhere.
describe.skipIf(process.platform === 'win32')('refinement off, host-booted', () => {
  it('RSI off sends the same bytes as before', async () => {
    const actual = await record()
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
      expect(baseline[api].join('')).not.toContain('harness_propose')
      // The platform is pinned, so the recorded sentence is the same on every operating system.
      expect(baseline[api][0]).toContain('Platform: linux-x64. Shell dialect for any shell tool: posix.')
    }
  })
})

describe('refinement off, normalization helpers', () => {
  // The gate above must stay green when the product stops listing harness_propose, so the normalizer
  // is proven on synthetic text instead of on the live request.
  it('the normalizer drops only the exact harness_propose row inside the deferred-tool section', () => {
    const section = (rows: string) =>
      `{"text":"intro\\n<available_deferred_tools>\\n${rows}</available_deferred_tools>"}`
    const before = 'goal_get — Read the goal.\\n'
    const after = 'job_kill — Stop a job.\\n'
    expect(normalizeForBaseline(section(`${before}${PROPOSE_ROW}${after}`))).toBe(
      section(`${before}${after}`),
    )
    // already absent: unchanged
    expect(normalizeForBaseline(section(`${before}${after}`))).toBe(section(`${before}${after}`))
    // a similar row, or the row outside the section, is not touched
    const similar = 'harness_propose — Another description.\\n'
    expect(normalizeForBaseline(section(`${similar}${after}`))).toBe(section(`${similar}${after}`))
    const outside = `{"text":"${PROPOSE_ROW}"}`
    expect(normalizeForBaseline(outside)).toBe(outside)
  })

  it('masks directories in their raw and JSON-escaped forms', () => {
    const paths = { dataDir: 'C:\\tmp\\agnes\\data', workspace: 'C:\\tmp\\agnes\\data\\ws' }
    const raw = JSON.stringify({ a: paths.workspace, b: paths.dataDir, c: `${paths.workspace}\\x` })
    const [masked] = maskVolatile([raw], paths)
    expect(masked).toBe('{"a":"<workspace>","b":"<data-dir>","c":"<workspace>\\\\x"}')
  })
})
