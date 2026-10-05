import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { operations as codeOperations } from '@agnes/code'
import type { JsonValue } from '@agnes/jev-runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import {
  createTestHost,
  expectExtends,
  runOnce,
  startWireCapture,
  type WireApi,
} from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const apis: readonly WireApi[] = ['anthropic-messages', 'openai-completions', 'openai-responses']

function writeWireCredential(dataDir: string): string {
  const credentials = join(dataDir, 'credentials')
  createPrivateDirectorySync(credentials)
  createPrivateDirectorySync(join(credentials, 'test'))
  const file = createPrivateFileSync(join(credentials, 'test', 'wire'))
  try {
    writeFileSync(file, 'synthetic-wire-capture')
  } finally {
    closeSync(file)
  }
  return credentials
}

describe('real provider wire prefix baseline', () => {
  it('keeps the complete Jev wire prefix across a date change and session reopen', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-jev-wire-prefix-'))
    const credentials = writeWireCredential(dataDir)
    const capture = await startWireCapture(() => ({ text: 'fixture reply' }))
    try {
      const api = 'openai-completions'
      const baseUrl = capture.baseUrl(api)
      const model = fakeModel({
        route: 'wire',
        id: 'fixture',
        api,
        baseUrl,
        compat: { supportsMidConvoSystemMessages: true, supportsDeveloperRole: false },
      })
      const { host } = await createTestHost({
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        packages: { '@agnes/code': { operations: codeOperations } },
        disableSessionTitle: true,
        jev: {
          decision: {
            backend: 'jev',
            endpoint: 'https://jev.invalid/v1',
            model: 'fixture',
            transport: {
              async invoke({ questions }) {
                const answers: Record<string, JsonValue> = {}
                for (const name of ['purpose', 'operation_RESPOND']) {
                  const criteria = (questions[name] as { criteria?: Record<string, unknown> })?.criteria
                  if (!criteria) continue
                  answers[name] = {
                    type: 'choice',
                    choice: 'RESPOND',
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      Object.keys(criteria).map((key) => [key, key === 'RESPOND' ? 1 : 0]),
                    ),
                  }
                }
                return { output: { answers } }
              },
            },
          },
        },
        profileInputs: {
          user: {
            name: 'jev-wire-prefix',
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
        let session = await host.createSession({ cwd: dataDir, runtime: 'jevloop' })
        const dates = [2, 3, 3, 4]
        for (const [index, day] of dates.entries()) {
          if (index === 3) {
            const key = session.key
            await session.close()
            session = await host.createSession({ key, cwd: dataDir })
          }
          session.d.clock = () => Date.UTC(2026, 0, day)
          await session.enqueue('next-turn', {
            content: [{ type: 'text', text: `Question ${index + 1}` }],
            actor: session.d.actor,
            kind: 'prompt',
          })
          await expect(
            session.run({ until: 'turn-end', signal: new AbortController().signal }),
          ).resolves.toMatchObject({ reason: 'completed' })
        }
        expect(capture.requests).toHaveLength(dates.length)
        for (const [index, request] of capture.requests.entries()) {
          const body = request.body as { tools: unknown; messages: { role: string; content: unknown }[] }
          // Check the serializer's original message ordering, not a grouping of system roles.
          const previous = capture.requests[index - 1]
          if (previous) {
            const before = previous.body as typeof body
            expect(JSON.stringify(body.tools)).toBe(JSON.stringify(before.tools))
            expect(JSON.stringify(body.messages.slice(0, before.messages.length))).toBe(
              JSON.stringify(before.messages),
            )
          }
          expect(body.messages[0]?.role).toBe('system')
          expect(JSON.stringify(body.messages[0])).not.toContain('[runtime context]\\n')
          const snapshots = body.messages.filter(
            (message) =>
              message.role === 'user' && JSON.stringify(message.content).includes('[runtime context]\\n'),
          )
          const snapshotCount = [1, 2, 2, 3][index]
          if (snapshotCount === undefined) throw new Error('Unexpected wire request')
          expect(snapshots).toHaveLength(snapshotCount)
          expect(JSON.stringify(snapshots.at(-1))).toContain(`2026-01-0${dates[index]}`)
        }
      } finally {
        await host.close()
      }
    } finally {
      await capture.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it.each(apis)('%s keeps tools, system and prior messages on a normal append-only turn', async (api) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-wire-prefix-'))
    const credentials = writeWireCredential(dataDir)
    const capture = await startWireCapture(() => ({ text: 'fixture reply' }))
    try {
      const baseUrl = capture.baseUrl(api)
      const model = fakeModel({ route: 'wire', id: 'fixture', api, baseUrl })
      const { host } = await createTestHost({
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        packages: { '@agnes/code': { operations: codeOperations } },
        disableSessionTitle: true,
        profileInputs: {
          user: {
            name: 'wire-prefix',
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
        for (const prompt of ['First question', 'Second question']) {
          await session.enqueue('next-turn', {
            content: [{ type: 'text', text: prompt }],
            actor: session.d.actor,
            kind: 'prompt',
          })
          await expect(
            session.run({ until: 'turn-end', signal: new AbortController().signal }),
          ).resolves.toMatchObject({ reason: 'completed' })
        }
        expect(capture.requests).toHaveLength(2)
        const first = capture.requests[0]
        const second = capture.requests[1]
        if (!first || !second) throw new Error('missing loopback request')
        expectExtends(first, second)
      } finally {
        await host.close()
      }
    } finally {
      await capture.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it.each(apis)('%s fixture carries a tool call and its result in the next request', async (api) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-wire-tool-'))
    writeFileSync(join(dataDir, 'probe.txt'), 'fixture file body')
    const credentials = writeWireCredential(dataDir)
    let requests = 0
    const capture = await startWireCapture(() => {
      requests++
      return requests === 1
        ? { toolCall: { name: 'read', args: { path: 'probe.txt' } } }
        : { text: 'fixture done' }
    })
    try {
      const baseUrl = capture.baseUrl(api)
      const model = fakeModel({ route: 'wire', id: 'fixture', api, baseUrl })
      const { host } = await createTestHost({
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        packages: { '@agnes/code': { operations: codeOperations } },
        disableSessionTitle: true,
        profileInputs: {
          user: {
            name: 'wire-prefix',
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
        const result = await runOnce(host, { cwd: dataDir, prompt: 'Read probe.txt.' })
        expect(result.reason).toBe('completed')
        expect(result.toolCalls).toContain('read')
        expect(capture.requests).toHaveLength(2)
        const [first, second] = capture.requests
        if (!first || !second) throw new Error('missing loopback request')
        expectExtends(first, second)
        expect(JSON.stringify(second.body)).toContain('fixture file body')
      } finally {
        await host.close()
      }
    } finally {
      await capture.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
