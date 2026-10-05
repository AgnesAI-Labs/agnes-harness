import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateRuntime } from '@agnes/protocol/runtime'
import { expect, it, vi } from 'vitest'
import { createHostModelAdapterDeployment } from '../../src/runtime/model/model-deployment.js'
import type { ModelEgressOptions } from '../../src/runtime/model/model-egress.js'
import { modelJointFixture } from './model-joint-fixture.js'
import { must } from './network-secrets-fixture.js'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value')
  return value
}

it.each(['openai-completions', 'anthropic-messages'] as const)(
  'runs the selected %s runtime through Pi, C21 and final C22 use to a real HTTP peer',
  async (api) => {
    const f = await modelJointFixture(api)
    const logs: unknown[] = []
    const ambient = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected ambient fetch or catalogue probe')
    })
    const spies = ['log', 'warn', 'error', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation((...args) => {
        logs.push(args)
      }),
    )
    try {
      const effect = await f.execute()
      expect(effect.outcome, JSON.stringify(f.diagnostics)).toBe('succeeded')
      expect(validateRuntime('EffectResult', effect).ok).toBe(true)
      expect(f.observations).toHaveLength(1)
      const peer = required(f.observations[0])
      expect(peer.correctKey).toBe(true)
      expect(peer.path).toBe(api === 'anthropic-messages' ? '/v1/messages?beta=true' : '/v1/chat/completions')
      const body = JSON.parse(peer.body)
      expect(body).toMatchObject({ model: f.source.model.id, stream: true })
      expect(body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user' })]))
      expect(JSON.stringify(body)).toContain('hello')
      const sentHash = createHash('sha256').update(peer.body).digest('hex')
      expect(f.hashes).toEqual([sentHash])
      expect(f.wire).toEqual([{ hash: sentHash, redirect: 'error', markerOnly: true }])
      expect(f.uses()).toBe(1)
      expect(ambient).not.toHaveBeenCalled()
      expect(readFileSync(join(f.root, 'effect.json'), 'utf8')).toContain(sentHash)
      expect(readFileSync(join(f.root, 'effect.json'), 'utf8')).not.toContain(f.key)
      expect(JSON.stringify(effect)).toContain('joint answer')
      expect(JSON.stringify({ logs, diagnostics: f.diagnostics, wire: f.wire })).not.toContain(f.key)
      const recovered = await f.action.reconcile(f.frame, [], f.context)
      expect(recovered.kind).toBe('resolved')
      if (recovered.kind === 'resolved') expect(recovered.result).toEqual(effect)
    } finally {
      ambient.mockRestore()
      for (const spy of spies) spy.mockRestore()
      await f.close()
    }
  },
)

it.each(['revoke', 'cancel', 'replace owner'] as const)(
  'refuses %s while final C22 use is pending, without reaching the peer',
  async (mode) => {
    let entered!: () => void, resume!: () => void
    const pending = new Promise<void>((resolve) => {
      entered = resolve
    })
    const released = new Promise<void>((resolve) => {
      resume = resolve
    })
    const f = await modelJointFixture('openai-completions', 'normal', (options) => ({
      secrets: {
        use: async (...args) => {
          entered()
          await released
          return required(options.secrets).use(...args)
        },
      },
    }))
    try {
      const job = f.execute()
      await pending
      if (mode === 'revoke')
        must(
          await f.broker.revoke(
            { secretId: required(f.options.installation).handle.secretId, reason: 'test' },
            f.auth.call({}, true),
          ),
        )
      if (mode === 'cancel') f.abort.abort()
      if (mode === 'replace owner') f.options.current = () => true
      resume()
      expect((await job).outcome).not.toBe('succeeded')
      expect(f.observations).toEqual([])
      expect(f.diagnostics[0]).toMatchObject({
        detailCode:
          mode === 'revoke'
            ? 'model_egress_credential'
            : mode === 'cancel'
              ? 'model_egress_cancelled'
              : 'model_egress_binding',
      })
    } finally {
      resume()
      await f.close()
    }
  },
)

