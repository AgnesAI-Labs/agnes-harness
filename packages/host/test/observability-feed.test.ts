import { Context } from '@agnes/cordis'
import type { ProviderCatalogEntry } from '@agnes/extension-api'
import { observabilityKind, type ObservabilityProvider } from '@agnes/observability'
import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createExtensionServiceHost, type ServiceAdmission } from '../src/runtime/services/author-port.js'
import {
  deliverCommittedEvents,
  OBSERVABILITY_BINDING_OWNER,
  openObservabilityExporter,
  selectObservabilityProvider,
} from '../src/runtime/services/observability-feed.js'

const closed = 'E_PROVIDER_UNAVAILABLE: service binding is closed'
const admissionOwner = 'fixture/owner'

function envelope(type: string, data: Record<string, unknown>): EventEnvelope {
  return {
    id: '1',
    actor: { id: 'synthetic', org: 'synthetic', role: 'owner', deptPath: [], attrs: {} },
    origin: 'system',
    trust: 'trusted',
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    type,
    data,
  } as EventEnvelope
}

function catalogEntry(
  id: string,
  active: boolean,
  sourcePackage = '@agnes/base',
  kind = 'observability',
): ProviderCatalogEntry {
  return {
    id,
    version: '1.0.0',
    kind,
    sourcePackage,
    capabilities: [],
    restartRequired: true,
    scope: 'process',
    active,
    selectedFor: active ? ['profile'] : [],
  }
}

describe('observability feed', () => {
  it('drops feedback, redacts memory sessions, and swallows exporter failures', () => {
    const seen: EventEnvelope[] = []
    const raw = envelope('user/message', { text: 'secret', turn: 3 })
    deliverCommittedEvents(
      (_key, event) => {
        if (event.type === 'tool/call') throw new Error('exporter failed')
        seen.push(event)
      },
      'sess',
      [envelope('x/feedback/item', { text: 'private' }), raw, envelope('tool/call', { name: 'read' })],
      false,
    )
    expect(seen).toEqual([raw])
    seen.length = 0
    deliverCommittedEvents(
      (_key, event) => seen.push(event),
      'sess',
      [envelope('user/message', { text: 'secret', turn: 3 }), envelope('x/feedback/growth', { text: 'no' })],
      true,
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.data).toMatchObject({ memoryContentOmitted: true, turn: 3 })
    expect(seen[0]?.data).not.toHaveProperty('text')
  })

  it('keeps the active exporter, otherwise the sole candidate', () => {
    expect(selectObservabilityProvider([catalogEntry('base', false), catalogEntry('other', true)])?.id).toBe(
      'other',
    )
    expect(
      selectObservabilityProvider([
        catalogEntry('loop', true, '@agnes/base', 'loop'),
        catalogEntry('only', false),
      ])?.id,
    ).toBe('only')
    expect(
      selectObservabilityProvider([catalogEntry('base', false), catalogEntry('other', false)]),
    ).toBeUndefined()
  })

  it('admits the selected package and refuses other callers', async () => {
    const opened: string[] = []
    let disposed = 0
    const root = new Context()
    const host = createExtensionServiceHost({
      providers: () => root.providers,
      readAdmission: () => ({
        token: {},
        owner: admissionOwner,
        active: true,
        signal: new AbortController().signal,
        session: {
          key: 'sess',
          lane: 'main',
          closingOrClosed: false,
          lastSeq: 1,
          d: { cwd: '/work' },
        } as ServiceAdmission['session'],
      }),
    })
    host.install(root, observabilityKind, { ports: [], audience: 'host' })
    const register = (id: string, sourcePackage: string) => {
      const provider: ObservabilityProvider = {
        id,
        version: '1.0.0',
        bindSession: () => () => undefined,
        observe: () => undefined,
        child: () => undefined,
        lifecycle: () => undefined,
        queueDepth: () => undefined,
        correlation: () => undefined,
        flush: async () => undefined,
        dispose: async () => {
          disposed += 1
        },
      }
      root.providers.register(observabilityKind, sourcePackage, {
        id,
        version: '1.0.0',
        open: () => {
          opened.push(id)
          return provider
        },
      })
    }
    register('base', '@agnes/base')
    register('other', '@other/pkg')
    host.attachBinder(root.providers)
    const signal = new AbortController()
    try {
      const none = await openObservabilityExporter({
        providers: root.providers,
        host,
        home: '/tmp/agh-home',
        signal: signal.signal,
      })
      expect(none).toBeUndefined()
      expect(opened).toEqual([])
      root.providers.select('observability', { provider: 'other', version: '1.0.0' }, 'profile')
      const admitted = await openObservabilityExporter({
        providers: root.providers,
        host,
        home: '/tmp/agh-home',
        signal: signal.signal,
      })
      expect(admitted?.id).toBe('other')
      expect(opened).toEqual(['other'])
      const missing = await host
        .bindHost(observabilityKind, {
          owner: admissionOwner,
          packageId: '@missing/pkg',
          processKey: '/tmp/agh-home',
          signal: new AbortController().signal,
          live: () => ({ owner: admissionOwner, active: true }),
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      expect(missing).toMatchObject({ message: closed })
      expect((missing as Error).message).not.toContain(admissionOwner)
      expect((missing as Error).message).not.toContain(OBSERVABILITY_BINDING_OWNER)
      expect(opened).toEqual(['other'])
      let callbackError: unknown
      try {
        root.providers.bindOwn(observabilityKind)
      } catch (error) {
        callbackError = error
      }
      expect(callbackError).toMatchObject({ message: closed })
      expect((callbackError as Error).message).not.toContain(admissionOwner)
      expect((callbackError as Error).message).not.toContain(OBSERVABILITY_BINDING_OWNER)
      expect(opened).toEqual(['other'])
      const base = await host.bindHost(observabilityKind, {
        owner: OBSERVABILITY_BINDING_OWNER,
        packageId: '@agnes/base',
        processKey: '/tmp/agh-home',
        signal: new AbortController().signal,
        live: () => ({ owner: OBSERVABILITY_BINDING_OWNER, active: true }),
      })
      expect(base.id).toBe('base')
      expect(opened).toEqual(['other', 'base'])
      signal.abort()
      expect(() => admitted?.observe('sess', envelope('user/message', {}))).toThrow(closed)
      expect(disposed).toBe(0)
    } finally {
      await root.fiber.dispose()
    }
  })
})
