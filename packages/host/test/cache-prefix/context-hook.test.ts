import { closeSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { ecosystem as baseEcosystem } from '@agnes/base'
import { operations as codeOperations } from '@agnes/code'
import { CompactionRunner } from '@agnes/core'
import { fakeProvider, testFsPolicy, textTurn } from '@agnes/core/testkit'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it, vi } from 'vitest'
import { createTestHost, expectExtends, startWireCapture, type WireApi } from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const apis: readonly WireApi[] = ['anthropic-messages', 'openai-completions', 'openai-responses']

describe('context hook wire prefix', () => {
  it.each(['wide', 'nonzero', 'other-model'] as const)(
    'blocks a cold %s compaction when context-first UserPromptSubmit exits 2',
    async (range) => {
      const dataDir = mkdtempSync(join(tmpdir(), 'agnes-cold-hook-block-'))
      writeFileSync(
        join(dataDir, 'hooks.json'),
        JSON.stringify({
          hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: './gate.sh' }] }] },
        }),
      )
      let blocked = false
      const exec = vi.fn(async () => ({
        code: blocked ? 2 : 0,
        stdout: '',
        stderr: blocked ? 'cold denied' : '',
        truncated: false,
      }))
      const options = {
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        packages: { '@agnes/code': { operations: codeOperations } },
        disableSessionTitle: true,
        seams: {
          sandbox: {
            exec,
            fsPolicy: () => testFsPolicy(realpathSync.native(dataDir)),
            enforcement: () => ({ level: 'full' as const, scope: ['process' as const] }),
          },
        },
      }
      const firstProvider = fakeProvider([textTurn('old one'), textTurn('old two')], '2')
      try {
        const first = await createTestHost({ ...options, provider: firstProvider })
        try {
          const session = await first.host.createSession({ cwd: dataDir, key: 'cold-hook-block' })
          for (const prompt of ['one', 'two']) {
            await session.enqueue('next-turn', {
              content: [{ type: 'text', text: prompt }],
              actor: session.d.actor,
              kind: 'prompt',
            })
            const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
            if (outcome.reason !== 'completed') throw new Error(JSON.stringify(outcome))
          }
        } finally {
          await first.host.close()
        }
        expect(exec).toHaveBeenCalledTimes(2)
        const coldProvider = fakeProvider([textTurn('must not be sent')], '2')
        const second = await createTestHost({ ...options, provider: coldProvider })
        try {
          const reopened = await second.host.createSession({ cwd: dataDir, key: 'cold-hook-block' })
          if (range === 'other-model') reopened.preset.model.id.compaction = 'summary-model'
          reopened.compaction = new CompactionRunner({
            plan: async (payload) => {
              const surface = payload.getSurface()
              const first = surface[0]
              const start = range === 'nonzero' ? surface[2] : first
              const end = surface.at(-2)
              const kept = surface.at(-1)
              if (!start || !end || !kept) throw new Error('missing compactable history')
              return {
                keepFromSeq: kept.seq,
                summarizeRange: [start.seq, end.seq],
                prompts: { system: 'Summarize safely.', history: 'Summarize history.' },
                maxTokens: 96,
                details: { readFiles: [], modifiedFiles: [] },
              }
            },
            onCompact: async () => undefined,
          })
          blocked = true
          await reopened.requestCompaction({ actor: reopened.d.actor, admissionId: 'cold-hook-block' })
          expect(
            await reopened.run({ until: 'turn-end', signal: new AbortController().signal }),
          ).toMatchObject({
            reason: 'blocked',
            error: { code: 'HOOK_BLOCKED', message: 'cold denied' },
          })
          expect(exec).toHaveBeenCalledTimes(3)
          expect(coldProvider.requests).toHaveLength(0)
          expect(await reopened.d.log.scan({ type: 'x/core/compaction-end', limit: 5 })).toHaveLength(0)
          expect(reopened.surface().some((node) => node.kind === 'summary')).toBe(false)

          blocked = false
          await reopened.enqueue('next-turn', {
            content: [{ type: 'text', text: 'Continue after block.' }],
            actor: reopened.d.actor,
            kind: 'prompt',
          })
          expect(
            (await reopened.run({ until: 'turn-end', signal: new AbortController().signal })).reason,
          ).toBe('completed')
          expect(exec).toHaveBeenCalledTimes(4)
          expect(coldProvider.requests).toHaveLength(1)
        } finally {
          await second.host.close()
        }
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  )

  it.each(apis)('%s runs context once in a three-step turn and keeps changes in a tail note', async (api) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-wire-context-'))
    writeFileSync(join(dataDir, 'probe.txt'), 'fixture file body')
    const credentials = join(dataDir, 'credentials')
    createPrivateDirectorySync(credentials)
    createPrivateDirectorySync(join(credentials, 'test'))
    const credential = createPrivateFileSync(join(credentials, 'test', 'wire'))
    try {
      writeFileSync(credential, 'synthetic-wire-capture')
    } finally {
      closeSync(credential)
    }
    let responses = 0
    const capture = await startWireCapture(() => {
      responses++
      return responses <= 2
        ? { toolCall: { name: 'read', args: { path: 'probe.txt' } } }
        : { text: 'fixture done' }
    })
    let hookCalls = 0
    let contextText = 'CONTEXT_WIRE_FIRST'
    try {
      const baseUrl = capture.baseUrl(api)
      const model = fakeModel({ route: 'wire', id: 'fixture', api, baseUrl })
      const { host } = await createTestHost({
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        packages: {
          '@agnes/code': { operations: codeOperations },
          '@agnes/base': {
            ecosystem: {
              ...baseEcosystem,
              'agnes/hooks-runner':
                (_init: Parameters<(typeof baseEcosystem)['agnes/hooks-runner']>[0]) =>
                (api: Parameters<ReturnType<(typeof baseEcosystem)['agnes/hooks-runner']>>[0]) =>
                  api.registerHook('context', () => {
                    hookCalls++
                    return { additionalContext: contextText }
                  }),
            },
          },
        },
        disableSessionTitle: true,
        profileInputs: {
          user: {
            name: 'wire-context',
            provider: {
              package: '@agnes/ai',
              adapters: ['@agnes/ai'],
              routes: [{ route: 'wire', api, baseUrl, credentialRef: 'secret://test/wire', models: [model] }],
            },
            adapters: { secrets: { kind: 'file', path: credentials } },
          },
        },
      })
      try {
        const session = await host.createSession({ cwd: dataDir })
        await session.enqueue('next-turn', {
          content: [{ type: 'text', text: 'Read probe.txt twice.' }],
          actor: session.d.actor,
          kind: 'prompt',
        })
        const firstRun = await session.run({ until: 'turn-end', signal: new AbortController().signal })
        if (firstRun.reason !== 'completed') throw new Error(JSON.stringify({ firstRun, hookCalls }))
        expect(capture.requests).toHaveLength(3)
        expect(hookCalls).toBe(1)
        const [first, second, third] = capture.requests
        if (!first || !second || !third) throw new Error('missing first-turn loopback request')
        expectExtends(first, second)
        expectExtends(second, third)
        expect(JSON.stringify(first.body)).toContain('[hook context]')
        expect(JSON.stringify(first.body)).toContain('CONTEXT_WIRE_FIRST')

        contextText = 'CONTEXT_WIRE_SECOND'
        await session.enqueue('next-turn', {
          content: [{ type: 'text', text: 'Continue.' }],
          actor: session.d.actor,
          kind: 'prompt',
        })
        await expect(
          session.run({ until: 'turn-end', signal: new AbortController().signal }),
        ).resolves.toMatchObject({ reason: 'completed' })
        expect(hookCalls).toBe(2)
        const next = capture.requests[3]
        if (!next) throw new Error('missing next-turn loopback request')
        expectExtends(third, next)
        expect(JSON.stringify(next.body)).toContain('CONTEXT_WIRE_SECOND')
      } finally {
        await host.close()
      }
    } finally {
      await capture.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
