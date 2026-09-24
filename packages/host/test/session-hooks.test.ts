import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookEngine, type SessionImpl, type WorkspaceInvocationPort } from '@agnes/core'
import type { HookContext, HookInvocationSnapshot } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import {
  applyTelemetryConsent,
  createSessionHookPort,
  readProfileTelemetryConsent,
  readTelemetryConsent,
} from '../src/session-hooks.js'

const lease: HookContext['lease'] = {
  expiresAt: '2999-01-01T00:00:00.000Z',
  scope: {},
  budget: { remaining: 1 },
}

describe('session hook privacy context', () => {
  it('reads resolved consent and defaults a missing setting closed', () => {
    expect(readTelemetryConsent({ telemetry: { consent: 'ANON' } })).toBe('ANON')
    expect(readTelemetryConsent({})).toBe('DISABLED')
    expect(() => readTelemetryConsent({ telemetry: { consent: 'unexpected' } })).toThrow(
      /invalid telemetry.consent/,
    )
  })

  it('loads the CLI profile overlay and applies it without mutating package presets', () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-consent-overlay-'))
    try {
      expect(readProfileTelemetryConsent(root)).toBeUndefined()
      writeFileSync(join(root, 'consent.yaml'), 'telemetry:\n  consent: FULL\n')
      const source = { name: 'standard', telemetry: { consent: 'DISABLED', timing: true } }
      const applied = applyTelemetryConsent(source, readProfileTelemetryConsent(root))
      expect(applied.telemetry).toEqual({ consent: 'FULL', timing: true })
      expect(source.telemetry.consent).toBe('DISABLED')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses malformed or widened consent overlays', () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-consent-overlay-'))
    try {
      writeFileSync(join(root, 'consent.yaml'), 'telemetry: [ANON]\n')
      expect(() => readProfileTelemetryConsent(root)).toThrow(/only telemetry\.consent/)
      writeFileSync(join(root, 'consent.yaml'), 'telemetry:\n  consent: ANON\nprovider: evil\n')
      expect(() => readProfileTelemetryConsent(root)).toThrow(/unsupported settings/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses an invalid source preset instead of washing it clean with the overlay', () => {
    expect(() => applyTelemetryConsent({ name: 'broken', telemetry: ['invalid'] }, 'ANON')).toThrow(
      /preset broken has invalid telemetry\.consent/,
    )
    expect(() =>
      applyTelemetryConsent({ name: 'broken', telemetry: { consent: 'SUPERUSER' } }, 'ANON'),
    ).toThrow(/preset broken has invalid telemetry\.consent/)
  })

  it('publishes one frozen consent value in the hook session identity', async () => {
    const seen: Array<{ value: string | undefined; frozen: boolean }> = []
    const engine = new HookEngine({
      leaseFor: () => lease,
      onFailure: () => undefined,
      diag: () => undefined,
      // Fixed facts: this test is about consent propagation, never the platform.
      platform: { shell: 'posix', fs: { caseSensitive: true, pathSep: '/' }, terminal: { color: false } },
    })
    engine.on(
      'session_start',
      (_payload, context) => {
        seen.push({
          value: context.session.telemetryConsent,
          frozen: Object.isFrozen(context.session),
        })
      },
      { source: 'agnes/privacy', trust: 'builtin' },
    )
    const session = {
      key: 's',
      lane: 'main',
      ac: new AbortController(),
      d: {
        actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        cwd: '/work',
        runtime: {},
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      },
      preset: { budget: { perRequestCap: null }, verifier: { defaultTier: 0 } },
      state: { creditsUsed: 0 },
      surface: () => [],
      diag: () => undefined,
    } as unknown as SessionImpl
    const port = createSessionHookPort(session, engine, () => [], 'ANON')

    await port.sessionStart({ reason: 'new', preset: 'standard', cwd: '/work' })
    await port.sessionStart({ reason: 'resume', preset: 'standard', cwd: '/work' })
    expect(seen.map(({ value, frozen }) => ({ value, frozen }))).toEqual([
      { value: 'ANON', frozen: true },
      { value: 'ANON', frozen: true },
    ])
  })

  it('acquires the workspace lease before context creation and holds it through handler settle', async () => {
    const order: string[] = []
    const snapshot: HookInvocationSnapshot = Object.freeze({
      workspaceDigest: 'sha256-hooks',
      policyRevision: 'policy-1',
      hooks: Object.freeze([]),
    })
    let finish!: () => void
    const handlerGate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const invocation: WorkspaceInvocationPort = {
      run(invoke) {
        order.push('lease')
        return Promise.resolve()
          .then(() =>
            invoke({
              root: '/work',
              hookSnapshot: async () => snapshot,
              hookSandbox: () => ({
                enforcement: () => ({ level: 'full', scope: ['process'] }),
                exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
              }),
            } as never),
          )
          .finally(() => order.push('release'))
      },
    }
    const engine = new HookEngine({
      leaseFor: () => lease,
      onFailure: () => undefined,
      diag: () => undefined,
      platform: { shell: 'posix', fs: { caseSensitive: true, pathSep: '/' }, terminal: { color: false } },
    })
    engine.on(
      'session_start',
      async (_payload, context) => {
        order.push('context')
        expect(context.workspaceHooks).toEqual(snapshot)
        await handlerGate
        order.push('handler-settled')
      },
      { source: 'agnes/hooks-runner', trust: 'builtin' },
    )
    const session = {
      key: 's-hooks',
      lane: 'main',
      ac: new AbortController(),
      d: {
        actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        cwd: '/work',
        runtime: {},
        workspaceInvocation: invocation,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      },
      preset: { budget: { perRequestCap: null }, verifier: { defaultTier: 0 } },
      state: { creditsUsed: 0 },
      surface: () => [],
      diag: vi.fn(),
    } as unknown as SessionImpl
    const port = createSessionHookPort(session, engine, () => [])

    const pending = port.sessionStart({ reason: 'new', preset: 'standard', cwd: '/work' })
    expect(order).toEqual(['lease'])
    await vi.waitFor(() => expect(order).toEqual(['lease', 'context']))
    finish()
    await pending
    expect(order).toEqual(['lease', 'context', 'handler-settled', 'release'])
  })
})
