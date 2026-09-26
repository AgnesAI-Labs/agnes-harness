import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { operations as codeOperations } from '@agnes/code'
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
