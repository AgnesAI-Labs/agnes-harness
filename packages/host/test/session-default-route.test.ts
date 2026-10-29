import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import type { RouteDecl } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const chatModel = fakeModel({ id: 'chat-1', route: 'gw' })
const jevModel = fakeModel({
  id: 'typesafe/jev-1.13-20260917',
  route: 'jev',
  api: 'typesafe-systemone',
  input: ['text'],
})
const chatRoute: RouteDecl = {
  route: 'gw',
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:1/v1',
  models: [chatModel],
}
const jevRoute: RouteDecl = {
  route: 'jev',
  api: 'typesafe-systemone',
  baseUrl: 'http://127.0.0.1:1/v1',
  models: [jevModel],
}

async function sessionSlots(routes: RouteDecl[]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-default-route-'))
  dirs.push(dataDir)
  const { host } = await createTestHost({
    dataDir,
    provider: new ScriptedProvider({ scripts: [], models: [chatModel, jevModel] }),
    profileInputs: { user: { name: 'local-dev', provider: { package: '@agnes/ai', routes } } },
  })
  try {
    const session = await host.createSession({ cwd: dataDir, key: 'default-route' })
    return { ...session.preset.model.route }
  } finally {
    await host.close()
  }
}

it('keeps the built-in payload-only route out of every slot a preset leaves at default', async () => {
  // The payload-only route is declared first, which is where `default` used to land.
  const slots = await sessionSlots([jevRoute, chatRoute])
  expect(Object.keys(slots)).toContain('primary')
  expect(Object.values(slots)).not.toContain('jev')
  expect(slots.primary).toBe('gw')
})

it('leaves a profile without a payload-only route as it was', async () => {
  expect((await sessionSlots([chatRoute])).primary).toBe('gw')
})

it("keeps today's answer when the profile declares only the payload-only route", async () => {
  expect((await sessionSlots([jevRoute])).primary).toBe('jev')
})

it('leaves the payload-only route out of the models a child agent can choose, but not out of the catalog', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-default-route-'))
  dirs.push(dataDir)
  const { host } = await createTestHost({
    dataDir,
    provider: new ScriptedProvider({ scripts: [], models: [chatModel, jevModel] }),
    profileInputs: {
      user: { name: 'local-dev', provider: { package: '@agnes/ai', routes: [jevRoute, chatRoute] } },
    },
  })
  try {
    const session = await host.createSession({ cwd: dataDir, key: 'child-models' })
    const choices = (await session.d.children.models?.())?.map((model) => model.selector)
    expect(choices).toEqual(['gw/chat-1'])
    // Side calls resolve their target against the whole catalog.
    expect(session.d.provider.models().map((model) => model.route)).toContain('jev')
  } finally {
    await host.close()
  }
})
