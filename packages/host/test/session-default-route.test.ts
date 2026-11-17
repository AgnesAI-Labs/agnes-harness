import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import type { RouteDecl } from '@agnes/protocol'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
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

it('offers a child only the built-in routes that have credentials, and offers one again after its key is added', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-default-route-'))
  dirs.push(dataDir)
  const secrets = join(dataDir, 'credentials')
  createPrivateDirectorySync(secrets)
  // No `provider`: this is the production assembly, which fits every built-in API-key route.
  const { host } = await createTestHost({
    dataDir,
    profileInputs: {
      user: {
        name: 'local-dev',
        provider: { package: '@agnes/ai', routes: [chatRoute] },
        adapters: { secrets: { kind: 'file', path: secrets } },
      },
    },
  })
  try {
    const session = await host.createSession({ cwd: dataDir, key: 'child-credentials' })
    const offered = async () =>
      [...new Set((await session.d.children.models?.())?.map((model) => model.route))].sort()
    const start = (model: string) =>
      session.d.children.create({ parent: session.key, cwd: dataDir, input: 'task', model })
    const builtin = session.d.provider.models().find((model) => model.route === 'anthropic')
    if (!builtin) throw new Error('fixture built-in route missing')
    // The profile's own route stays; no built-in route has a key yet.
    expect(await offered()).toEqual(['gw'])
    // The list and the start agree: the unlisted model is refused before a child exists.
    await expect(start(`anthropic/${builtin.id}`)).rejects.toMatchObject({
      code: 'E_MODEL_UNKNOWN',
      detail: { route: 'anthropic', reason: 'no-credential' },
    })
    expect(await session.d.children.list?.()).toEqual([])

    // The key arrives after start-up. The product republishes the model profile when configuration
    // changes; that rebuild reads the credentials again.
    createPrivateDirectorySync(join(secrets, 'anthropic'))
    const file = createPrivateFileSync(join(secrets, 'anthropic', 'default'))
    try {
      writeFileSync(file, 'synthetic-anthropic-key')
    } finally {
      closeSync(file)
    }
    await host.applyModelProfile(structuredClone(host.profile))
    expect(await offered()).toEqual(['anthropic', 'gw'])
    expect((await start(`anthropic/${builtin.id}`)).key).toBeDefined()
  } finally {
    await host.close()
  }
})
