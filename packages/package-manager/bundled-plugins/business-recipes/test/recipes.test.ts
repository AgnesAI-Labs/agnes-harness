import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const load = (name: string) => import(new URL(`../src/${name}.js`, import.meta.url).href)
const slugs = ['support-intake', 'invoice-review', 'meeting-brief']
function row(slug = 'support-intake') {
  const pkg = JSON.parse(
    readFileSync(new URL(`../../../../../examples/recipes/${slug}/package.json`, import.meta.url), 'utf8'),
  )
  return { id: pkg.name, metadata: pkg.agnes.metadata, installation: 'enabled', trusted: true }
}
function fixture() {
  let binding = { availability: 'active' }
  const watchers = new Set<() => void>()
  const availability = {
    getSnapshot: () => binding,
    subscribe: (listener: () => void) => {
      watchers.add(listener)
      return () => watchers.delete(listener)
    },
  }
  const sessions = new Set<string>(),
    inputs = new Set<string>(),
    requests: unknown[] = []
  let lost = false
  const profile = {
    examples: {
      list: async () => slugs.map((slug) => row(slug)),
      inspect: async () => ({
        reviewId: 'review-1',
        integrity: 'hash-1',
        capabilityHash: 'cap-1',
        presentation: { capabilities: { model: true } },
      }),
      enable: async (...args: unknown[]) => {
        requests.push(args)
      },
      read: async () => ({ state: 'completed', sessionId: 'session-1' }),
    },
    launch: {
      prepare: async (id: string, choice: string) => {
        requests.push([id, choice])
        return { launchTicket: 'ticket-1', presentation: { bundle: choice, prompt: 'reviewed input' } }
      },
      start: async (ticket: string, operation: string) => {
        requests.push([ticket, operation])
        sessions.add(operation)
        inputs.add(operation)
        if (lost) {
          lost = false
          throw new Error('OUTCOME_UNKNOWN')
        }
        return { sessionId: 'session-1' }
      },
    },
  }
  return {
    profile,
    availability,
    watchers,
    sessions,
    inputs,
    requests,
    revoke() {
      binding = { availability: 'disabled' }
      for (const watcher of watchers) watcher()
    },
    loseReply() {
      lost = true
    },
  }
}

it('distinguishes installation, trust, disable and legacy unknown instead of assuming authority', async () => {
  const { recipeState } = await load('controller')
  expect(
    ['not-installed', 'disabled', 'enabling', 'failed'].map((installation) =>
      recipeState({ installation, trusted: true }),
    ),
  ).toEqual(['not-installed', 'disabled', 'enabling', 'failed'])
  expect(recipeState({ installation: 'disabled', trusted: false })).toBe('untrusted')
  expect(recipeState({ installation: 'enabled' })).toBe('review-required')
  expect(recipeState(row())).toBe('ready')
  const { recipeInputs } = await load('controller')
  expect(recipeInputs({ metadata: { launches: [{ prompt: 'broken' }] } })).toEqual([])
})

