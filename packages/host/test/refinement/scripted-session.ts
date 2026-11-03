import { closeSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { operations as codeOperations } from '@agnes/code'
import { CompactionRunner } from '@agnes/core'
import type { HookPayloadMap } from '@agnes/extension-api'
import { createPlatform, type PlatformBackend } from '@agnes/host-infrastructure/adapters/platform'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { vi } from 'vitest'
import {
  type CapturedRequest,
  createTestHost,
  startWireCapture,
  type WireApi,
  type WireReply,
} from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))

export type ScriptedSessionOptions = {
  /** Host data directory. Must already exist; its path is replaced by a placeholder in the baseline. */
  dataDir: string
  /** Session working directory. Must already exist; its path is replaced by a placeholder in the baseline. */
  workspace: string
  api: Extract<WireApi, 'anthropic-messages' | 'openai-completions'>
}

/**
 * The platform the session reports. The system prompt states `Platform: <os>-<arch>` and the shell
 * dialect, and on a PowerShell host it carries a whole extra PowerShell section, so a request would
 * differ per operating system. This backend reports the same facts everywhere (Linux, x64, posix, every
 * capability at full strength, as the test host's own platform does) and borrows only the real
 * filesystem semantics, so the baseline recorded on one OS holds on Linux and macOS. A Windows host
 * still adds its own PowerShell description while assembling, so the gate is skipped there (see
 * off-equals-before.slow.test.ts).
 */
function pinnedPlatform(): PlatformBackend {
  const real = createPlatform()
  return {
    os: real.os,
    matches: () => true,
    shell: () => 'posix',
    fs: () => real.fs(),
    terminal: () => ({ color: false }),
    async probe() {},
    recordSandboxBackend() {},
    sandboxProbed: () => true,
    killTree() {},
    capability: () => ({ level: 'full', scope: [] }),
    snapshot: () => ({ os: 'linux', arch: 'x64', capabilities: {} }),
  }
}

/** The clock the session sees; the time note in each request is derived from it. */
const FIXED_NOW = Date.UTC(2026, 10, 3, 9, 0, 0)

/** The profile the baseline session runs under; the refinement switch is saved per profile. */
export const BASELINE_PROFILE = 'refinement-baseline'

export const DATA_DIR_PLACEHOLDER = '<data-dir>'
export const WORKSPACE_PLACEHOLDER = '<workspace>'

/** The model-facing wire reply for each request of the session, in order. */
const script: readonly WireReply[] = [
  // turn 1: a read of a missing file fails, then the model answers
  { toolCall: { name: 'read', args: { path: 'missing.txt' } } },
  { text: 'The file is missing.' },
  // turn 2: a read of an existing file succeeds, then the model answers
  { toolCall: { name: 'read', args: { path: 'probe.txt' } } },
  { text: 'The file says hello.' },
  // requested compaction: a scripted summary reply
  { text: 'Summary of the first two turns.' },
  // turn 3, after the compaction
  { text: 'Done.' },
]

function compactPlan(payload: HookPayloadMap['before_compact']) {
  const nodes = payload.getSurface()
  const first = nodes[0]
  const end = nodes[nodes.length - 2]
  const kept = nodes.at(-1)
  if (!first || !end || !kept) throw new Error('scripted session needs two completed turns before /compact')
  return {
    keepFromSeq: kept.seq,
    summarizeRange: [first.seq, end.seq] as [number, number],
    prompts: { system: 'Summarize the ledger safely.', history: 'Summarize the main range.' },
    maxTokens: 96,
    details: { readFiles: [], modifiedFiles: [] },
  }
}

/**
 * Runs a fixed three-turn session (one failed tool call, one successful, one requested compaction
 * between turn 2 and turn 3) against a loopback wire server and returns every request the host sent.
 */
export async function runScriptedSession(opts: ScriptedSessionOptions): Promise<CapturedRequest[]> {
  const { dataDir, workspace, api } = opts
  // Nothing in a request may depend on the machine or the moment: the context home is the data
  // directory (so no developer settings leak in), the time zone is pinned and the clock is frozen.
  vi.stubEnv('AGH_HOME', dataDir)
  vi.stubEnv('HOME', dataDir)
  vi.stubEnv('USERPROFILE', dataDir)
  writeFileSync(join(dataDir, 'context.json'), `${JSON.stringify({ timeZone: 'UTC' })}\n`)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
  try {
    return await captureSession({ dataDir, workspace, api })
  } finally {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  }
}