it.each([
  {
    name: 'undeclared target',
    patch: (o: ModelEgressOptions) => ({
      endpoints: o.endpoints?.map((item) => ({ ...item, target: { ...item.target, path: '/denied' } })),
    }),
    detail: 'model_egress_target',
  },
  {
    name: 'C21 deny',
    patch: (o: ModelEgressOptions) => ({
      network: {
        ...required(o.network),
        rules: required(o.network).rules.map((item) => ({ ...item, effect: 'deny' as const })),
      },
    }),
    detail: 'model_egress_network',
  },
  { name: 'missing C21', patch: () => ({ network: undefined }), detail: 'model_egress_missing' },
  { name: 'missing C22', patch: () => ({ secrets: undefined }), detail: 'model_egress_missing' },
  {
    name: 'missing C14',
    patch: (o: ModelEgressOptions) => {
      const network = { ...required(o.network) }
      Reflect.deleteProperty(network, 'identity')
      return { network }
    },
    detail: 'model_egress_missing',
  },
  { name: 'missing current owner', patch: () => ({ current: undefined }), detail: 'model_egress_missing' },
  {
    name: 'wrong binding',
    patch: (o: ModelEgressOptions) => ({
      installation: {
        ...required(o.installation),
        binding: { ...required(o.installation).binding, bindingId: 'another-binding' },
      },
    }),
    detail: 'model_egress_missing',
  },
  {
    name: 'wrong handle',
    patch: (o: ModelEgressOptions) => ({
      installation: {
        ...required(o.installation),
        handle: { ...required(o.installation).handle, handleId: 'another-handle' },
      },
    }),
    detail: 'model_send_refused',
  },
])('refuses $name without touching the peer', async ({ patch, detail }) => {
  const f = await modelJointFixture('openai-completions', 'normal', patch)
  try {
    const effect = await f.execute()
    expect(effect.outcome).not.toBe('succeeded')
    expect(f.observations).toEqual([])
    expect(f.uses()).toBe(0)
    if (f.diagnostics.length > 1)
      expect(f.diagnostics[0]).toMatchObject({ code: 'denied', detailCode: detail })
    else expect(effect.error?.detailCode).toBe(detail)
  } finally {
    await f.close()
  }
})

it.each(['revoked credential', 'retired source', 'no injection', 'cancel before send'] as const)(
  'refuses %s without touching the peer or falling back to global fetch',
  async (mode) => {
    const f = await modelJointFixture('openai-completions', 'normal', {}, mode !== 'no injection')
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected ambient fetch')
    })
    try {
      if (mode === 'revoked credential')
        must(
          await f.broker.revoke(
            { secretId: required(f.options.installation).handle.secretId, reason: 'test' },
            f.auth.call({}, true),
          ),
        )
      if (mode === 'retired source') f.retire()
      if (mode === 'cancel before send') f.abort.abort()
      const effect = await f.execute()
      expect(effect.outcome).not.toBe('succeeded')
      expect(f.observations).toEqual([])
      expect(globalFetch).not.toHaveBeenCalled()
      if (mode === 'revoked credential')
        expect(f.diagnostics[0]).toMatchObject({ code: 'denied', detailCode: 'model_egress_credential' })
      if (mode === 'no injection')
        expect(effect.error).toMatchObject({ code: 'denied', detailCode: 'model_egress_missing' })
    } finally {
      globalFetch.mockRestore()
      await f.close()
    }
  },
)

it.each(['openai-responses', 'google-generative-ai', 'bedrock-converse-stream'] as const)(
  'names unsupported %s at Host assembly before credential use',
  async (api) => {
    const f = await modelJointFixture()
    try {
      const source = { ...f.source, route: { ...f.source.route, api } }
      const deployment = createHostModelAdapterDeployment({ ...f.owner, current: () => true }, [
        { ...f.options, installation: { ...required(f.options.installation), api } },
      ])
      const fetch = deployment.egress?.(source, f.frame, f.context)
      expect(typeof fetch).toBe('function')
      const result = await deployment.withCredential(source, f.frame, f.context, async () => {
        throw new Error('Unsupported protocol consumed credential')
      })
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'incompatible', detailCode: 'model_egress_api' },
      })
      expect(f.uses()).toBe(0)
      expect(f.observations).toEqual([])
    } finally {
      await f.close()
    }
  },
)

it('requires the source owner and preserves redirect refusal and cancellation after send', async () => {
  const base = await modelJointFixture()
  try {
    expect(() =>
      createHostModelAdapterDeployment(Object.assign({ ...base.owner }, { current: undefined }), [
        base.options,
      ]),
    ).toThrow('Missing model source owner')
  } finally {
    await base.close()
  }
  for (const mode of ['redirect', 'hang'] as const) {
    const f = await modelJointFixture('openai-completions', mode)
    try {
      const job = f.execute()
      if (mode === 'hang') {
        await f.arrival
        f.abort.abort()
      }
      expect((await job).outcome).toBe('unknown_effect')
      expect(f.diagnostics[0]).toMatchObject({
        code: mode === 'redirect' ? 'denied' : 'unknown_effect',
        detailCode: mode === 'redirect' ? 'model_egress_redirect' : 'model_egress_unknown',
      })
      expect(f.observations).toHaveLength(1)
      expect(f.observations[0]?.correctKey).toBe(true)
    } finally {
      await f.close()
    }
  }
})
