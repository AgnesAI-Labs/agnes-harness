import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { operations as codeOperations } from '@agnes/code'
import {
  type LoopContext,
  type LoopFactory,
  type LoopStepOutcome,
  loopCheckpointCodec,
  loopKind,
} from '@agnes/extension-api'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import { createTestHost, expectExtends, startWireCapture, type WireApi } from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const apis: readonly WireApi[] = ['anthropic-messages', 'openai-completions', 'openai-responses']
const LOOP = Object.freeze({ id: 'test.tail-note', version: '1.0.0' })
const NOTES = ['Note 1: answer in one line.', 'Note 2: name the file.', 'Note 3: stop here.']

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

const codec = loopCheckpointCodec(1, (state) => {
  if (state !== null) throw new Error('Unexpected tail-note loop state')
  return null
})

/** A loop that sends one request per note, each note committed, and records each reply it gets. */
function noteLoop(): LoopFactory {
  const create = (ctx: LoopContext) => ({
    cancel() {},
    dispose() {},
    checkpoint: () => codec.encode(null),
    async step(signal: AbortSignal): Promise<LoopStepOutcome> {
      if (!(await ctx.input.claim('next-turn'))) return { outcome: 'idle', phase: 'idle' }
      for (const text of NOTES) {
        const events = await ctx.model.complete(
          await ctx.prepareRequest({ tailNote: { text, commit: true } }),
          signal,
        )
        const reply = events.flatMap((event) => (event.type === 'text_delta' ? [event.delta] : [])).join('')
        await ctx.events.assistant(
          { content: [{ type: 'text', text: reply }], stopReason: 'end_turn' },
          codec.encode(null),
        )
      }
      return ctx.events.finish('completed')
    },
  })
  return { ...LOOP, codec, capabilities: ['model'], create, resume: create }
}

const loopRow = () => ({
  declaration: {
    id: 'loop:test.tail-note',
    export: 'tailNoteLoop',
    apiRange: '^5.0.0',
    default: true,
    inject: ['providers'],
    provide: [],
    runtime: 'in-process' as const,
  },
  entry: normalizePluginExport({
    inject: ['providers'],
    apply(ctx: { providers: { register(kind: unknown, value: unknown): void } }) {
      ctx.providers.register(loopKind, noteLoop())
    },
  }),
})

describe('loop tail notes on the provider wire', () => {
  it.each(apis)('%s sends each request with committed notes as a prefix of the next', async (api) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-wire-tail-note-'))
    const credentials = writeWireCredential(dataDir)
    const capture = await startWireCapture(() => ({ text: 'fixture reply' }))
    try {
      const baseUrl = capture.baseUrl(api)
      const model = fakeModel({ route: 'wire', id: 'fixture', api, baseUrl })
      const { host } = await createTestHost({
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        packages: { '@agnes/code': { operations: codeOperations, plugins: [loopRow()] } },
        disableSessionTitle: true,
        profileInputs: {
          user: {
            name: 'wire-prefix',
            provider: {
              package: '@agnes/ai',
              routes: [{ route: 'wire', api, baseUrl, credentialRef: 'secret://test/wire', models: [model] }],
            },
            adapters: { secrets: { kind: 'file', path: credentials } },
          },
        },
      })
      try {
        const session = await host.createSession({ cwd: dataDir, loop: LOOP })
        await session.enqueue('next-turn', {
          content: [{ type: 'text', text: 'Which file holds the refund window?' }],
          actor: session.d.actor,
          kind: 'prompt',
        })
        await expect(
          session.run({ until: 'turn-end', signal: new AbortController().signal }),
        ).resolves.toMatchObject({ reason: 'completed' })
        const [first, second, third] = capture.requests
        if (!first || !second || !third) throw new Error('missing loopback request')
        expect(capture.requests).toHaveLength(3)
        expectExtends(first, second)
        expectExtends(second, third)
        for (const [i, request] of capture.requests.entries()) {
          const raw = JSON.stringify(request.body)
          for (const [n, note] of NOTES.entries()) expect(raw.includes(note)).toBe(n <= i)
        }
      } finally {
        await host.close()
      }
    } finally {
      await capture.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
