import { LocalGate } from '@agnes/plugin-runtime/host'
import { describe, expect, it, vi } from 'vitest'
import { admitWorkerCommand } from '../src/commands.js'

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('worker LocalGate command admission', () => {
  it('queues every command behind a closed reconcile writer', async () => {
    const gate = new LocalGate()
    const writerBody = deferred()
    const writer = gate.withClosed(() => writerBody.promise)
    const execute = vi.fn(() => ({ ok: true }))
    const admitted = admitWorkerCommand(gate, execute)

    await flushMicrotasks()
    expect(execute).not.toHaveBeenCalled()

    writerBody.resolve()
    await writer
    await expect(admitted).resolves.toEqual({ ok: true })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('releases admission after synchronous handoff instead of retaining it for async command work', async () => {
    const gate = new LocalGate()
    const commandBody = deferred()
    const command = admitWorkerCommand(gate, () => commandBody.promise)
    await flushMicrotasks()

    const writerBody = vi.fn()
    await gate.withClosed(writerBody)
    expect(writerBody).toHaveBeenCalledOnce()

    let commandSettled = false
    void command.then(() => {
      commandSettled = true
    })
    await flushMicrotasks()
    expect(commandSettled).toBe(false)

    commandBody.resolve()
    await command
  })

  it('propagates fatal gate closure without executing the command', async () => {
    const gate = new LocalGate()
    await expect(
      gate.withClosed(
        () => {
          throw new Error('fatal reconcile')
        },
        { fatal: true },
      ),
    ).rejects.toThrow('fatal reconcile')
    const execute = vi.fn()

    await expect(admitWorkerCommand(gate, execute)).rejects.toThrow('E_LOCAL_GATE_FATAL')
    expect(execute).not.toHaveBeenCalled()
  })
})
