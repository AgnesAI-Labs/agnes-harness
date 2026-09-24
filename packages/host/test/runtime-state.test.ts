import { describe, expect, it, vi } from 'vitest'
import { PublicationGate } from '../src/publication-gate.js'
import { stageCandidateRuntime } from '../src/runtime-candidate.js'
import { RuntimeStateCoordinator, RuntimeStateStaleError } from '../src/runtime-state.js'

type State = Readonly<{
  target: string
  sessions: Readonly<Record<string, string>>
}>

const state = (target: string, sessions: Readonly<Record<string, string>> = {}): State =>
  Object.freeze({ target, sessions: Object.freeze({ ...sessions }) })

describe('single runtime state publication pointer', () => {
  it('builds while dispatch is open and exchanges only after admitted reads drain', async () => {
    const gate = new PublicationGate()
    const retire = vi.fn()
    const states = new RuntimeStateCoordinator({ initial: state('old'), publication: gate, retire })
    const read = await gate.enterDispatch()
    let built = false
    const precommit = vi.fn()
    const publishing = states.publish(
      async () =>
        stageCandidateRuntime({
          build() {
            built = true
            return state('new')
          },
        }),
      { precommit },
    )

    await vi.waitFor(() => expect(built).toBe(true))
    expect(states.current().value.target).toBe('old')
    expect(precommit).not.toHaveBeenCalled()
    read.release()
    await publishing

    expect(states.current()).toMatchObject({ epoch: 2, value: { target: 'new' } })
    expect(precommit).toHaveBeenCalledOnce()
    await vi.waitFor(() =>
      expect(retire).toHaveBeenCalledWith(expect.objectContaining({ target: 'old' }), expect.anything()),
    )
  })

  it('aborts a stale candidate, rebuilds from the complete newer session set and loses no overlay', async () => {
    const gate = new PublicationGate()
    const aborted: string[] = []
    const states = new RuntimeStateCoordinator({ initial: state('v1'), publication: gate, retire: vi.fn() })
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstBuild = true
    const precommit = vi.fn((_candidate: State, base: { epoch: number }) => {
      if (base.epoch === 1) throw new Error('stale candidate must skip precommit')
    })
    const target = states.publish(
      async (base) => {
        const label = `target:${base.epoch}`
        return stageCandidateRuntime({
          async build(builder) {
            builder.onAbort(label, () => {
              aborted.push(label)
            })
            if (firstBuild) {
              firstBuild = false
              await firstMayFinish
            }
            return state('v2', base.value.sessions)
          },
        })
      },
      { precommit },
    )
    await vi.waitFor(() => expect(firstBuild).toBe(false))

    await states.publish((base) =>
      stageCandidateRuntime({
        build: () => state(base.value.target, { ...base.value.sessions, sessionA: 'preset:a' }),
      }),
    )
    releaseFirst()
    await target

    expect(states.current().value).toEqual(state('v2', { sessionA: 'preset:a' }))
    expect(aborted).toEqual(['target:1'])
    expect(precommit).toHaveBeenCalledOnce()
    expect(precommit.mock.calls[0]?.[1]).toMatchObject({ epoch: 2 })
  })

  it('keeps current unchanged and cleans the candidate when precommit fails', async () => {
    const gate = new PublicationGate()
    const cleanup = vi.fn()
    const retire = vi.fn()
    const states = new RuntimeStateCoordinator({ initial: state('old'), publication: gate, retire })

    await expect(
      states.publish(
        () =>
          stageCandidateRuntime({
            build(builder) {
              builder.onAbort('candidate-cleanup', cleanup)
              return state('new')
            },
          }),
        { precommit: () => Promise.reject(new Error('session set changed')) },
      ),
    ).rejects.toThrow('session set changed')

    expect(states.current()).toEqual({ epoch: 1, value: state('old') })
    expect(cleanup).toHaveBeenCalledOnce()
    expect(retire).not.toHaveBeenCalled()
  })

  it('opens publication before waiting for old-state retirement', async () => {
    const gate = new PublicationGate()
    let finishRetire!: () => void
    const retirement = new Promise<void>((resolve) => {
      finishRetire = resolve
    })
    const states = new RuntimeStateCoordinator({
      initial: state('old'),
      publication: gate,
      retire: () => retirement,
    })
    await states.publish(() => stageCandidateRuntime({ build: () => state('new') }))

    const ticket = await gate.enterDispatch()
    ticket.release()
    finishRetire()
    await states.drainRetirements()
  })

  it('keeps a committed target usable when old-state cleanup fails and reports it at shutdown', async () => {
    const failure = new Error('old runtime cleanup failed')
    const states = new RuntimeStateCoordinator({
      initial: state('old'),
      publication: new PublicationGate(),
      retire: () => Promise.reject(failure),
    })

    await expect(
      states.publish(() => stageCandidateRuntime({ build: () => state('new') })),
    ).resolves.toMatchObject({ value: { target: 'new' } })
    expect(states.current().value.target).toBe('new')
    await expect(states.drainRetirements()).rejects.toEqual(expect.objectContaining({ errors: [failure] }))
  })

  it('stops bounded stale retries without exchanging an unqualified candidate', async () => {
    const gate = new PublicationGate()
    const states = new RuntimeStateCoordinator({
      initial: state('v1'),
      publication: gate,
      retire: vi.fn(),
      maxRetries: 1,
    })
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const stale = states.publish(async () => {
      await wait
      return stageCandidateRuntime({ build: () => state('stale') })
    })
    await states.publish((base) =>
      stageCandidateRuntime({ build: () => state('newer', base.value.sessions) }),
    )
    release()

    await expect(stale).rejects.toBeInstanceOf(RuntimeStateStaleError)
    expect(states.current().value.target).toBe('newer')
  })
})