it.each(slugs)(
  'validates declared %s parameters and executes a fake-model draft without external effects',
  async (slug) => {
    const { launchChoice } = await load('controller')
    const current = row(slug)
    const chosen = JSON.parse(current.metadata.launches[0].prompt)
    expect(launchChoice(current, chosen.fixture, 'en').prompt).toBe(current.metadata.launches[0].prompt)
    expect(() => launchChoice(current, '../../private', 'en')).toThrow('INVALID')
    expect(() => launchChoice(current, chosen.fixture, '$(upload)')).toThrow('INVALID')
    const recipe = await import(
      new URL(`../../../../../examples/recipes/${slug}/index.mjs`, import.meta.url).href
    )
    const signal = new AbortController().signal
    const ctx = {
      tools: { execute: async () => recipe.tools[0].execute({}, { signal }) },
      prepareRequest: async (request: unknown) => request,
      model: {
        complete: async () => [
          { type: 'text_delta', delta: 'Synthetic reviewed draft' },
          { type: 'done', reason: 'stop' },
        ],
      },
    }
    const output = await recipe.stages[0].run(ctx, { input: JSON.stringify(chosen) }, signal)
    expect(output).toMatchObject({
      draft: 'Synthetic reviewed draft',
      externalAction: false,
      evidence: { fixture: chosen.fixture },
    })
    await expect(
      recipe.stages[0].run(ctx, { input: JSON.stringify({ ...chosen, source: '/private' }) }, signal),
    ).rejects.toThrow('Invalid')
    await expect(recipe.stages[0].run(ctx, { input: 'free text' }, signal)).rejects.toThrow('reviewed JSON')
    const aborted = AbortSignal.abort(new Error('cancelled'))
    await expect(recipe.stages[0].run(ctx, { input: JSON.stringify(chosen) }, aborted)).rejects.toThrow(
      'cancelled',
    )
    const failed = {
      ...ctx,
      model: { complete: async () => [{ type: 'error', message: 'synthetic model failure' }] },
    }
    await expect(recipe.stages[0].run(failed, { input: JSON.stringify(chosen) }, signal)).rejects.toThrow(
      'model failure',
    )
    expect(recipe.tools[0].meta).toMatchObject({ isReadOnly: true, replay: 'safe' })
    const testkit = '@agnes/plugin-runtime/testkit'
    const { driveLoop } = await import(testkit)
    const execute = async (call: { name: string }, runSignal: AbortSignal) => {
      if (call.name !== recipe.tools[0].name) throw new Error('Unexpected tool')
      return recipe.tools[0].execute({}, { signal: runSignal })
    }
    const run = await driveLoop(recipe.factory, {
      inputs: [{ content: [{ type: 'text', text: JSON.stringify(chosen) }] }],
      replies: [
        [
          { type: 'text_delta', delta: 'Synthetic reviewed draft' },
          { type: 'done', reason: 'stop' },
        ],
      ],
      tools: {
        execute,
        batch: async () => {
          throw new Error('Unexpected batch')
        },
      },
    })
    expect(run.finished[0]).toBe('completed')
    expect(run.checkpoint.state.data).toMatchObject({
      draft: 'Synthetic reviewed draft',
      externalAction: false,
    })
    const resumed = await driveLoop(recipe.factory, { checkpoint: run.checkpoint, until: 'idle' })
    expect(resumed.requests).toEqual([])

    const pkg = JSON.parse(
      readFileSync(new URL(`../../../../../examples/recipes/${slug}/package.json`, import.meta.url), 'utf8'),
    )
    const launch = current.metadata.launches[0]
    expect(
      pkg.agnes.bundles[launch.bundle.split('#')[1]].presets[launch.preset].providers['tool-policy'].provider,
    ).toBe(`recipe.${slug}`)
  },
)

it('previews and reviews without launching; preserves operation identity on a lost launch reply and revokes on disable', async () => {
  const { createRecipeController } = await load('controller')
  const f = fixture()
  let sequence = 0
  const c = createRecipeController(f.profile, f.availability, () => `operation-${++sequence}`)
  await c.refresh()
  expect(f.sessions.size).toBe(0)
  await c.inspect(row())
  expect(f.requests).toEqual([])
  await c.enable()
  expect(f.sessions.size).toBe(0)
  const chosen = JSON.parse(row().metadata.launches[0].prompt)
  await c.prepare(row(), chosen.fixture, 'en')
  expect(f.sessions.size).toBe(0)
  f.loseReply()
  await c.start()
  expect(c.getSnapshot().error).toBe('OUTCOME_UNKNOWN')
  const operation = c.getSnapshot().launch.operationId
  await c.read()
  expect(c.getSnapshot().receipt).toMatchObject({ state: 'completed', sessionId: 'session-1' })
  await c.start()
  expect(c.getSnapshot().launch.operationId).toBe(operation)
  expect(f.sessions.size).toBe(1)
  expect(f.inputs.size).toBe(1)
  f.revoke()
  expect(c.getSnapshot()).toMatchObject({ rows: [], launch: undefined, error: 'CAPABILITY_DENIED' })
  await c.start()
  expect(f.sessions.size).toBe(1)
  c.dispose()
  expect(f.watchers.size).toBe(0)
})

it('surfaces configuration and unknown failures with bilingual actionable guidance', async () => {
  const { copy, errorText } = await load('locale')
  expect(Object.keys(copy.en).sort()).toEqual(Object.keys(copy['zh-CN']).sort())
  for (const text of Object.values(copy) as Record<string, string>[]) {
    expect(errorText('E_MODEL_ROUTE', text)).toBe(text.config)
    expect(errorText('OUTCOME_UNKNOWN', text)).toBe(text.unknown)
    expect(errorText('E_PACKAGE_PREVIEW_STALE', text)).toBe(text.stale)
  }
})
