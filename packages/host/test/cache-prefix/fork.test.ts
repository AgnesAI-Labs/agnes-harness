import { closeSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { buildCompactionPlan } from '@agnes/base'
import { fakeProvider, textTurn, toolTurn } from '@agnes/core/testkit'
import type { Provider, RequestBody } from '@agnes/protocol'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import {
  createTestHost,
  expectExtends,
  renderedParts,
  startWireCapture,
  type WireApi,
} from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const parentKey = 'prefix-parent'
const apis: readonly WireApi[] = ['anthropic-messages', 'openai-completions']

function setupDir() {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-fork-prefix-'))
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
      const capture = await startWireCapture(() => {
        calls++
        if (calls <= precedingReads) return { toolCall: { name: 'read', args: { path: 'probe.txt' } } }
        if (calls === precedingReads + 1)
          return { toolCall: { name: 'subagent_fork', args: { question: 'child task' } } }
        return { text: calls === precedingReads + 2 ? 'child answer' : 'parent answer' }
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
                adapters: ['@agnes/ai'],
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
          await prompt(session, 'Delegate after reading if needed')
          expect(capture.requests).toHaveLength(precedingReads + 3)
          const first = capture.requests[0]
          const beforeFork = capture.requests[precedingReads]
          const child = capture.requests[precedingReads + 1]
          if (!first || !beforeFork || !child) throw new Error('missing fork request')
          expectExtends(first, child)
          const triggerPart = renderedParts(beforeFork).find(
            (part) =>
              part.key.match(/^(?:messages|input)\[\d+\]$/u) && part.bytes.includes('Delegate after reading'),
          )
          const triggerIndex = Number(triggerPart?.key.match(/\[(\d+)\]/u)?.[1])
          expect(Number.isInteger(triggerIndex)).toBe(true)
          expectExtends(beforeFork, child, { throughMessage: triggerIndex + 1 })
          expect(renderedParts(child)[0]?.bytes).toBe(renderedParts(first)[0]?.bytes)
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
      [toolTurn('subagent_spawn', { task: 'child task', isolation: 'shared' }), textTurn('parent answer')],
      '2',
    )
    const childProvider = fakeProvider([textTurn('child answer')], '2')
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
        await prompt(session, 'Spawn a helper')
        await expect.poll(() => requests.some((request) => request.sessionKey !== parentKey)).toBe(true)
        const parent = requests.find((request) => request.sessionKey === parentKey)
        const child = requests.find((request) => request.sessionKey !== parentKey)
        expect(parent).toBeDefined()
        expect(child).toBeDefined()
        expect(child?.tools).toEqual(parent?.tools)
        expect(child?.system).toBe(parent?.system)
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
        textTurn('first answer'),
        toolTurn('subagent_fork', { question: 'child task' }),
        textTurn('parent answer'),
      ],
      '2',
    )
    const childProvider = fakeProvider([textTurn('child answer')], '2')
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
        await prompt(session, 'historical untrusted marker', true)
        await prompt(session, 'trigger untrusted marker', true)
        const parent = parentProvider.requests[1]
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
    const ordinary = fakeProvider([textTurn('short answer')], '2')
    const parentSummary = fakeProvider([textTurn('PARENT SUMMARY')], '2')
    const childSummary = fakeProvider([textTurn('CHILD SUMMARY')], '2')
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
              adapters: ['@agnes/ai'],
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
            model: { route: { primary: 'gw', compaction: 'gw' }, id: { compaction: 'summary-model' } },
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
        primaryWindow = 1
        await prompt(child, `child threshold ${'c'.repeat(800)}`)

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
