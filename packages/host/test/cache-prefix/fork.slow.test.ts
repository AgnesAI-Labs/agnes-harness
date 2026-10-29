import { closeSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARSER_VERSION } from '@agnes/ai'
import { fakeModel } from '@agnes/ai/testkit'
import { buildCompactionPlan } from '@agnes/base'
import { fakeProvider, sent, textTurn, toolTurn, usage } from '@agnes/core/testkit'
import type { InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type CapturedRequest,
  createTestHost,
  renderedParts,
  startWireCapture,
  type WireApi,
} from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const parentKey = 'prefix-parent'
const apis: readonly WireApi[] = ['anthropic-messages', 'openai-completions']
afterEach(() => vi.unstubAllEnvs())

const SCHEDULE_TOOL_NAMES = new Set([
  'schedule_create',
  'schedule_delete',
  'schedule_list',
  'schedule_update',
])

const discoveryNames = (delegate: string) => [...SCHEDULE_TOOL_NAMES, delegate]
const discover = (delegate: string): InferenceEvent[] => [
  sent(),
  ...discoveryNames(delegate).map(
    (name, ordinal): InferenceEvent => ({
      type: 'toolcall_end',
      call: { toolUseId: '', name: 'tool_describe', args: { name }, ordinal },
      via: 'native',
    }),
  ),
  usage(),
  { type: 'done', reason: 'toolUse' },
]

function toolName(tool: unknown): string | undefined {
  if (!tool || typeof tool !== 'object') return undefined
  const record = tool as { name?: unknown; function?: { name?: unknown } }
  if (typeof record.name === 'string') return record.name
  if (typeof record.function?.name === 'string') return record.function.name
  return undefined
}

/** Delegated children keep the parent prefix except the four schedule tools the subagent filter denies. */
function withoutScheduleTools(tools: unknown): unknown {
  return Array.isArray(tools) ? tools.filter((tool) => !SCHEDULE_TOOL_NAMES.has(toolName(tool) ?? '')) : tools
}

/** The same four denied tools must disappear from the deferred discovery catalogue too. */
function withoutScheduleDiscovery(value: unknown, removed: string[]): unknown {
  if (typeof value === 'string')
    return value.replace(
      /^(schedule_create|schedule_delete|schedule_list|schedule_update) — [^\n]*\n/gmu,
      (_line, name: string) => {
        removed.push(name)
        return ''
      },
    )
  if (Array.isArray(value)) return value.map((item) => withoutScheduleDiscovery(item, removed))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withoutScheduleDiscovery(item, removed)]),
    )
  return value
}

function expectForkExtends(
  previous: CapturedRequest,
  next: CapturedRequest,
  options: { throughMessage?: number } = {},
): void {
  const parentTools = (previous.body as { tools?: unknown }).tools
  const childTools = (next.body as { tools?: unknown }).tools
  expect(withoutScheduleTools(parentTools)).toEqual(childTools)
  expect(
    Array.isArray(parentTools) && parentTools.some((tool) => SCHEDULE_TOOL_NAMES.has(toolName(tool) ?? '')),
  ).toBe(true)
  const visible = (request: CapturedRequest) =>
    renderedParts(request).filter((part) => {
      if (part.key === 'tools') return false
      if (options.throughMessage === undefined) return true
      const match = part.key.match(/^(?:messages|input)\[(\d+)\]$/u)
      return !match || Number(match[1]) < options.throughMessage
    })
  const parentParts = visible(previous)
  const childParts = visible(next)
  for (const [index, left] of parentParts.entries()) {
    if (left.key !== 'system') {
      expect(childParts[index]).toEqual(left)
      continue
    }
    const removed: string[] = []
    const expected = JSON.stringify(withoutScheduleDiscovery(JSON.parse(left.bytes), removed))
    expect(removed.sort()).toEqual([...SCHEDULE_TOOL_NAMES].sort())
    expect(childParts[index]).toEqual({ key: 'system', bytes: expected })
  }
}

function setupDir() {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-fork-prefix-'))
  // These fixtures assert a full frozen request prefix beyond the fork trigger; live clock notes
  // are deliberately outside that inherited boundary and are covered by default-context tests.
  vi.stubEnv('AGH_HOME', dataDir)
  writeFileSync(join(dataDir, 'context.json'), JSON.stringify({ timeEnabled: false }))
  const credentials = join(dataDir, 'credentials')
  createPrivateDirectorySync(credentials)
  createPrivateDirectorySync(join(credentials, 'test'))
  const file = createPrivateFileSync(join(credentials, 'test', 'wire'))
  try {
    writeFileSync(file, 'synthetic-wire-capture')
  } finally {
    closeSync(file)
  }
  return { dataDir, credentials }
}

