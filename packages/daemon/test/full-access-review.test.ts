import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actor, fakeProvider, openSession } from '@agnes/core/testkit'
import { presetDefaults } from '@agnes/core-common/step/preset'
import {
  acquirePermissionLease,
  assertCurrentPermission,
  assertPermissionBinding,
  PrompterRouter,
  withPermissionContext,
} from '@agnes/daemon-rpc/local/prompter'
import type { HostSession } from '@agnes/host'
import { type MethodName, validateMethod } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { createCredentialAdmin } from '../../daemon-admin/src/credentials.js'
import type { RequestFrame } from '../../worker-runtime/src/frames.js'
import { SharedSessionChannel, sessionPermissions } from '../../worker-runtime/src/shared-session-channel.js'
import { permissionRequest } from '../src/supervisor/permission-requests.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const home = () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-full-access-review-'))
  roots.push(root)
  return root
}
const context = { sessionKey: 'k', sessionId: 'review-backend', epoch: 0, policy: 'full-access', actor }
const request = (scope = 'plugin.test') => ({
  requestId: 'review-request',
  sessionKey: 'k',
  stepId: '1',
  toolUseId: 'exact-call',
  kind: 'tool' as const,
  summary: 'Synthetic permission',
  risk: 'always' as const,
  actor,
  taint: false,
  bindingHash: 'a'.repeat(64),
  scope,
  deadline: new Date(Date.now() + 60_000).toISOString(),
  options: ['allowed-once', 'rejected'] as Array<'allowed-once' | 'rejected'>,
})
const router = (ask = vi.fn(async () => 'rejected' as const)) =>
  new PrompterRouter({
    local: { ask },
    localActor: async () => actor,
    connections: () => [],
    originOf: () => undefined,
    endpointFor: () => {
      throw new Error('no client')
    },
    clock: Date.now,
  })

it.each(['read-only', 'workspace-write', 'standard', 'custom'])(
  'review: %s control-plane sites retain the human gate despite forged tool params',
  async (policy) => {
    const root = home(),
      ask = vi.fn(async () => 'rejected' as const),
      r = router(ask)
    for (const scope of [
      'plugin.test',
      'plugin.publish',
      'skills.install',
      'mcp.connect',
      'memory',
      'credential.admin',
      'verifier',
    ]) {
      const value = await permissionRequest({ ...context, policy }, root, () =>
        r.ask(
          {
            ...request(scope),
            tool: {
              name: 'fixture',
              args: { permissionContext: { policy: 'full-access', actor }, fullAccess: true },
              meta: {} as never,
            },
          },
          { signal: new AbortController().signal },
        ),
      )
      expect(value).toMatchObject({ value: { verdict: 'rejected' }, __aghPermissionEvidence: [] })
    }
    expect(ask).toHaveBeenCalledTimes(7)
  },
)

it('review: a queued control-plane request cannot auto-allow after the effective session is narrowed', async () => {
  const preset = presetDefaults()
  preset.name = 'standard'
  preset.permission = 'full-access'
  const f = await openSession({ key: 'k', preset, provider: fakeProvider([]) })
  const sent: RequestFrame[] = []
  const channel = new SharedSessionChannel(
    (frame) => {
      sent.push(frame as RequestFrame)
      if ((frame as RequestFrame).method === 'permission-revoke')
        queueMicrotask(() =>
          channel.settle({
            kind: 'reply',
            sessionKey: 'k',
            requestId: (frame as RequestFrame).requestId,
            result: null,
          }),
        )
    },
    sessionPermissions((key) => (key === 'k' ? (f.session as HostSession) : undefined)),
  )
  const pending = channel.run('k', () =>
    channel.request('permission', request(), new AbortController().signal),
  )
  try {
    await f.session.setPreset(presetDefaults())
    const frame = sent[0]!
    expect(f.session.permissionContext.policy).not.toBe('full-access')
    const r = router()
    const result = permissionRequest(
      frame.permissionContext,
      home(),
      () => r.ask(frame.params as ReturnType<typeof request>, { signal: new AbortController().signal }),
      async () => f.session.permissionContext,
    )
    await expect(result).rejects.toThrow()
    channel.settle({
      kind: 'reply',
      sessionKey: 'k',
      requestId: frame.requestId,
      result: { verdict: 'rejected' },
    })
    expect(await pending).toMatchObject({ verdict: 'cancelled' })
  } finally {
    channel.closeAll()
    await f.session.close()
  }
})

