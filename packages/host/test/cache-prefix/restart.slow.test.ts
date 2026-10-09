import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { operations as codeOperations } from '@agnes/code'
import { fakeProvider, textTurn } from '@agnes/core/testkit'
import type { RequestBody } from '@agnes/protocol'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { expect, it } from 'vitest'
import {
  createTestHost,
  expectExtends,
  renderedParts,
  startWireCapture,
  type WireApi,
} from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))

async function prompt(
  session: Awaited<ReturnType<Awaited<ReturnType<typeof createTestHost>>['host']['createSession']>>,
  text: string,
  untrusted = false,
) {
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text }],
    actor: session.d.actor,
    kind: 'prompt',
    ...(untrusted ? { trust: 'untrusted' as const } : {}),
  })
  await expect(
    session.run({ until: 'turn-end', signal: new AbortController().signal }),
  ).resolves.toMatchObject({ reason: 'completed' })
}

function stablePrefix(previous: RequestBody, next: RequestBody): void {
  expect(next.tools).toEqual(previous.tools)
  expect(next.system).toBe(previous.system)
  expect(next.messages.slice(0, previous.messages.length).map((message) => message.content)).toEqual(
    previous.messages.map((message) => message.content),
  )
}

it.each(['anthropic-messages', 'openai-completions'] as const)(
  '%s keeps the shell-result wire prefix after a Host restart',
  async (api: WireApi) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-envelope-wire-restart-'))
    const credentials = join(dataDir, 'credentials')
    createPrivateDirectorySync(credentials)
    createPrivateDirectorySync(join(credentials, 'test'))
    const credential = createPrivateFileSync(join(credentials, 'test', 'wire'))
    try {
      writeFileSync(credential, 'synthetic-wire-capture')
    } finally {
      closeSync(credential)
    }
    let requests = 0
    const capture = await startWireCapture(() => {
      requests++
      return requests === 1
        ? { toolCall: { name: 'shell', args: { command: 'echo shell-fixture-body' } } }
        : { text: 'fixture reply' }
    })
    try {
      const baseUrl = capture.baseUrl(api)
      const model = fakeModel({ route: 'wire', id: 'fixture', api, baseUrl })
      const hostOptions = {
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        packages: { '@agnes/code': { operations: codeOperations } },
        disableSessionTitle: true,
        profileInputs: {
          user: {
            name: 'wire-restart',
            provider: {
              package: '@agnes/ai',
              adapters: ['@agnes/ai'],
              routes: [{ route: 'wire', api, baseUrl, credentialRef: 'secret://test/wire', models: [model] }],
            },
            adapters: { secrets: { kind: 'file' as const, path: credentials } },
          },
        },
      }
      const first = await createTestHost(hostOptions)
      try {
        const session = await first.host.createSession({ cwd: dataDir, key: 'envelope-wire-restart' })
        await prompt(session, 'Run the fixture shell command')
        await prompt(session, 'Continue')
        expect(capture.requests).toHaveLength(3)
        const before = capture.requests[2]
        if (!before) throw new Error('missing pre-restart wire request')
        expect(
          renderedParts(before).some(
            (part) => part.bytes.includes('shell-fixture-body') && part.bytes.includes('<untrusted id='),
          ),
        ).toBe(true)
        await first.host.close()
        const second = await createTestHost(hostOptions)
        try {
          const reopened = await second.host.createSession({ cwd: dataDir, key: 'envelope-wire-restart' })
          await prompt(reopened, 'Continue again')
          expect(capture.requests).toHaveLength(4)
          const after = capture.requests[3]
          if (!after) throw new Error('missing post-restart wire request')
          expectExtends(before, after)
          // The comparison must fail if a cold reopen remints the historical envelope id.
          const remintedRaw = after.raw.replaceAll('untrusted id=', 'untrusted id=0')
          expect(remintedRaw).not.toBe(after.raw)
          expect(() => expectExtends(before, { ...after, body: JSON.parse(remintedRaw) })).toThrow(
            'Wire prefix diverged',
          )
        } finally {
          await second.host.close()
        }
      } finally {
        await first.host.close()
      }
    } finally {
      await capture.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  },
)

it('keeps a historical untrusted envelope after a Host restart and session reopen', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-envelope-restart-'))
  const firstProvider = fakeProvider([textTurn('first turn'), textTurn('second turn')], '2')
  const hostOptions = {
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    packages: { '@agnes/code': { operations: codeOperations } },
    disableSessionTitle: true,
  }
  try {
    const first = await createTestHost({ ...hostOptions, provider: firstProvider })
    try {
      const session = await first.host.createSession({ cwd: dataDir, key: 'envelope-restart' })
      await prompt(session, 'untrusted fixture body', true)
      await prompt(session, 'Continue')
      expect(firstProvider.requests).toHaveLength(2)
      const before = firstProvider.requests[1]
      if (!before) throw new Error('missing pre-restart request')
      expect(JSON.stringify(before.messages)).toContain('untrusted fixture body')
      expect(JSON.stringify(before.messages)).toContain('<untrusted id=')
      const secondProvider = fakeProvider([textTurn('third turn')], '2')
      await first.host.close()
      const second = await createTestHost({ ...hostOptions, provider: secondProvider })
      try {
        const reopened = await second.host.createSession({ cwd: dataDir, key: 'envelope-restart' })
        await prompt(reopened, 'Continue again')
        const after = secondProvider.requests[0]
        if (!after) throw new Error('missing post-restart request')
        stablePrefix(before, after)
      } finally {
        await second.host.close()
      }
    } finally {
      await first.host.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('keeps the same envelope when a session is evicted and reopened in one Host', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-envelope-reopen-'))
  const provider = fakeProvider([textTurn('first'), textTurn('second'), textTurn('third')], '2')
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    packages: { '@agnes/code': { operations: codeOperations } },
    disableSessionTitle: true,
    provider,
  })
  try {
    const session = await host.createSession({ cwd: dataDir, key: 'envelope-reopen' })
    await prompt(session, 'untrusted fixture body', true)
    await prompt(session, 'Continue')
    const before = provider.requests[1]
    if (!before) throw new Error('missing pre-eviction request')
    await session.close()
    const reopened = await host.createSession({ cwd: dataDir, key: 'envelope-reopen' })
    await prompt(reopened, 'Continue again')
    const after = provider.requests[2]
    if (!after) throw new Error('missing post-eviction request')
    stablePrefix(before, after)
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
