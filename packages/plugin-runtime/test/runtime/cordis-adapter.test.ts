import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type AssemblyProvider,
  AssemblyRefusal,
  type AuthorizedPorts,
  FixedCordisAssembly,
  HOOKS_RUNNER_EVENTS,
  HOOKS_RUNNER_ROW_ID,
  normalizeLegacyContribution,
  OBSERVER_LOG_COUNT,
  OBSERVER_LOG_LIMIT,
  type ServiceRequirement,
  TOOL_CONTROL_METHODS,
} from '../../src/runtime/cordis-adapter.js'

const DIGEST_A = 'a'.repeat(64)

function provider(
  overrides: Partial<AssemblyProvider> & Pick<AssemblyProvider, 'providerId' | 'contract' | 'scope'>,
): AssemblyProvider {
  return {
    major: 1,
    logicalName: 'default',
    features: [],
    packageDigest: DIGEST_A,
    capabilities: [],
    requires: [],
    ...overrides,
  }
}

function requirement(
  contract: string,
  scope: ServiceRequirement['scope'],
  capture: ServiceRequirement['capture'],
  extra: Partial<ServiceRequirement> = {},
): ServiceRequirement {
  return {
    contract,
    major: 1,
    logicalName: 'default',
    scope,
    features: [],
    optional: false,
    capture,
    ...extra,
  }
}

function portsOf(ports: AuthorizedPorts): string[] {
  return Object.keys(ports).sort()
}