async function parentSession(host: Awaited<ReturnType<typeof createTestHost>>['host'], dataDir: string) {
  const binding = host.acceptWorkspaceBinding(
    {
      version: 1,
      sessionKey: parentKey,
      workspaceId: 'a'.repeat(64),
      revision: 1,
      canonicalRoot: realpathSync.native(dataDir),
    },
    parentKey,
  )
  return host.createSession({ key: parentKey, binding })
}

async function prompt(session: Awaited<ReturnType<typeof parentSession>>, text: string, untrusted = false) {
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text }],
    actor: session.d.actor,
    kind: 'prompt',
    ...(untrusted ? { trust: 'untrusted' as const } : {}),
  })
  const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
  if (outcome.reason !== 'completed') throw new Error(JSON.stringify(outcome))
}

describe('delegated child wire prefixes', () => {
  it.each(apis)('%s fork retains the parent prefix when called at the first or third step', async (api) => {
    for (const precedingReads of [0, 2]) {
      const { dataDir, credentials } = setupDir()
      writeFileSync(join(dataDir, 'probe.txt'), 'fixture body')
      let calls = 0
      const names = discoveryNames('subagent_fork')
      const capture = await startWireCapture(() => {
        calls++
        if (calls <= names.length)
          return { toolCall: { name: 'tool_describe', args: { name: names[calls - 1] } } }
        if (calls === names.length + 1) return { text: 'Delegation tools loaded' }
        const taskCall = calls - names.length - 1
        if (taskCall <= precedingReads) return { toolCall: { name: 'read', args: { path: 'probe.txt' } } }
        if (taskCall === precedingReads + 1)
          return {
            toolCall: { name: 'subagent_fork', args: { question: 'child task', isolation: 'shared' } },
          }
        return { text: taskCall === precedingReads + 2 ? 'child answer' : 'parent answer' }
      })
      try {
        const baseUrl = capture.baseUrl(api)
        const model = fakeModel({ route: 'wire', id: 'fixture', api, baseUrl })
        const { host } = await createTestHost({
          dataDir,
          packageDirs: { '@agnes/base': baseDir },
          disableSessionTitle: true,
          profileInputs: {
            user: {
              name: 'fork-prefix',
              provider: {
                package: '@agnes/ai',
                routes: [
                  { route: 'wire', api, baseUrl, credentialRef: 'secret://test/wire', models: [model] },
                ],
              },
              adapters: { secrets: { kind: 'file', path: credentials } },
            },
          },
        })
        try {
          const session = await parentSession(host, dataDir)
          // Load the selected deferred schemas through the public discovery path before the measured turn.
          await prompt(session, 'Prepare delegation tools')
          const offset = names.length + 1
          expect(capture.requests).toHaveLength(offset)
          await prompt(session, 'Delegate after reading if needed')
          await expect.poll(() => capture.requests.length).toBe(offset + precedingReads + 3)
          await expect.poll(async () => (await session.d.children.list?.())?.[0]?.status).toBe('idle')
          const first = capture.requests[offset]
          const beforeFork = capture.requests[offset + precedingReads]
          const child = capture.requests
            .slice(offset + precedingReads + 1)
            .find((request) => !request.raw.includes('started prefix-parent/'))
          if (!first || !beforeFork || !child) throw new Error('missing fork request')
          expectForkExtends(first, child)
          const triggerPart = renderedParts(beforeFork).find(
            (part) =>
              part.key.match(/^(?:messages|input)\[\d+\]$/u) && part.bytes.includes('Delegate after reading'),
          )
          const triggerIndex = Number(triggerPart?.key.match(/\[(\d+)\]/u)?.[1])
          expect(Number.isInteger(triggerIndex)).toBe(true)
          expectForkExtends(beforeFork, child, { throughMessage: triggerIndex + 1 })
        } finally {
          await host.close()
        }
      } finally {
        await capture.close()
        rmSync(dataDir, { recursive: true, force: true })
      }
    }
  })

  it('spawn preserves the parent tools and system on the child first request', async () => {
    const { dataDir } = setupDir()
    const requests: RequestBody[] = []
    const model = fakeModel({ route: 'gw', id: 'm1' })
    const parentProvider = fakeProvider(
      [
        discover('subagent_spawn'),
        textTurn('Delegation tools loaded'),
        toolTurn('subagent_spawn', { task: 'child task', isolation: 'shared' }),
        textTurn('parent answer'),
      ],
      PARSER_VERSION,
    )
    const childProvider = fakeProvider([textTurn('child answer')], PARSER_VERSION)
    const provider: Provider = {
      models: () => [model],
      async *infer(request, options) {
        requests.push(request)
        yield* (request.sessionKey === parentKey ? parentProvider : childProvider).infer(request, options)
      },
    }
    try {
      const { host } = await createTestHost({
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        provider,
        disableSessionTitle: true,
      })
      try {
        const session = await parentSession(host, dataDir)
        await prompt(session, 'Prepare delegation tools')
        await prompt(session, 'Spawn a helper')
        await expect.poll(() => requests.some((request) => request.sessionKey !== parentKey)).toBe(true)
        const parent = requests.filter((request) => request.sessionKey === parentKey)[2]
        const child = requests.find((request) => request.sessionKey !== parentKey)
        expect(parent).toBeDefined()
        expect(child).toBeDefined()
        expect(withoutScheduleTools(parent?.tools)).toEqual(child?.tools)
        expect((parent?.tools ?? []).some((tool) => SCHEDULE_TOOL_NAMES.has(toolName(tool) ?? ''))).toBe(true)
        const removed: string[] = []
        expect(child?.system).toBe(withoutScheduleDiscovery(parent?.system, removed))
        expect(removed.sort()).toEqual([...SCHEDULE_TOOL_NAMES].sort())
      } finally {
        await host.close()
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('inherits prior untrusted envelope ids but remints an untrusted fork trigger', async () => {
    const { dataDir } = setupDir()
    const model = fakeModel({ route: 'gw', id: 'm1' })
    const parentProvider = fakeProvider(
      [
        discover('subagent_fork'),
        textTurn('Delegation tools loaded'),
        textTurn('first answer'),
        toolTurn('subagent_fork', { question: 'child task', isolation: 'shared' }),
        textTurn('parent answer'),
      ],
      PARSER_VERSION,
    )
    const childProvider = fakeProvider([textTurn('child answer')], PARSER_VERSION)
    const provider: Provider = {
      models: () => [model],
      infer: (request, options) =>
        (request.sessionKey === parentKey ? parentProvider : childProvider).infer(request, options),
    }
    try {
      const { host } = await createTestHost({
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        provider,
        disableSessionTitle: true,
      })
      try {
        const session = await parentSession(host, dataDir)
        await prompt(session, 'Prepare delegation tools')
        await prompt(session, 'historical untrusted marker', true)
        await prompt(session, 'trigger untrusted marker', true)
        await expect.poll(() => childProvider.requests.length).toBe(1)
        await expect.poll(async () => (await session.d.children.list?.())?.[0]?.status).toBe('idle')
        const parent = parentProvider.requests[3]
        const child = childProvider.requests[0]
        if (!parent || !child) throw new Error('missing parent or child request')
        const findMessage = (messages: RequestBody['messages'], marker: string) =>
          messages.find((message) => JSON.stringify(message).includes(marker))
        const envelopeId = (message: unknown) =>
          /<untrusted id=\\?"([^"]+)/u.exec(JSON.stringify(message))?.[1]
        const historicalParent = findMessage(parent.messages, 'historical untrusted marker')
        const historicalChild = findMessage(child.messages, 'historical untrusted marker')
        const triggerParent = findMessage(parent.messages, 'trigger untrusted marker')
        const triggerChild = findMessage(child.messages, 'trigger untrusted marker')
        expect(envelopeId(historicalParent)).toBeTruthy()
        expect(envelopeId(historicalChild)).toBe(envelopeId(historicalParent))
        expect(envelopeId(triggerParent)).toBeTruthy()
        expect(envelopeId(triggerChild)).toBeTruthy()
        expect(envelopeId(triggerChild)).not.toBe(envelopeId(triggerParent))
      } finally {
        await host.close()
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('uses the Base update plan when a child compacts an inherited parent summary', async () => {
    const { dataDir } = setupDir()
    const model = fakeModel({ route: 'gw', id: 'm1', contextWindow: 100_000 })
    const summaryModel = fakeModel({ route: 'gw', id: 'summary-model', contextWindow: 100_000 })
    const ordinary = fakeProvider([textTurn('short answer')], PARSER_VERSION)
    const parentSummary = fakeProvider([textTurn('PARENT SUMMARY')], PARSER_VERSION)
    const childSummary = fakeProvider([textTurn('CHILD SUMMARY')], PARSER_VERSION)
    const requests: RequestBody[] = []
    const plans: Array<{ reason: string; previousSummarySeq?: number }> = []
    let primaryWindow = 100_000
    const provider: Provider = {
      models: () => [{ ...model, contextWindow: primaryWindow }, summaryModel],
      infer: (request, options) => {
        requests.push(request)
        if (request.kind === 'summary' && request.sessionKey !== parentKey) primaryWindow = 100_000
        return request.kind === 'summary'
          ? (request.sessionKey === parentKey ? parentSummary : childSummary).infer(request, options)
          : ordinary.infer(request, options)
      },
    }
    try {
      const { host } = await createTestHost({
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        provider,
        disableSessionTitle: true,
        profileInputs: {
          user: {
            name: 'child-compaction',
            provider: {
              package: '@agnes/ai',
              routes: [
                {
                  route: 'gw',
                  api: 'openai-completions',
                  baseUrl: model.baseUrl,
                  models: [model, summaryModel],
                },
              ],
            },
          },
        },
        packages: {
          '@agnes/base': {
            buildCompactionPlan: (payload, config) => {
              plans.push({
                reason: payload.reason,
                ...(payload.previousSummarySeq === undefined
                  ? {}
                  : { previousSummarySeq: payload.previousSummarySeq }),
              })
              return buildCompactionPlan(payload, config)
            },
          },
        },
        presets: {
          standard: {
            name: 'standard',
            extends: 'base',
            disclosure: 'standard',
            model: {
              route: { primary: 'gw', compaction: { route: 'gw', model: 'summary-model' } },
            },
            compaction: { enabled: true, reserve_tokens: 100, keep_recent_tokens: 0, agent_callable: true },
          },
        },
      })
      try {
        const parent = await parentSession(host, dataDir)
        await prompt(parent, `parent first ${'a'.repeat(800)}`)
        await prompt(parent, `parent second ${'b'.repeat(800)}`)
        await parent.requestCompaction({ actor: parent.d.actor, admissionId: 'parent-initial-summary' })
        expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
          'completed',
        )
        const inherited = parent.surface()[0]
        expect(inherited?.kind).toBe('summary')
        if (!inherited) throw new Error('missing parent summary')
        await prompt(parent, 'inherited parent tail')

        const child = await host.createSession({
          cwd: dataDir,
          key: 'prefix-child',
          parent: { key: parent.key, boundarySeq: parent.lastSeq },
        })
        expect(child.surface()[0]?.seq).toBe(inherited.seq)
        expect(child.preset.compaction.enabled).toBe(true)
        await prompt(child, 'child first task')
        // A session keeps the context window it was given, so the child's own window shrinks along with
        // what the provider advertises. The smallest one the budget check accepts still has to hold the
        // fixed instructions and tools, so the prompt that crosses the threshold is long instead.
        primaryWindow = 16384
        child.preset = {
          ...child.preset,
          model: {
            ...child.preset.model,
            contextWindow: { ...child.preset.model.contextWindow, primary: 16384 },
          },
        }
        await prompt(child, `child threshold ${'c'.repeat(80_000)}`)

        expect(plans).toContainEqual({ reason: 'threshold', previousSummarySeq: inherited.seq })
        const summaryRequest = requests.findLast(
          (request) => request.kind === 'summary' && request.sessionKey === child.key,
        )
        expect(summaryRequest).toBeDefined()
        expect(JSON.stringify(summaryRequest?.messages)).toContain('PARENT SUMMARY')
        expect(JSON.stringify(summaryRequest?.messages)).toContain(
          'Update the existing summary with the new conversation segment.',
        )
        expect(JSON.stringify(summaryRequest?.messages)).toContain('inherited parent tail')
        const childRows = await child.scan({ fromSeq: parent.lastSeq + 1, toSeq: child.lastSeq })
        expect(childRows.some((row) => row.type === 'x/core/compaction-failed')).toBe(false)
        expect(
          childRows.find((row) => typeof row.surfaceOp === 'object' && row.surfaceOp.op === 'replace')
            ?.surfaceOp,
        ).toMatchObject({ op: 'replace', start: inherited.seq })
        expect(child.surface()[0]?.kind).toBe('summary')
        expect(child.surface()[0]?.seq).not.toBe(inherited.seq)
      } finally {
        await host.close()
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
