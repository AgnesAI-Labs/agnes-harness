import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanAll } from '@agnes/core'
import { actor, fakeProvider, textTurn } from '@agnes/core/testkit'
import { assertRuntimeRecord, type JsonValue } from '@agnes/jev-runtime'
import { expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

it('keeps installed Skills off the JevLoop mount and discovery prompt without changing Native tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-jev-skill-bind-'))
  const provider = fakeProvider([textTurn('Instructions read.')])
  const resourceId = `skill/user/user-agnes/${'a'.repeat(64)}`
  const { host } = await createTestHost({
    dataDir: root,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base/', import.meta.url)) },
    provider,
    disableSessionTitle: true,
    skillResources: {
      list: () => [
        {
          kind: 'skill',
          resourceId,
          name: 'review',
          description: 'Review source changes.',
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
      read: () => ({ ok: true, content: 'Inspect the diff before reporting.', revision: 'b'.repeat(64) }),
      readFile: () => ({ ok: false, code: 'NOT_FOUND' }),
    },
    jev: {
      decision: {
        backend: 'jev',
        endpoint: 'https://jev.invalid/v1',
        model: 'jev-test',
        transport: {
          async invoke({ questions }) {
            expect(questions.binding_skill_read).toBeUndefined()
            const answers: Record<string, JsonValue> = {}
            for (const [name, question] of Object.entries(questions)) {
              const criteria = (question as { criteria?: Record<string, unknown> }).criteria
              if (!criteria) continue
              expect(criteria).not.toHaveProperty('skill_read')
              if (name === 'purpose' || name === 'operation_RESPOND')
                answers[name] = {
                  type: 'choice',
                  choice: 'RESPOND',
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    Object.keys(criteria).map((key) => [key, key === 'RESPOND' ? 1 : 0]),
                  ),
                }
            }
            return { output: { answers }, observedModel: 'jev-test' }
          },
        },
      },
    },
  })
  try {
    const native = await host.createSession({ cwd: root, key: 'native-skills', runtime: 'native' })
    expect(native.currentTools().resolve('skill_read')).toBeDefined()
    const session = await host.createSession({ cwd: root, runtime: 'jevloop' })
    expect(session.currentTools().resolve('skill_read')).toBeUndefined()
    await session.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'Review the available code instructions.' }],
    })
    const result = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(result).toMatchObject({ reason: 'completed' })
    const records = (await scanAll((query) => session.scan(query), { toSeq: session.lastSeq }))
      .filter((row) => row.type === 'runtime/record')
      .map((row) => {
        const record = (row.data as { record: unknown }).record
        assertRuntimeRecord(record)
        return record
      })
    expect(records.filter((r) => r.kind === 'action.intended')).toEqual([])
    expect(
      records.filter(
        (r) => r.kind === 'resource.observed' && JSON.stringify(r.resource).includes('jev.skill-catalog.v1'),
      ),
    ).toHaveLength(1)
    expect(
      records.filter((r) => r.kind === 'model.requested' && r.call.purpose === 'parameters'),
    ).toHaveLength(0)
    expect(provider.requests).toHaveLength(1)
    expect(JSON.stringify(provider.requests[0])).not.toContain('Inspect the diff before reporting.')
    expect(JSON.stringify(provider.requests[0])).not.toContain('<available_skills>')
    expect(provider.requests[0]?.tools.some((tool) => tool.name === 'skill_read')).toBe(false)
    await native.close()
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})
