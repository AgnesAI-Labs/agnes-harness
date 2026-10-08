import { describe, expect, it, vi } from 'vitest'
import { createComputerUseHostDispatchPort } from '../../src/computer-use/host-dispatch.js'

const input = (overrides: Record<string, unknown> = {}) => ({
  name: 'computer_use',
  args: { action: 'list_windows' },
  context: {} as never,
  attempt: 1 as const,
  invoke: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
  ...overrides,
})

describe('Computer Use Host dispatch port', () => {
  it('invokes only the exact built-in Computer Use tool and returns its result', async () => {
    const call = input()
    await expect(createComputerUseHostDispatchPort().dispatch(call)).resolves.toMatchObject({
      phase: 'responded',
      result: { content: [{ type: 'text', text: 'ok' }] },
    })
    expect(call.invoke).toHaveBeenCalledOnce()
  })

  it('refuses another tool before invocation', async () => {
    const call = input({ name: 'shell' })
    await expect(createComputerUseHostDispatchPort().dispatch(call)).resolves.toMatchObject({
      phase: 'not_sent',
    })
    expect(call.invoke).not.toHaveBeenCalled()
  })

  it('classifies an unproven backend failure as an unknown outcome', async () => {
    const call = input({ invoke: vi.fn(async () => Promise.reject(new Error('transport lost'))) })
    await expect(createComputerUseHostDispatchPort().dispatch(call)).resolves.toMatchObject({
      phase: 'may_have_sent',
    })
  })
})
