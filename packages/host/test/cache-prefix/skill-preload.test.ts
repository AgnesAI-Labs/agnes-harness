import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { operations as codeOperations } from '@agnes/code'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import type { SkillRuntimeInput } from '../../src/resources/skills.js'
import { createTestHost, expectExtends, startWireCapture, type WireApi } from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const apis: readonly WireApi[] = ['anthropic-messages', 'openai-completions', 'openai-responses']
const resourceId = `skill/user/user-agnes/${'a'.repeat(64)}`
const skillBody = 'SKILL_WIRE_BODY_SENTINEL'

function skillRuntime(reads: string[], content = skillBody): SkillRuntimeInput {
  return {
    list: () => [
      {
        kind: 'skill',
        resourceId,
        name: 'review',
        description: 'Review changes.',
        revision: 'b'.repeat(64),
        sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'c'.repeat(64) },
        priority: 400,
        resolution: { winner: true, shadowed: [] },
        trust: 'trusted',
        desired: 'enabled',
        actual: 'ready',
        stale: false,
      },
    ],
    read: (id) => {
      reads.push(id)
      return id === resourceId ? { ok: true, content } : { ok: false, code: 'NOT_FOUND' }
    },
    readFile: () => ({ ok: false, code: 'NOT_FOUND' }),
  }
}

function hostOptions(
  dataDir: string,
  api: WireApi,
  baseUrl: string,
  resources: SkillRuntimeInput,
): Parameters<typeof createTestHost>[0] {
  const model = fakeModel({ route: 'wire', id: 'fixture', api, baseUrl })
  return {
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    packages: { '@agnes/code': { operations: codeOperations } },
    skillResources: resources,
    disableSessionTitle: true,
    profileInputs: {
      user: {
        name: 'wire-skill',
        provider: {
          package: '@agnes/ai',
          adapters: ['@agnes/ai'],
          routes: [{ route: 'wire', api, baseUrl, credentialRef: 'secret://test/wire', models: [model] }],
        },
        adapters: { secrets: { kind: 'file', path: join(dataDir, 'credentials') } },
      },
    },
  }
}

function credentials(dataDir: string): void {
  const path = join(dataDir, 'credentials')
  createPrivateDirectorySync(path)
  createPrivateDirectorySync(join(path, 'test'))
  const credential = createPrivateFileSync(join(path, 'test', 'wire'))
  try {
    writeFileSync(credential, 'synthetic-wire-capture')
  } finally {
    closeSync(credential)
  }
}

type Session = Awaited<ReturnType<Awaited<ReturnType<typeof createTestHost>>['host']['createSession']>>

async function turn(session: Session, prompt: string): Promise<void> {
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text: prompt }],
    actor: session.d.actor,
    kind: 'prompt',
  })
  await expect(
    session.run({ until: 'turn-end', signal: new AbortController().signal }),
  ).resolves.toMatchObject({ reason: 'completed' })
}

describe('loaded Skill wire prefix', () => {
  it.each(apis)('%s keeps the system, tools and history stable as a Skill note is loaded', async (api) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-wire-skill-'))
    credentials(dataDir)
    const capture = await startWireCapture(() => ({ text: 'fixture reply' }))
    const reads: string[] = []
    try {
      const { host } = await createTestHost(
        hostOptions(dataDir, api, capture.baseUrl(api), skillRuntime(reads)),
      )
      try {
        const session = await host.createSession({ cwd: dataDir })
        for (const prompt of ['First question', 'Use $review', 'Continue the review', 'Use $review again']) {
          await session.enqueue('next-turn', {
            content: [{ type: 'text', text: prompt }],
            actor: session.d.actor,
            kind: 'prompt',
          })
          await expect(
            session.run({ until: 'turn-end', signal: new AbortController().signal }),
          ).resolves.toMatchObject({ reason: 'completed' })
        }
        expect(capture.requests).toHaveLength(4)
        const [first, loaded, after, repeated] = capture.requests
        if (!first || !loaded || !after || !repeated) throw new Error('missing loopback request')
        expectExtends(first, loaded)
        expectExtends(loaded, after)
        expectExtends(after, repeated)
        expect(JSON.stringify(first.body)).not.toContain(skillBody)
        expect(JSON.stringify(loaded.body)).toContain(skillBody)
        expect(JSON.stringify(after.body)).toContain(skillBody)
        expect(JSON.stringify(after.body).split(skillBody)).toHaveLength(2)
        expect(JSON.stringify(repeated.body).split(skillBody)).toHaveLength(2)
        // A later explicit mention may re-read the current revision, but present-note dedup
        // prevents adding a second copy to the model's history.
        expect(reads).toEqual([resourceId, resourceId])
      } finally {
        await host.close()
      }
    } finally {
      await capture.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('leaves a Skill above 32 KiB out of the wire history without hiding read tools', async () => {
    const api: WireApi = 'openai-completions'
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-wire-skill-long-'))
    credentials(dataDir)
    const capture = await startWireCapture(() => ({ text: 'fixture reply' }))
    const reads: string[] = []
    try {
      const { host } = await createTestHost(
        hostOptions(dataDir, api, capture.baseUrl(api), skillRuntime(reads, 'X'.repeat(32 * 1024 + 1))),
      )
      try {
        const session = await host.createSession({ cwd: dataDir })
        await turn(session, 'First question')
        await turn(session, 'Use $review')
        const [first, attempted] = capture.requests
        if (!first || !attempted) throw new Error('missing long-Skill wire request')
        expectExtends(first, attempted)
        expect(JSON.stringify(attempted.body)).not.toContain('[skill loaded]')
        expect(JSON.stringify(attempted.body)).not.toContain('X'.repeat(200))
        const tools = (attempted.body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
        expect(tools.map((tool) => tool.function?.name)).toContain('skill_read')
        expect(tools.map((tool) => tool.function?.name)).toContain('tool_search')
        const notes = await session.d.log.scan({ type: 'user/message', limit: 100 })
        expect(notes.some((row) => JSON.stringify(row.data).includes('[skill loaded]'))).toBe(false)
        expect(reads).toEqual([resourceId])
      } finally {
        await host.close()
      }
    } finally {
      await capture.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('reopens the same Host session with one durable Skill note and an unchanged wire prefix', async () => {
    const api: WireApi = 'openai-completions'
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-wire-skill-reopen-'))
    credentials(dataDir)
    const capture = await startWireCapture(() => ({ text: 'fixture reply' }))
    const reads: string[] = []
    const options = hostOptions(dataDir, api, capture.baseUrl(api), skillRuntime(reads))
    try {
      const first = await createTestHost(options)
      try {
        const session = await first.host.createSession({ cwd: dataDir, key: 'skill-reopen' })
        await turn(session, 'Use $review')
        expect(capture.requests).toHaveLength(1)
      } finally {
        await first.host.close()
      }
      const second = await createTestHost(options)
      try {
        const reopened = await second.host.createSession({ cwd: dataDir, key: 'skill-reopen' })
        await turn(reopened, 'Use $review again')
        const [before, after] = capture.requests
        if (!before || !after) throw new Error('missing before/after restart wire requests')
        expectExtends(before, after)
        expect(JSON.stringify(after.body).split('[skill loaded]')).toHaveLength(2)
        const rows = await reopened.d.log.scan({ type: 'user/message', limit: 100 })
        expect(rows.filter((row) => JSON.stringify(row.data).includes('[skill loaded]'))).toHaveLength(1)
        expect(reads).toEqual([resourceId, resourceId])
      } finally {
        await second.host.close()
      }
    } finally {
      await capture.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
