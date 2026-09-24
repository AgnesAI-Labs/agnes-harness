import type { HookContext, HookHandler, ResourceEntry } from '@agnes/extension-api'
import { unavailableProjections } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { platformFacts } from '../src/effects/platform-facts.js'
import { SeamRuntime } from '../src/effects/wrap.js'
import { HookEngine } from '../src/hooks/engine.js'
import { discoverResources } from '../src/hooks/resources.js'
import { ResourceRegistry } from '../src/registry/resources.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor } from './helpers/open-session.js'

const platform = platformFacts(fakeSeams().platform)
const meta = { source: 'agnes/discover', trust: 'trusted' as const }
const entry = (id: string): ResourceEntry => ({ id, kind: 'skill', name: id, description: id })
const context = (): HookContext => ({
  session: { key: 's', lane: 'main', workspaceRoot: '/workspace' },
  projections: unavailableProjections,
  replayed: false,
  signal: new AbortController().signal,
  lease: { expiresAt: '2099-01-01T00:00:00Z', scope: {}, budget: { remaining: 1 } },
  log: { debug() {}, info() {}, warn() {}, error() {} },
  platform,
})
const engine = () => new HookEngine({ diag() {}, onFailure() {}, platform })

it('passes accumulated candidates through real hooks and authorizes registered and returned entries', async () => {
  const registry = new ResourceRegistry(),
    e = engine(),
    calls: unknown[] = []
  registry.register(entry('registered'), meta)
  e.on(
    'resources_discover',
    (p, c) => {
      expect(p.registered.map((r) => r.id)).toEqual(['registered'])
      expect(c.replayed).toBe(true)
      return { resources: [entry('allowed'), entry('denied'), entry('approval')], additionalContext: 'note' }
    },
    meta,
  )
  e.on(
    'resources_discover',
    (p) => {
      expect(p.registered.map((r) => r.id)).toEqual(['registered', 'allowed', 'denied', 'approval'])
      return { resources: [entry('unavailable')] }
    },
    meta,
  )
  const runtime = new SeamRuntime(
    fakeSeams({
      principals: {
        authorize: async (a, action, target) => {
          calls.push({ actor: a, action, target })
          if (target.id === 'unavailable') throw new Error('private detail')
          return {
            decisionId: target.id,
            effect: target.id === 'denied' ? 'deny' : target.id === 'approval' ? 'require_approval' : 'allow',
            reason: 'policy',
          }
        },
      },
    }),
    presetDefaults(),
    { clock: () => 0, onFailure() {} },
  )
  const result = await discoverResources(
    e,
    { registered: () => registry.snapshot(), actor: () => actor, cwd: () => '/w', principals: runtime },
    { ...context(), replayed: true },
  )
  expect(result.resources.map((r) => r.id)).toEqual(['registered', 'allowed'])
  expect(calls).toEqual(
    ['registered', 'allowed', 'denied', 'approval', 'unavailable'].map((id) => ({
      actor,
      action: 'discover',
      target: { kind: 'skill', id },
    })),
  )
  expect(result.contributions).toEqual([{ ext: meta.source, result: { additionalContext: 'note' } }])
})

it('does not admit malformed hook output and still runs later open-policy handlers', async () => {
  const e = engine()
  e.on(
    'resources_discover',
    (() => ({ resources: [{ ...entry('bad'), extra: true }] })) as HookHandler<'resources_discover'>,
    meta,
  )
  e.on(
    'resources_discover',
    (p) => {
      expect(p.registered).toEqual([])
      return { resources: [entry('good')] }
    },
    meta,
  )
  const result = await discoverResources(
    e,
    {
      registered: () => [],
      actor: () => actor,
      cwd: () => '/w',
      principals: { authorize: async () => ({ effect: 'allow', decisionId: 'x', reason: 'x' }) },
    },
    context(),
  )
  expect(result.resources.map((r) => r.id)).toEqual(['good'])
})

it('cancellation stops waiting for an authorizer and withdraws the whole result', async () => {
  const registry = new ResourceRegistry(),
    controller = new AbortController(),
    e = engine()
  registry.register(entry('one'), meta)
  registry.register(entry('two'), meta)
  e.on('resources_discover', () => ({ additionalContext: 'withdraw me' }), meta)
  let reached: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    reached = resolve
  })
  const pending = discoverResources(
    e,
    {
      registered: () => registry.snapshot(),
      actor: () => actor,
      cwd: () => '/w',
      principals: {
        authorize: async (_a, _action, target) => {
          if (target.id === 'one') return { effect: 'allow', decisionId: '1', reason: 'allowed' }
          reached()
          return new Promise(() => undefined)
        },
      },
    },
    { ...context(), signal: controller.signal },
  )
  await ready
  controller.abort()
  expect(await pending).toEqual({ resources: [], contributions: [] })
})
