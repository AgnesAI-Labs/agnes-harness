import type { SystemPromptSnapshot } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { SystemPromptConflict, systemPromptApi } from '../src/settings/system-prompt-api.js'

const current: SystemPromptSnapshot = {
  config: { personaPrefix: 'saved elsewhere' },
  effect: 'new-sessions',
  hash: 'a'.repeat(64),
  revision: 'b'.repeat(64),
  sections: [],
  preview: 'default-sections',
}

it('turns a revision conflict into an error that carries the value saved elsewhere', async () => {
  const sent: unknown[] = []
  const api = systemPromptApi(async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response(
      JSON.stringify({
        error: { code: -32010, message: 'conflict', data: { code: 'CONFIG_REVISION_CONFLICT', current } },
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )
  })
  const failure = await api
    .save({ config: { personaPrefix: 'mine' }, expectedRevision: 'c'.repeat(64) })
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(SystemPromptConflict)
  expect((failure as SystemPromptConflict).current).toEqual(current)
  expect(sent).toEqual([{ config: { personaPrefix: 'mine' }, expectedRevision: 'c'.repeat(64) }])
})