describe('fixed cordis assembly', () => {
  it('readies dependencies before dependents and publishes only after every required provider is ready', async () => {
    const order: string[] = []
    const assembly = new FixedCordisAssembly()
    const view = await assembly.open({
      generationId: 'g1',
      providers: [
        provider({
          providerId: 'child',
          contract: 'agh.child',
          scope: 'runtime',
          requires: [requirement('agh.parent', 'runtime', 'instance')],
          ready() {
            order.push('child')
          },
        }),
        provider({
          providerId: 'parent',
          contract: 'agh.parent',
          scope: 'runtime',
          ready() {
            order.push('parent')
          },
        }),
      ],
    })
    expect(order).toEqual(['parent', 'child'])
    expect(view.published).toBe(true)
    expect(view.state).toBe('ready')
    expect(view.bindings.map((binding) => binding.providerId)).toEqual(['parent', 'child'])
  })

  it('rolls a failed candidate back in reverse order and leaves the published generation in place', async () => {
    const released: string[] = []
    const assembly = new FixedCordisAssembly()
    await assembly.open({
      generationId: 'old',
      providers: [
        provider({
          providerId: 'old',
          contract: 'agh.old',
          scope: 'runtime',
          owners: [
            {
              id: 'old-disk',
              release: () => {
                released.push('old-disk')
              },
            },
          ],
        }),
      ],
    })
    await expect(
      assembly.open({
        generationId: 'next',
        providers: [
          provider({
            providerId: 'parent',
            contract: 'agh.parent',
            scope: 'runtime',
            owners: [
              {
                id: 'parent',
                release: () => {
                  released.push('parent')
                },
              },
            ],
          }),
          provider({
            providerId: 'child',
            contract: 'agh.child',
            scope: 'runtime',
            requires: [requirement('agh.parent', 'runtime', 'instance')],
            owners: [
              {
                id: 'child',
                release: () => {
                  released.push('child')
                },
              },
            ],
            ready() {
              throw new Error('interrupted')
            },
          }),
        ],
      }),
    ).rejects.toThrow('interrupted')
    expect(released).toEqual(['child', 'parent'])
    expect(assembly.view('old').published).toBe(true)
    expect(assembly.view('old').state).toBe('ready')
    expect(assembly.view('next').published).toBe(false)
    expect(assembly.view('next').state).toBe('closed')
    expect(assembly.invoke('run-old', 'old').generationId).toBe('old')
  })

  it('rejects a longer-lived scope closing over a shorter instance and allows a per-call factory', async () => {
    const assembly = new FixedCordisAssembly()
    const box = { value: 'one' }
    await expect(
      assembly.open({
        generationId: 'captured',
        providers: [
          provider({ providerId: 'short', contract: 'agh.short', scope: 'action' }),
          provider({
            providerId: 'long',
            contract: 'agh.long',
            scope: 'runtime',
            requires: [requirement('agh.short', 'action', 'instance')],
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'scope_capture' })

    let handle: { read(): string | undefined } | undefined
    await assembly.open({
      generationId: 'factory',
      providers: [
        provider({
          providerId: 'short',
          contract: 'agh.short',
          scope: 'action',
          token: () => box.value,
        }),
        provider({
          providerId: 'long',
          contract: 'agh.long',
          scope: 'runtime',
          requires: [requirement('agh.short', 'action', 'factory')],
          create(ports) {
            handle = ports.get({ contract: 'agh.short', logicalName: 'default', scope: 'action' }) as {
              read(): string | undefined
            }
          },
        }),
      ],
    })
    expect(handle).toBeDefined()
    expect(Object.hasOwn(handle as object, 'providerId')).toBe(false)
    expect(handle?.read()).toBe('one')
    box.value = 'two'
    expect(handle?.read()).toBe('two')
  })

  it('refuses a container contract or a container selection field', async () => {
    const assembly = new FixedCordisAssembly()
    await expect(
      assembly.open({
        generationId: 'container',
        providers: [provider({ providerId: 'box', contract: 'agh.container', scope: 'runtime' })],
      }),
    ).rejects.toMatchObject({ code: 'container_forbidden' })
    await expect(
      assembly.open({
        generationId: 'choice',
        container: 'other',
        providers: [provider({ providerId: 'box', contract: 'agh.loop', scope: 'runtime' })],
      } as never),
    ).rejects.toMatchObject({ code: 'container_forbidden' })
  })

  it('refuses a duplicate cell, a cycle, a missing provider, and a present provider that lacks a feature', async () => {
    const assembly = new FixedCordisAssembly()
    await expect(
      assembly.open({
        generationId: 'dup',
        providers: [
          provider({ providerId: 'one', contract: 'agh.loop', scope: 'runtime' }),
          provider({ providerId: 'two', contract: 'agh.loop', scope: 'runtime' }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'duplicate_cell' })
    await expect(
      assembly.open({
        generationId: 'cycle',
        providers: [
          provider({
            providerId: 'a',
            contract: 'agh.a',
            scope: 'runtime',
            requires: [requirement('agh.b', 'runtime', 'instance')],
          }),
          provider({
            providerId: 'b',
            contract: 'agh.b',
            scope: 'runtime',
            requires: [requirement('agh.a', 'runtime', 'instance')],
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'dependency_cycle' })
    await expect(
      assembly.open({
        generationId: 'missing',
        providers: [
          provider({
            providerId: 'child',
            contract: 'agh.child',
            scope: 'runtime',
            requires: [requirement('agh.missing', 'runtime', 'instance')],
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'missing_dependency' })
    await expect(
      assembly.open({
        generationId: 'feature',
        providers: [
          provider({ providerId: 'parent', contract: 'agh.parent', scope: 'runtime', features: [] }),
          provider({
            providerId: 'child',
            contract: 'agh.child',
            scope: 'runtime',
            requires: [
              requirement('agh.parent', 'runtime', 'instance', {
                features: ['legacy-compaction-plan.v1'],
                optional: true,
              }),
            ],
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'feature_missing' })
    await expect(
      assembly.open({
        generationId: 'major',
        providers: [provider({ providerId: 'box', contract: 'agh.loop', scope: 'runtime', major: 0 })],
      }),
    ).rejects.toMatchObject({ code: 'invalid_provider' })
    await expect(
      assembly.open({
        generationId: 'digest',
        providers: [
          provider({ providerId: 'box', contract: 'agh.loop', scope: 'runtime', packageDigest: 'ab' }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid_provider' })
    const optional = await assembly.open({
      generationId: 'optional',
      providers: [
        provider({
          providerId: 'child',
          contract: 'agh.child',
          scope: 'runtime',
          requires: [requirement('agh.missing', 'runtime', 'instance', { optional: true })],
        }),
      ],
    })
    expect(optional.state).toBe('ready')
  })

  it('releases each owner once, keeps a throwing dispose as a residual owner, and does not release it again', async () => {
    let releases = 0
    const assembly = new FixedCordisAssembly()
    await assembly.open({
      generationId: 'once',
      providers: [
        provider({
          providerId: 'tool',
          contract: 'agh.tool',
          scope: 'runtime',
          owners: [
            {
              id: 'disk',
              release: () => {
                releases += 1
              },
            },
          ],
        }),
      ],
    })
    const first = await assembly.close('once')
    const second = await assembly.close('once')
    expect(first.repeated).toBe(false)
    expect(first.residualOwnerIds).toEqual([])
    expect(second.repeated).toBe(true)
    expect(releases).toBe(1)

    let failedReleases = 0
    const residual = new FixedCordisAssembly()
    await expect(
      residual.open({
        generationId: 'fault',
        providers: [
          provider({
            providerId: 'tool',
            contract: 'agh.tool',
            scope: 'runtime',
            owners: [
              {
                id: 'disk',
                release() {
                  failedReleases += 1
                  throw new Error('dispose failed')
                },
              },
            ],
            ready() {
              throw new Error('interrupted')
            },
          }),
        ],
      }),
    ).rejects.toThrow('interrupted')
    expect(residual.residualOwners()).toEqual([{ generationId: 'fault', ownerId: 'disk' }])
    await residual.close('fault')
    expect(failedReleases).toBe(1)
    expect(residual.view('fault').state).toBe('residual')
  })

  it('sends legacy apply and the author create through the same authorized ports', async () => {
    const seen: AuthorizedPorts[] = []
    const assembly = new FixedCordisAssembly()
    await assembly.open({
      generationId: 'same',
      providers: [
        provider({
          providerId: 'tool',
          contract: 'agh.tool',
          scope: 'runtime',
          create(ports) {
            seen.push(ports)
          },
        }),
      ],
      contributions: [
        {
          providerId: 'tool',
          source: 'legacy-apply',
          tools: [{ name: 'read' }],
          apply(ports) {
            seen.push(ports)
          },
        },
      ],
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
    expect(portsOf(seen[0] as AuthorizedPorts)).toEqual(['generationId', 'get', 'providerId'])
    expect('root' in (seen[0] as object)).toBe(false)
    expect('plugin' in (seen[0] as object)).toBe(false)
    const denied = (seen[0] as AuthorizedPorts).get({
      contract: 'agh.secret',
      logicalName: 'default',
      scope: 'runtime',
    })
    expect(denied).toEqual({ ok: false, code: 'denied' })
  })

  it('adds the fixed tool controls, refuses an author-supplied runtime list, and refuses a widened hook policy', () => {
    const normalized = normalizeLegacyContribution({
      providerId: 'tool',
      source: 'author',
      tools: [{ name: 'read' }],
    })
    expect(normalized.controlMethods).toEqual([...TOOL_CONTROL_METHODS])
    expect(normalized.operations.map((operation) => operation.method)).toEqual([
      'read',
      'admission',
      'receipt',
      'cancel',
    ])
    expect(() =>
      normalizeLegacyContribution({
        providerId: 'tool',
        source: 'author',
        runtimeInternals: ['admission'],
      } as never),
    ).toThrow(AssemblyRefusal)
    expect(() =>
      normalizeLegacyContribution({
        providerId: 'tool',
        source: 'legacy-apply',
        hooks: [{ event: 'before_step', failPolicy: 'open' }],
      }),
    ).toThrow(expect.objectContaining({ code: 'policy_widened' }))
  })

  it('rejects a closed loop hook whose feature is missing and only diagnoses an open one', async () => {
    const assembly = new FixedCordisAssembly()
    const required = ['sandbox.isolate']
    await expect(
      assembly.open({
        generationId: 'loop',
        providers: [
          provider({ providerId: 'loop', contract: 'agh.loop', scope: 'runtime', capabilities: [] }),
        ],
        contributions: [
          {
            providerId: 'loop',
            source: 'legacy-apply',
            hooks: [{ event: 'before_step' }],
            requiredCapabilities: required,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'capability_undeclared' })
    expect(required).toEqual(['sandbox.isolate'])

    await expect(
      assembly.open({
        generationId: 'closed-hook',
        loopFeatures: [],
        providers: [provider({ providerId: 'loop', contract: 'agh.loop', scope: 'runtime' })],
        contributions: [
          {
            providerId: 'loop',
            source: 'legacy-apply',
            hooks: [{ event: 'before_step' }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'feature_missing', detail: { feature: 'loop-hook:before_step' } })

    const open = await assembly.open({
      generationId: 'open-hook',
      loopFeatures: [],
      providers: [provider({ providerId: 'loop', contract: 'agh.loop', scope: 'runtime' })],
      contributions: [
        {
          providerId: 'loop',
          source: 'legacy-apply',
          hooks: [{ event: 'turn_stopping', bound: true, mandatory: false, failPolicy: 'open' }],
        },
      ],
    })
    expect(open.installedHooks).not.toContain('turn_stopping')
    expect(open.diagnostics).toEqual([{ code: 'loop_feature_absent', event: 'turn_stopping' }])

    const unbound = await assembly.open({
      generationId: 'unbound',
      providers: [provider({ providerId: 'loop', contract: 'agh.loop', scope: 'runtime' })],
      contributions: [
        {
          providerId: 'loop',
          source: 'legacy-apply',
          hooks: [{ event: 'before_step', bound: false }],
        },
      ],
    })
    expect(unbound.installedHooks).toEqual([])
    expect(unbound.diagnostics).toEqual([])
  })

  it('keeps hook-runner takeover on the built-in row and restores that row when takeover is disabled', () => {
    const assembly = new FixedCordisAssembly([], { hooksRunnerRank: 7 })
    expect(assembly.hooksRunnerStatus()).toMatchObject({ mode: 'builtin', rank: 7, execution: 'delegated' })
    expect(() =>
      assembly.attachHooksRunner({
        rowId: HOOKS_RUNNER_ROW_ID,
        events: ['tool_call'],
      }),
    ).toThrow(expect.objectContaining({ code: 'incomplete_row' }))
    expect(() =>
      assembly.attachHooksRunner({
        rowId: 'ext:other/hooks-runner',
        events: [...HOOKS_RUNNER_EVENTS],
      }),
    ).toThrow(expect.objectContaining({ code: 'row_identity' }))
    expect(() =>
      assembly.attachHooksRunner({
        rowId: HOOKS_RUNNER_ROW_ID,
        events: [...HOOKS_RUNNER_EVENTS],
        execution: 'subprocess',
      } as never),
    ).toThrow(expect.objectContaining({ code: 'delegated_execution' }))
    expect(assembly.hooksRunnerStatus().mode).toBe('builtin')

    const active = assembly.attachHooksRunner({
      rowId: HOOKS_RUNNER_ROW_ID,
      events: [...HOOKS_RUNNER_EVENTS].reverse(),
      mappingReports: [{ event: 'Notification', unsupportedFields: ['permissionMode'] }],
    })
    expect(active).toMatchObject({
      mode: 'takeover',
      rowId: HOOKS_RUNNER_ROW_ID,
      rank: 7,
      execution: 'delegated',
    })
    expect(active.events).toEqual([...HOOKS_RUNNER_EVENTS])
    expect(active.mappingReports).toEqual([{ event: 'Notification', unsupportedFields: ['permissionMode'] }])
    expect(assembly.disableHooksRunnerTakeover().mode).toBe('builtin')
    expect(assembly.hooksRunnerStatus().mappingReports).toEqual([])
    const source = readFileSync(new URL('../../src/runtime/cordis-adapter.ts', import.meta.url), 'utf8')
    expect(source.includes('child_process')).toBe(false)
    expect(source.includes('node:http')).toBe(false)
  })

  it('checks observer schema and scope, bounds logs, cancels, and grants no effect channel', async () => {
    let calls = 0
    const assembly = new FixedCordisAssembly()
    await expect(
      assembly.open({
        generationId: 'bad-schema',
        providers: [provider({ providerId: 'host', contract: 'agh.host', scope: 'runtime' })],
        observers: [
          {
            id: 'watch',
            scope: 'runtime',
            event: { typeId: 'agh.example/event@1', schemaTypeId: 'agh.example/other@1' },
            handle() {
              calls += 1
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'schema_mismatch' })
    expect(calls).toBe(0)

    let releaseCount = 0
    let received: unknown
    const live = await assembly.open({
      generationId: 'watch',
      providers: [provider({ providerId: 'host', contract: 'agh.host', scope: 'runtime' })],
      renderers: [{ id: 'panel' }],
      observers: [
        {
          id: 'watch',
          scope: 'runtime',
          event: { typeId: 'agh.example/event@1', schemaTypeId: 'agh.example/event@1' },
          owners: [
            {
              id: 'watch-owner',
              release: () => {
                releaseCount += 1
              },
            },
          ],
          handle(notification, context) {
            calls += 1
            received = notification.data
            expect(Object.isFrozen(context)).toBe(true)
            expect(Object.keys(context).sort()).toEqual(['log', 'signal'])
            context.log('x'.repeat(OBSERVER_LOG_LIMIT + 40))
            for (let index = 0; index < OBSERVER_LOG_COUNT + 1; index += 1) context.log(`log-${index}`)
            return { effect: 'bill' } as unknown as undefined
          },
        },
      ],
    })
    expect(live.clientOnlyIds).toEqual(['panel'])
    expect(live.bindings).toHaveLength(1)
    const hidden = await assembly.deliver('watch', {
      typeId: 'agh.example/event@1',
      scope: 'installation',
      eventId: 'e1',
      data: { text: 'hi' },
    })
    expect(hidden.status).toBe('refused')
    expect(calls).toBe(0)
    const shown = await assembly.deliver('watch', {
      typeId: 'agh.example/event@1',
      scope: 'action',
      eventId: 'e2',
      data: { text: 'hi' },
    })
    expect(shown.status).toBe('completed')
    expect(shown.acceptedEffects).toEqual([])
    expect(shown.logs).toHaveLength(OBSERVER_LOG_COUNT)
    expect(shown.logs[0]).toHaveLength(OBSERVER_LOG_LIMIT)
    expect(Object.isFrozen(received)).toBe(true)
    const cancelled = await assembly.deliver('watch', {
      typeId: 'agh.example/event@1',
      scope: 'action',
      eventId: 'e3',
      data: { text: 'later' },
      signal: AbortSignal.abort(),
    })
    expect(cancelled.status).toBe('cancelled')
    expect(calls).toBe(1)
    await assembly.close('watch')
    expect(releaseCount).toBe(1)
    const late = await assembly.deliver('watch', {
      typeId: 'agh.example/event@1',
      scope: 'action',
      eventId: 'e4',
      data: { text: 'late' },
    })
    expect(late.status).toBe('closed')
    expect(calls).toBe(1)
    await assembly.close('watch')
    expect(releaseCount).toBe(1)
  })

  it('drains work that observes cancellation, blocks work that does not, and does not resend an unknown action', async () => {
    const assembly = new FixedCordisAssembly()
    await assembly.open({
      generationId: 'work',
      providers: [provider({ providerId: 'tool', contract: 'agh.tool', scope: 'runtime' })],
    })
    assembly.beginInvocation('work', 'inv-1')
    assembly.signal('work').addEventListener('abort', () => {
      assembly.finishInvocation('work', 'inv-1')
    })
    const drained = await assembly.drain('work', Date.now() + 1000)
    expect(drained).toMatchObject({ state: 'drained', activeInvocationIds: [], repeated: false })

    const blockedAssembly = new FixedCordisAssembly()
    await blockedAssembly.open({
      generationId: 'stuck',
      providers: [provider({ providerId: 'tool', contract: 'agh.tool', scope: 'runtime' })],
    })
    blockedAssembly.beginInvocation('stuck', 'inv-stuck')
    blockedAssembly.noteUnknown('stuck', 'action-unknown')
    const blocked = await blockedAssembly.drain('stuck', Date.now() - 1)
    expect(blocked.state).toBe('blocked')
    expect(blocked.activeInvocationIds).toEqual(['inv-stuck'])
    const closed = await blockedAssembly.close('stuck')
    expect(closed.forced).toBe(true)
    expect(closed.drained).toBe(false)
    expect(closed.resentActionIds).toEqual([])
    expect(blockedAssembly.view('stuck').unknownActionIds).toEqual(['action-unknown'])
    expect(() => blockedAssembly.finishInvocation('stuck', 'missing')).toThrow(
      expect.objectContaining({
        code: 'unknown_invocation',
      }),
    )
    expect(() => blockedAssembly.beginInvocation('stuck', 'again')).toThrow(
      expect.objectContaining({ code: 'closed' }),
    )
  })
})