async function captureSession(opts: ScriptedSessionOptions): Promise<CapturedRequest[]> {
  const { dataDir, workspace, api } = opts
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'probe.txt'), 'hello from the scripted session\n')
  const credentials = join(dataDir, 'credentials')
  createPrivateDirectorySync(credentials)
  createPrivateDirectorySync(join(credentials, 'test'))
  const credential = createPrivateFileSync(join(credentials, 'test', 'wire'))
  try {
    writeFileSync(credential, 'synthetic-wire-capture')
  } finally {
    closeSync(credential)
  }
  let index = 0
  const capture = await startWireCapture(() => script[index++] ?? { text: 'Done.' })
  try {
    const baseUrl = capture.baseUrl(api)
    const model = fakeModel({ route: 'wire', id: 'fixture', api, baseUrl, contextWindow: 100_000 })
    const { host } = await createTestHost({
      dataDir,
      workspaceRoot: workspace,
      platform: pinnedPlatform(),
      packageDirs: { '@agnes/base': baseDir },
      packages: { '@agnes/code': { operations: codeOperations } },
      disableSessionTitle: true,
      profileInputs: {
        user: {
          name: BASELINE_PROFILE,
          provider: {
            package: '@agnes/ai',
            routes: [{ route: 'wire', api, baseUrl, credentialRef: 'secret://test/wire', models: [model] }],
          },
          adapters: { secrets: { kind: 'file', path: credentials } },
        },
      },
    })
    try {
      const session = await host.createSession({ cwd: workspace })
      session.compaction = new CompactionRunner({
        plan: async (payload) => compactPlan(payload),
        onCompact: async () => undefined,
      })
      const finish = async () => {
        const result = await session.run({ until: 'turn-end', signal: new AbortController().signal })
        if (result.reason !== 'completed') throw new Error(`scripted turn ended with ${result.reason}`)
      }
      const turn = async (prompt: string) => {
        await session.enqueue('next-turn', {
          content: [{ type: 'text', text: prompt }],
          actor: session.d.actor,
          kind: 'prompt',
        })
        await finish()
      }
      await turn('Read missing.txt.')
      await turn('Read probe.txt.')
      await session.requestCompaction({ actor: session.d.actor, admissionId: 'refinement-baseline-compact' })
      await finish()
      await turn('Thanks, that is all.')
    } finally {
      await host.close()
    }
    return [...capture.requests]
  } finally {
    await capture.close()
  }
}

/**
 * The one deferred-tool row the normalizer drops, as it appears inside the JSON request body (a
 * newline there is the two characters `\n`). The row is `<name> — <first sentence of the
 * description>\n` (core/src/request/deferred-tools.ts).
 */
export const PROPOSE_ROW =
  'harness_propose — Propose a change to prompts, memory, skills or subagent specs.\\n'

const DEFERRED_SECTION = /<available_deferred_tools>[\s\S]*?<\/available_deferred_tools>/gu

/**
 * Drops the exact `harness_propose` row from the deferred-tool listing and nothing else. A request
 * without that row (once refinement is off and the tool is not registered) comes back unchanged.
 */
export function normalizeForBaseline(raw: string): string {
  return raw.replace(DEFERRED_SECTION, (section) => section.replace(PROPOSE_ROW, ''))
}

export const WORKSPACE_HASH_PLACEHOLDER = '<workspace-hash>'

/**
 * Replaces everything that depends on where the caller put the directories or on a random draw by
 * fixed placeholders, so the fixture carries no machine path and is the same on every run: both
 * paths, the session key (its last segment is a hash of the canonical workspace path) and the tool
 * call ids (`t<n>-<32 hex>`), numbered in order of first appearance across the whole session so a
 * call and its result still share one id.
 */
export function maskVolatile(
  raws: readonly string[],
  paths: { dataDir: string; workspace: string },
): string[] {
  // A path inside the JSON body is escaped (a Windows backslash becomes two), so mask both forms.
  // The workspace may sit under the data directory, so mask the longer path first.
  const escaped = (path: string) => JSON.stringify(path).slice(1, -1)
  const ordered = [
    [paths.workspace, WORKSPACE_PLACEHOLDER],
    [escaped(paths.workspace), WORKSPACE_PLACEHOLDER],
    [paths.dataDir, DATA_DIR_PLACEHOLDER],
    [escaped(paths.dataDir), DATA_DIR_PLACEHOLDER],
  ] as const
  const callIds = new Map<string, number>()
  return raws.map((raw) =>
    [...ordered]
      .sort((a, b) => b[0].length - a[0].length)
      .reduce((text, [value, placeholder]) => text.split(value).join(placeholder), raw)
      .replace(/(:cli:workspace:)[0-9a-f]{16}/gu, `$1${WORKSPACE_HASH_PLACEHOLDER}`)
      .replace(/\b(t\d+)-[0-9a-f]{32}\b/gu, (whole: string, prefix: string) => {
        const key = whole
        if (!callIds.has(key)) callIds.set(key, callIds.size)
        return `${prefix}-<call-${callIds.get(key)}>`
      }),
  )
}

/** The request bodies are one long line each, so name the first differing byte instead of dumping both. */
export function firstDifference(expected: string, actual: string): string {
  let at = 0
  while (at < expected.length && at < actual.length && expected[at] === actual[at]) at++
  const around = (text: string) => JSON.stringify(text.slice(Math.max(0, at - 80), at + 80))
  return `first difference at byte ${at}\n  baseline: ${around(expected)}\n  actual:   ${around(actual)}`
}