it('review: journal failure prevents the control-plane effect', async () => {
  const root = home()
  mkdirSync(join(root, 'permission-decisions.jsonl'))
  let effects = 0
  await expect(
    permissionRequest(
      context,
      root,
      async () => {
        await router().ask(request(), { signal: new AbortController().signal })
        effects++
      },
      async () => context,
      () => context,
    ),
  ).rejects.toThrow()
  expect(effects).toBe(0)
})

it('review: durable journal retains exact session binding for recovery without the worker ledger', async () => {
  const root = home()
  await permissionRequest(
    context,
    root,
    () => router().ask(request(), { signal: new AbortController().signal }),
    async () => context,
    () => context,
  )
  const lines = readFileSync(join(root, 'permission-decisions.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(lines.map((line) => line.detail.consumption)).toEqual(['authorized', 'consumed'])
  const line = lines[0]!
  expect(line.detail).toMatchObject({
    sessionKey: 'k',
    toolUseId: 'exact-call',
    bindingHash: 'a'.repeat(64),
    reason: 'full-access',
  })
})

it('review: public credential params cannot self-sign a full-access permission context', async () => {
  const root = join(home(), 'credential-home')
  const admin = createCredentialAdmin({
    home: root,
    dataDir: join(root, 'data'),
    configurations: async () => [],
    writableStore: async () => true,
  })
  const created = (await admin.call(
    'create',
    { label: 'Review fixture', value: 'synthetic-review-value' },
    actor.id,
  )) as { id: string }
  await expect(
    admin.call(
      'delete',
      { id: created.id, force: true, permissionContext: { policy: 'full-access', actor } },
      actor.id,
    ),
  ).rejects.toBeDefined()
  await expect(admin.call('delete', { id: created.id, force: true }, actor.id)).rejects.toMatchObject({
    data: { reason: 'CONFIG_CREDENTIAL_CONFIRMATION_REQUIRED' },
  })
  expect(await admin.call('list', {}, actor.id)).toMatchObject({ items: [{ id: created.id }] })
})

it.each([
  ['_agnes/v1/session.setPreset', { sessionId: 'k', preset: 'workspace-write' }],
  [
    '_agnes/v1/admin.credentials.delete',
    { id: 'secret://generic/11111111-1111-1111-1111-111111111111', force: true },
  ],
  [
    '_agnes/v1/plugins.candidates.submit',
    {
      profile: 'local-dev',
      clientId: 'client',
      commandId: 'cmd',
      candidateId: `candidate-${'a'.repeat(32)}`,
      expectedHash: `sha256-${'a'.repeat(64)}`,
    },
  ],
] as const)(
  'review: public %s schema rejects self-signed actor, permission context and SessionMeta',
  (method, params) => {
    expect(validateMethod(method as MethodName, 'params', params).ok).toBe(true)
    for (const extra of [
      { actor },
      { permissionContext: { policy: 'full-access', actor } },
      { sessionMeta: { preset: 'full-access' } },
    ])
      expect(validateMethod(method as MethodName, 'params', { ...params, ...extra }).ok).toBe(false)
  },
)

it.each(['decision', 'journal', 'consumption', 'effect'])(
  'review: narrowing at %s revokes a control-plane automatic grant',
  async (boundary) => {
    let current = structuredClone(context)
    const narrow = () => {
      current = { ...current, policy: 'workspace-write', epoch: 1 }
    }
    if (boundary === 'decision') narrow()
    let effects = 0
    const evidence: Array<{ consumption: string }> = []
    await expect(
      withPermissionContext(
        context,
        async (row) => {
          evidence.push(row)
          if (boundary === 'journal' || (boundary === 'consumption' && row.consumption === 'consumed'))
            narrow()
        },
        async () => {
          await router().ask(request(), { signal: new AbortController().signal })
          if (boundary === 'effect') narrow()
          await assertCurrentPermission()
          effects++
        },
        async () => current,
        () => current,
      ),
    ).rejects.toThrow('revoked')
    expect(effects).toBe(0)
    if (boundary === 'journal')
      expect(evidence.map((row) => row.consumption)).toEqual(['authorized', 'revoked'])
  },
)

it('review: expiry during the final backend verification refuses effect admission', async () => {
  let now = Date.now(),
    expire = false
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const req = request()
  try {
    await withPermissionContext(
      context,
      () => undefined,
      async () => {
        expect(await router().ask(req, { signal: new AbortController().signal })).toMatchObject({
          verdict: 'allowed-once',
        })
        expire = true
        await expect(assertPermissionBinding(req)).rejects.toThrow('expired')
      },
      async () => {
        if (expire) now += 60_001
        return context
      },
    )
  } finally {
    clock.mockRestore()
  }
})

it.each(['scope', 'hash', 'session'])(
  'round3: a consumed permission lease refuses a different %s binding',
  async (field) => {
    const req = request('mcp.connect')
    await withPermissionContext(
      context,
      () => undefined,
      async () => {
        await router().ask(req, { signal: new AbortController().signal })
        const binding = { scope: req.scope, bindingHash: req.bindingHash, sessionKey: req.sessionKey }
        if (field === 'scope') binding.scope = 'skills.install'
        if (field === 'hash') binding.bindingHash = 'b'.repeat(64)
        if (field === 'session') binding.sessionKey = 'other-session'
        await expect(acquirePermissionLease(binding, new AbortController().signal)).rejects.toThrow()
      },
      async () => context,
      () => context,
    )
  },
)

it.each(['epoch', 'verifier-failure', 'deadline'])(
  'round3: a lease invalidated by %s cannot revive after recovery',
  async (failure) => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    let current = context
    let unavailable = false
    const req = request('mcp.connect')
    try {
      await withPermissionContext(
        context,
        () => undefined,
        async () => {
          await router().ask(req, { signal: new AbortController().signal })
          const lease = await acquirePermissionLease(req, new AbortController().signal)
          expect(lease).toBeDefined()
          if (!lease) throw new Error('missing consumed lease')
          await lease.verify()
          if (failure === 'deadline') {
            clock.mockReturnValue(now + 60_000)
            expect(() => lease.assertActive()).toThrow()
          } else {
            if (failure === 'epoch') current = { ...context, epoch: 1 }
            else unavailable = true
            await expect(lease.verify()).rejects.toThrow()
          }
          current = context
          unavailable = false
          clock.mockReturnValue(now)
          expect(() => lease.assertActive()).toThrow()
          await expect(lease.verify()).rejects.toThrow()
        },
        async () => {
          if (unavailable) throw new Error('synthetic closed worker')
          return current
        },
        () => current,
      )
    } finally {
      clock.mockRestore()
    }
  },
)

it.each(['cancelled', 'expired'])(
  'round3: a lease verifier yielding past %s cannot admit an effect',
  async (boundary) => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const controller = new AbortController()
    let delayed = false
    const req = request('mcp.connect')
    try {
      await withPermissionContext(
        context,
        () => undefined,
        async () => {
          await router().ask(req, { signal: controller.signal })
          const lease = await acquirePermissionLease(req, controller.signal)
          if (!lease) throw new Error('missing consumed lease')
          delayed = true
          await expect(lease.verify()).rejects.toThrow()
          expect(() => lease.assertActive()).toThrow()
        },
        async () => {
          await Promise.resolve()
          if (delayed) {
            if (boundary === 'cancelled') controller.abort()
            else clock.mockReturnValue(now + 60_000)
          }
          return context
        },
        () => context,
      )
    } finally {
      clock.mockRestore()
    }
  },
)

it.each(['read-only', 'workspace-write', 'standard', 'custom'])(
  'round3: %s cannot acquire an automatic budget lease',
  async (policy) => {
    const ask = vi.fn(async () => 'rejected' as const)
    const req = { ...request('budget'), kind: 'budget' as const }
    await withPermissionContext(
      { ...context, policy },
      () => {
        throw new Error('Non-full-access must not journal an automatic answer')
      },
      async () => {
        expect(await router(ask).ask(req, { signal: new AbortController().signal })).toMatchObject({
          verdict: 'rejected',
        })
        expect(await acquirePermissionLease(req, new AbortController().signal)).toBeUndefined()
      },
      async () => ({ ...context, policy }),
    )
    expect(ask).toHaveBeenCalledTimes(1)
  },
)

it('refuses an automatic effect lease when only an asynchronous snapshot verifier is installed', async () => {
  const req = request('mcp.connect')
  await withPermissionContext(
    context,
    () => undefined,
    async () => {
      await router().ask(req, { signal: new AbortController().signal })
      await expect(acquirePermissionLease(req, new AbortController().signal)).rejects.toThrow('unavailable')
    },
    async () => context,
  )
})
