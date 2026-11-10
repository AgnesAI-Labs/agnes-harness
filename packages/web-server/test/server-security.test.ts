import { expect, it } from 'vitest'
import { loopbackHost } from '../src/server-security.js'

const CANONICAL = '127.0.0.1:4177'

it('a different-port Host is rejected', () => {
  expect(loopbackHost('127.0.0.1:4178', CANONICAL, 4177)).toBeUndefined()
  expect(loopbackHost('localhost:4178', CANONICAL, 4177)).toBeUndefined()
  expect(loopbackHost('[::1]:9999', CANONICAL, 4177)).toBeUndefined()
  expect(loopbackHost('127.0.0.1', CANONICAL, 4177)).toBeUndefined()
})

it('accepts the page origin and other loopback names on the same port only', () => {
  expect(loopbackHost('127.0.0.1:4177', CANONICAL, 4177)).toBe('canonical')
  expect(loopbackHost('localhost:4177', CANONICAL, 4177)).toBe('alias')
  expect(loopbackHost('[::1]:4177', CANONICAL, 4177)).toBe('alias')
})

it('rejects a name that merely resolves to loopback', () => {
  expect(loopbackHost('rebind.example.com:4177', CANONICAL, 4177)).toBeUndefined()
  expect(loopbackHost(undefined, CANONICAL, 4177)).toBeUndefined()
})
