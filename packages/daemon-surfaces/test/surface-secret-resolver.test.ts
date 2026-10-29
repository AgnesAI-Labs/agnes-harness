import { expect, it, vi } from 'vitest'
import { createSurfaceSecretResolver } from '../src/surfaces/secret-resolver.js'

const signal = new AbortController().signal

it('adapts a synchronous host resolver to the async Surface contract', async () => {
  const resolver = createSurfaceSecretResolver((ref) => `value-for:${ref}`)
  await expect(resolver.resolve('secret://customer/token', signal)).resolves.toBe(
    'value-for:secret://customer/token',
  )
})

it('returns a plain string, never a lease -- dispose is a deliberate no-op', async () => {
  const resolver = createSurfaceSecretResolver(() => 'v')
  const out = await resolver.resolve('secret://a/b', signal)
  expect(typeof out).toBe('string')
})

it('propagates resolver failures rather than substituting a placeholder', async () => {
  const resolver = createSurfaceSecretResolver(() => {
    throw new Error('no such secret')
  })
  await expect(resolver.resolve('secret://a/b', signal)).rejects.toThrow('no such secret')
})

it('honours an already-aborted signal before touching the resolver', async () => {
  const controller = new AbortController()
  controller.abort()
  const inner = vi.fn(() => 'v')
  const resolver = createSurfaceSecretResolver(inner)
  await expect(resolver.resolve('secret://a/b', controller.signal)).rejects.toThrow()
  expect(inner).not.toHaveBeenCalled()
})
