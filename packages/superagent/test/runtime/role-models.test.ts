import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsSchema } from '../../src/policy.js'
import { modelCatalog, RoleModels, resolveRoleModel } from '../../src/runtime/role-models.js'
import { SessionRegistry, Sessions } from '../../src/runtime/sessions.js'
import { fakeClient } from './fake-sdk.js'
import { tempStore, ticket } from './helpers.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

const routes = [
  { route: 'deepseek', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { route: 'openai', models: ['gpt-5'] },
  { route: 'off', models: ['x'], enabled: false },
]
function roles(evalModel: unknown, executorModel: unknown) {
  temp.store.saveSettings(
    SettingsSchema.parse({ eval: { model: evalModel }, executor: { model: executorModel } }),
  )
}
function setup() {
  const fake = fakeClient({ routes })
  const registry = new SessionRegistry(temp.store)
  const models = new RoleModels({ client: fake.client, store: temp.store })
  const sessions = new Sessions({
    client: fake.client,
    registry,
    orchestratorDir: () => temp.dir,
    prepareCommand: () => '',
    environment: () => ({}),
    applyModel: (role, session) => models.apply(role, session),
    lifetime: new AbortController().signal,
  })
  models.bind(sessions, registry)
  const setModels = (id: string) =>
    fake.sessions
      .get(id)!
      .calls.filter((call) => call.method === 'setModel')
      .map((call) => call.args[0])
  return { fake, sessions, models, setModels }
}

describe('role models', () => {
  it("maps a role's provider, model and reasoning effort to the AGH route, model and thinking level", async () => {
    expect(
      await resolveRoleModel(fakeClient({ routes }).client, {
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        reasoningEffort: 'high',
      }),
    ).toEqual({ slot: 'primary', route: 'deepseek', model: 'deepseek-reasoner', thinking: 'high' })
    // A configured route is required; its model list is not a restriction.
    expect(
      await resolveRoleModel(fakeClient({ routes }).client, { provider: 'openai', model: 'gpt-5-mini' }),
    ).toEqual({ slot: 'primary', route: 'openai', model: 'gpt-5-mini' })
    await expect(
      resolveRoleModel(fakeClient({ routes }).client, { provider: 'nope', model: 'm' }),
    ).rejects.toThrow(/route nope/)
    await expect(
      resolveRoleModel(fakeClient({ routes }).client, { provider: 'off', model: 'x' }),
    ).rejects.toThrow(/route off/)
    await expect(
      resolveRoleModel(fakeClient({ routes }).client, {
        provider: 'openai',
        model: 'gpt-5',
        reasoningEffort: 'huge',
      }),
    ).rejects.toThrow(/huge/)
  })

  it('selects each role model when its session is created, and none when the role has none', async () => {
    roles({ provider: 'deepseek', model: 'deepseek-chat' }, null)
    const { sessions, setModels } = setup()
    const main = await sessions.ensureOrchestrator()
    const worker = await sessions.ensureWorker(ticket('t1'), `${temp.dir}/w1`)
    expect(setModels(main)).toEqual([{ slot: 'primary', route: 'deepseek', model: 'deepseek-chat' }])
    expect(setModels(worker)).toEqual([])
  })

  it("applies a changed setting to the role's open sessions with setModel", async () => {
    roles(null, { provider: 'openai', model: 'gpt-5' })
    const { sessions, models, setModels } = setup()
    const main = await sessions.ensureOrchestrator()
    const worker = await sessions.ensureWorker(ticket('t1'), `${temp.dir}/w1`)
    await models.sync()
    expect(setModels(worker)).toEqual([{ slot: 'primary', route: 'openai', model: 'gpt-5' }])
    roles(null, { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' })
    await models.sync()
    expect(setModels(main)).toEqual([])
    expect(setModels(worker)).toEqual([
      { slot: 'primary', route: 'openai', model: 'gpt-5' },
      { slot: 'primary', route: 'deepseek', model: 'deepseek-reasoner', thinking: 'max' },
    ])
  })

  it('lists the models AGH has configured, by route', async () => {
    expect(await modelCatalog(fakeClient({ routes }).client)).toEqual({
      default: { route: 'deepseek', model: 'deepseek-chat' },
      groups: [
        {
          id: 'deepseek',
          name: 'deepseek',
          models: [
            { id: 'deepseek-chat', name: 'deepseek-chat' },
            { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
          ],
        },
        { id: 'openai', name: 'openai', models: [{ id: 'gpt-5', name: 'gpt-5' }] },
      ],
      failures: [],
    })
  })
})
