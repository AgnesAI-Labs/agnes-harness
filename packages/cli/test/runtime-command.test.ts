import { createClient, memoryJournal } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { prepareCommandArgs } from '../src/command-entry.js'
import { commandHelp } from '../src/command-help.js'
import { parseRuntimeArgs, runtimeCommand } from '../src/commands/runtime.js'
import { FakeEndpoint } from './fake-endpoint.js'

it('validates runtime grammar and selects the profile before boot', () => {
  const rest = ['reconcile', 'fleet', '--extension', 'ext:example.fleet', '--profile', 'synthetic']
  expect(parseArgs(['runtime', ...rest])).toMatchObject({ command: 'runtime', rest })
  expect(prepareCommandArgs(['runtime', ...rest], '/workspace').profile).toBe('synthetic')
  expect(commandHelp('runtime')).toContain('agh runtime reconcile')
  for (const args of [
    [],
    ['reconcile', '../escape'],
    [...rest, '--answer', 'allow'],
    [...rest, '--approved'],
  ])
    expect(() => parseRuntimeArgs(args)).toThrow()
})
it.each(['pending', 'allow', 'reject', 'dead', 'unknown', 'failed'] as const)(
  'uses the generic facade and native decision flow: %s',
  async (scenario) => {
    const client = createClient({
      transport: { kind: 'inproc', endpoint: new FakeEndpoint() },
      auth: { kind: 'local' },
      journal: memoryJournal(),
    })
    const handle = { id: 'decision-one', sessionId: null, profileId: 'default' }
    const calls = vi.spyOn(client, 'call')
    const close = vi.fn(async () => {
      await client.close()
    })
    const output: string[] = []
    let answered = false
    calls.mockImplementation(async (method) => {
      if (method === '_agnes/v1/profile.decisions.list')
        return { decisions: [{ handle, revision: 1, request: { spec: { subject: { resource: 'fleet' } } } }] }
      if (method === '_agnes/v1/profile.decisions.answer') {
        answered = true
        return { state: 'applied' }
      }
      if (scenario === 'failed') throw new Error('denied')
      return {
        operationId: 'recovery-one',
        state:
          scenario === 'dead'
            ? 'completed'
            : scenario === 'unknown'
              ? 'unknown'
              : answered
                ? scenario === 'allow'
                  ? 'completed'
                  : 'refused'
                : 'approval-required',
        decision: handle,
      }
    })
    const io = {
      write: (s: string) => {
        output.push(s)
      },
      connect: async () => ({ client, close }),
    }
    const rest = [
      'reconcile',
      'fleet',
      '--extension',
      'ext:example.fleet',
      '--operation',
      'recovery-one',
      ...(['allow', 'reject'].includes(scenario) ? ['--answer', scenario] : []),
    ]
    if (scenario === 'failed') await expect(runtimeCommand(rest, io)).rejects.toThrow('denied')
    else
      expect(await runtimeCommand(rest, io)).toBe(
        ['dead', 'allow'].includes(scenario) ? 0 : scenario === 'pending' ? 3 : 1,
      )
    expect(close).toHaveBeenCalledOnce()
    expect(calls.mock.calls[0]).toMatchObject([
      ['allow', 'reject'].includes(scenario)
        ? '_agnes/v1/extension.readOperation'
        : '_agnes/v1/extension.callScoped',
      {
        extension: expect.stringMatching(/^plugin\/[0-9a-f]{16}$/u),
        service: 'fleet.reconcile',
        ...(['allow', 'reject'].includes(scenario) ? {} : { input: {} }),
        operationId: 'recovery-one',
      },
    ])
    const answer = calls.mock.calls.find(([method]) => method === '_agnes/v1/profile.decisions.answer')
    if (['allow', 'reject'].includes(scenario)) {
      expect(answer?.[1]).toMatchObject({
        handle,
        revision: 1,
        response: { option: scenario === 'allow' ? 'allowed-once' : 'rejected', value: null },
      })
      expect(output[0]).toContain('fleet')
    } else expect(answer).toBeUndefined()
    if (['unknown', 'dead'].includes(scenario)) expect(calls.mock.calls).toHaveLength(1)
  },
)
