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
  expectExtends,
  renderedParts,
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

/** The request's conversation parts, the request-only time note last. */
const messageParts = (request: CapturedRequest) =>
  renderedParts(request).filter((part) => /^(?:messages|input)\[\d+\]$/u.test(part.key))

describe('a timed turn on the provider wire', () => {
  it.each(apis)(
    '%s ends each request with the measured time and repeats only the history before it',
    async (api) => {
      const dataDir = mkdtempSync(join(tmpdir(), 'agnes-wire-turn-time-'))
      writeFileSync(join(dataDir, 'probe.txt'), 'fixture file body')
      const credentials = writeWireCredential(dataDir)
      let requests = 0
      const capture = await startWireCapture(() => {
        requests++
        return requests < 3
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
              name: 'wire-turn-time',
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
          const session = await host.createSession({ cwd: dataDir })
          await session.enqueue('next-turn', {
            content: [{ type: 'text', text: 'Read probe.txt twice.' }],
            actor: session.d.actor,
            kind: 'prompt',
            timeLimitMs: 600_000,
          })
          await expect(
            session.run({ until: 'turn-end', signal: new AbortController().signal }),
          ).resolves.toMatchObject({ reason: 'completed' })
          expect(capture.requests).toHaveLength(3)
          for (const [i, request] of capture.requests.entries()) {
            const parts = messageParts(request)
            expect(parts.at(-1)?.bytes).toContain('[turn time]')
            expect(parts.slice(0, -1).some((part) => part.bytes.includes('[turn time]'))).toBe(false)
            if (api === 'anthropic-messages') {
              // The breakpoint sits on the last history message, never on the request-only note.
              const messages = (request.body as { messages: unknown[] }).messages
              expect(JSON.stringify(messages.at(-1))).not.toContain('cache_control')
              expect(JSON.stringify(messages.at(-2))).toContain('cache_control')
            }
            const next = capture.requests[i + 1]
            if (next) expectExtends(request, next, { throughMessage: parts.length - 1 })
          }
        } finally {
          await host.close()
        }
      } finally {
        await capture.close()
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  )
})
