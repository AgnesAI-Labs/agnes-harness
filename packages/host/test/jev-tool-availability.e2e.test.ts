import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { type ChildrenFactory, KernelChildren, type SessionImpl, scanAll } from '@agnes/core'
import { actor, fakeProvider, textTurn, toolTurn } from '@agnes/core/testkit'
import { assertRuntimeRecord, type JsonValue, type RuntimeRecord } from '@agnes/jev-runtime'
import { expect, it, vi } from 'vitest'
import { createJevEnvironment } from '../src/runtime/jev-environment.js'
import { createJevToolAvailability } from '../src/runtime/jev-tool-availability.js'
import { createTestHost } from '../testkit/index.js'

const execute = promisify(execFile)
function recordOf(data: unknown): RuntimeRecord {
  if (!data || typeof data !== 'object' || !('record' in data)) throw new Error('Missing record')
  assertRuntimeRecord(data.record)
  return data.record
}

it('removes unavailable captured capabilities, records refusals before dispatch and runs a real foreground shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-jev-availability-'))
  const command = 'printf foreground-evidence > foreground.txt'
  const provider = fakeProvider([
    toolTurn('shell', { command, background: true }),
    toolTurn('shell', { command, background: false }),
    textTurn('Foreground command completed'),
  ])
  let decisions = 0
  const { host } = await createTestHost({
    dataDir: root,
    packageDirs: {
      '@agnes/base': fileURLToPath(new URL('../../base/', import.meta.url)),
      '@agnes/code': fileURLToPath(new URL('../../code/', import.meta.url)),
    },
    provider,
    approval: async () => 'allowed-once',
    disableSessionTitle: true,
    seams: {
      sandbox: {
        async exec(argv, options) {
          expect(argv[0]).toBe('$SHELL')
          const result = await execute('/bin/sh', ['-c', argv[1] ?? ''], {
            cwd: options?.cwd,
            timeout: options?.timeoutMs,
            signal: options?.signal,
          })
          return { code: 0, stdout: result.stdout, stderr: result.stderr, truncated: false }
        },
      },
    },
    jev: {
      decision: {
        backend: 'jev',
        endpoint: 'https://jev.invalid/v1',
        model: 'jev-test',
        transport: {
          async invoke({ questions }) {
            if (decisions === 1)
              await expect(readFile(join(root, 'foreground.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
            const respond = decisions++ >= 2
            const answers: Record<string, JsonValue> = {}
            for (const [name, question] of Object.entries(questions)) {
              const criteria = (question as { criteria?: Record<string, unknown> }).criteria
              if (!criteria) continue
              if (name.startsWith('operation_')) {
                for (const unavailable of ['compact', 'run_code'])
                  expect(criteria).not.toHaveProperty(unavailable)
              }
              const choice =
                name === 'purpose'
                  ? respond
                    ? 'RESPOND'
                    : 'ACT'
                  : name.startsWith('operation_')
                    ? name === 'operation_RESPOND'
                      ? 'RESPOND'
                      : 'shell'
                    : name === 'binding_shell'
                      ? 'LLM_PARAMETERS'
                      : undefined
              if (!choice) continue
              answers[name] = {
                type: 'choice',
                choice,
                confidence: 1,
                probabilities: Object.fromEntries(
                  Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
                ),
              }
            }
            return { output: { answers }, observedModel: 'jev-test' }
          },
        },
      },
    },
  })
  try {
    const session = await host.createSession({ cwd: root, runtime: 'jevloop' })
    const registered = session.currentTools().snapshot(session.lastSeq)
    const environment = createJevEnvironment({
      session,
      ledger: {
        read: async () => [],
        cursorText: String,
        commit: async () => {
          throw new Error('Readonly inspection')
        },
      },
    })
    const catalog = await environment.catalog()
    const shell = catalog.find((tool) => tool.name === 'shell')
    if (!shell) throw new Error('Missing foreground shell')
    expect(shell.parameters).not.toHaveProperty('properties.background')
    expect(shell.revision).toBe(registered.byName.get('shell')?.definitionFingerprint)
    expect(registered.byName.get('shell')?.parameters).toHaveProperty('properties.background')
    expect(await environment.validate(shell, { command, background: false })).toEqual({
      command,
      background: false,
    })
    await expect(environment.validate(shell, { command, background: true })).rejects.toThrow('backgroundJobs')
    for (const name of ['compact', 'subagent_spawn', 'subagent_fork', 'run_code']) {
      expect(registered.byName.has(name)).toBe(true)
      expect(catalog.some((tool) => tool.name === name)).toBe(false)
      const definition = registered.byName.get(name)
      if (!definition) throw new Error('Missing bundled definition')
      await expect(
        environment.validate(
          { ...shell, name, revision: definition.definitionFingerprint },
          name === 'compact'
            ? {}
            : name === 'run_code'
              ? { code: 'print(1)' }
              : name === 'subagent_fork'
                ? { question: 'task' }
                : { task: 'task' },
        ),
      ).rejects.toThrow('Unavailable runtime capability')
    }
    // Historical capture supplies the actual advertised baseline; it is not edited or replayed.
    const historical = JSON.parse(
      await readFile(new URL('../../core/test/fixtures/jev-real-trace.json', import.meta.url), 'utf8'),
    ) as {
      events: Array<{ type: string; data: unknown }>
    }
    const before = historical.events
      .filter((event) => event.type === 'runtime/record')
      .map((event) => recordOf(event.data))
      .find((record) => record.kind === 'environment.observed')
    if (before?.kind !== 'environment.observed') throw new Error('Missing captured environment')
    for (const name of ['compact', 'subagent_spawn', 'subagent_fork', 'run_code'])
      expect(before.catalog.some((tool) => tool.name === name)).toBe(true)
    expect(before.catalog.find((tool) => tool.name === 'shell')?.parameters).toHaveProperty(
      'properties.background',
    )

    const customFactory: ChildrenFactory = {
      create: async () => {
        throw new Error('No test child execution')
      },
    }
    const customSession = {
      d: { ...session.d, children: customFactory },
      runtimeIdentity: session.runtimeIdentity,
      currentTools: () => session.currentTools(),
      lastSeq: session.lastSeq,
    } as SessionImpl
    const definition = registered.byName.get('subagent_spawn')
    if (!definition) throw new Error('Missing spawn')
    const descriptor = { ...shell, name: 'subagent_spawn', revision: definition.definitionFingerprint }
    expect(createJevToolAvailability(customSession).project(definition, descriptor)).toBeUndefined()
    expect(
      createJevToolAvailability(customSession, {
        factory: session.d.children,
        supportsRuntime: () => true,
      }).project(definition, descriptor),
    ).toBeUndefined()
    expect(
      createJevToolAvailability(customSession, {
        factory: customFactory,
        supportsRuntime: () => false,
      }).project(definition, descriptor),
    ).toBeUndefined()
    expect(
      createJevToolAvailability(customSession, {
        factory: customFactory,
        supportsRuntime: (identity) => identity.id === 'jevloop',
      }).project(definition, descriptor),
    ).toEqual(descriptor)
    for (const name of ['subagent_send_message', 'subagent_interrupt']) {
      const control = registered.byName.get(name)
      if (!control) throw new Error('Missing child control')
      const tool = { ...shell, name, revision: control.definitionFingerprint }
      expect(
        createJevToolAvailability(customSession, {
          factory: customFactory,
          supportsRuntime: () => true,
        }).project(control, tool),
      ).toBeUndefined()
      expect(
        createJevToolAvailability(customSession, {
          factory: customFactory,
          supportsRuntime: () => true,
          supportsContinuation: () => true,
        }).project(control, tool),
      ).toBeUndefined()
      expect(
        createJevToolAvailability(session, {
          factory: session.d.children,
          supportsRuntime: () => true,
        }).project(control, tool),
      ).toEqual(tool)
    }
    // Host composition supplies a real independent child runtime opener.
    expect(
      createJevToolAvailability(session, {
        factory: session.d.children,
        supportsRuntime: () => true,
      }).project(definition, descriptor),
    ).toEqual(descriptor)
    // An external declaration still cannot override the factory's own capability refusal.
    if (!(session.d.children instanceof KernelChildren)) throw new Error('Expected Kernel factory')
    const capability = vi.spyOn(session.d.children, 'supportsRuntime').mockReturnValue(false)
    expect(
      createJevToolAvailability(session, {
        factory: session.d.children,
        supportsRuntime: () => true,
      }).project(definition, descriptor),
    ).toBeUndefined()
    capability.mockRestore()
    const foreign = { ...definition, source: { source: 'foreign/subagent', trust: 'trusted' as const } }
    expect(createJevToolAvailability(customSession).project(foreign, descriptor)).toEqual(descriptor)
    expect(
      createJevToolAvailability(customSession).project(
        { ...definition, definitionFingerprint: 'replacement' },
        descriptor,
      ),
    ).toEqual(descriptor)

    await session.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'Run the foreground command' }],
    })
    const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const records = (
      await scanAll((query) => session.scan(query), { type: 'runtime/record', toSeq: session.lastSeq })
    ).map((event) => recordOf(event.data))
    expect(outcome.reason, JSON.stringify(records.findLast((record) => record.kind === 'run.stopped'))).toBe(
      'completed',
    )
    expect(await readFile(join(root, 'foreground.txt'), 'utf8')).toBe('foreground-evidence')
    const observed = records.find((record) => record.kind === 'environment.observed')
    expect(JSON.stringify(observed)).toContain('agnes.jev-tool-availability.v1')
    if (observed?.kind !== 'environment.observed') throw new Error('Missing observed environment')
    for (const name of ['subagent_spawn', 'subagent_fork'])
      expect(observed.catalog.some((tool) => tool.name === name)).toBe(true)
    expect(JSON.stringify(observed)).toContain('backgroundJobs')
    expect(records.filter((record) => record.kind === 'action.intended')).toMatchObject([
      { intent: { tool: 'shell', arguments: { command, background: false } } },
    ])
    const feedback = records.filter(
      (record) =>
        record.kind === 'resource.observed' &&
        record.resource !== null &&
        typeof record.resource === 'object' &&
        !Array.isArray(record.resource) &&
        record.resource.kind === 'jev.runtime.feedback.v1',
    )
    expect(JSON.stringify(feedback)).toContain('Unavailable runtime capability (backgroundJobs)')
    expect(records.filter((record) => record.kind === 'action.settled')).toMatchObject([
      { effect: 'acknowledged', outcome: { kind: 'success' } },
    ])
    await session.close()
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
