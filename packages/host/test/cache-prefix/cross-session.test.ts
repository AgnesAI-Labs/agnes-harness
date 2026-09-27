import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { operations as codeOperations } from '@agnes/code'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import {
  type CapturedRequest,
  createTestHost,
  renderedParts,
  sharedPrefix,
  startWireCapture,
  type WireApi,
} from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const apis: readonly WireApi[] = ['anthropic-messages', 'openai-completions', 'openai-responses']

function wirePrefixBytes(request: CapturedRequest): { tools: string; system: string } {
  const body = request.body as Record<string, unknown>
  const messages = body.messages as Array<{ role?: string }> | undefined
  const input = body.input as Array<{ role?: string }> | undefined
  const system =
    request.api === 'openai-responses'
      ? input?.[0]
      : request.api === 'openai-completions'
        ? messages?.filter((message) => message.role === 'system')
        : body.system
  const tools = JSON.stringify(body.tools)
  const systemBytes = JSON.stringify(system)
  if (!tools || !systemBytes) throw new Error('missing wire tools or system')
  return { tools, system: systemBytes }
}

describe('cross-session wire prefix', () => {
  it.each(apis)('%s shares byte-identical tools and system across sessions in one workspace', async (api) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-wire-cross-session-'))
    const credentials = join(dataDir, 'credentials')
    createPrivateDirectorySync(credentials)
    createPrivateDirectorySync(join(credentials, 'test'))
    const credential = createPrivateFileSync(join(credentials, 'test', 'wire'))
    try {
      writeFileSync(credential, 'synthetic-wire-capture')
    } finally {
      closeSync(credential)
    }
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
            name: 'wire-cross-session',
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
        for (const key of ['wire-session-one', 'wire-session-two']) {
          const session = await host.createSession({ cwd: dataDir, key })
          await session.enqueue('next-turn', {
            content: [{ type: 'text', text: 'Same question.' }],
            actor: session.d.actor,
            kind: 'prompt',
          })
          await expect(
            session.run({ until: 'turn-end', signal: new AbortController().signal }),
          ).resolves.toMatchObject({ reason: 'completed' })
        }
        expect(capture.requests).toHaveLength(2)
        const [first, second] = capture.requests
        if (!first || !second) throw new Error('missing cross-session loopback requests')
        const firstParts = renderedParts(first)
        // Responses carries Agnes's system text as its first system/developer input item.
        const systemKey = api === 'openai-responses' ? 'input[0]' : 'system'
        if (api === 'openai-responses') {
          const input = (first.body as { input?: Array<{ role?: string }> }).input
          expect(['system', 'developer']).toContain(input?.[0]?.role)
        }
        expect(firstParts.slice(0, 2).map((part) => part.key)).toEqual(['tools', systemKey])
        const before = wirePrefixBytes(first)
        const after = wirePrefixBytes(second)
        expect(before.tools.length).toBeGreaterThan(2)
        expect(before.system.length).toBeGreaterThan(2)
        expect(before.tools === after.tools).toBe(true)
        expect(before.system === after.system).toBe(true)
        expect(sharedPrefix(first, second).breakAt).toMatch(/^(?:messages|input)\[/u)
        expect(JSON.stringify(first.body)).toContain('wire-session-one')
        expect(JSON.stringify(second.body)).toContain('wire-session-two')
      } finally {
        await host.close()
      }
    } finally {
      await capture.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
