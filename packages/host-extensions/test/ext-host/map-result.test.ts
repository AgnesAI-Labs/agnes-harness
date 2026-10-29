import { expect, it } from 'vitest'
import { mapResult } from '../../src/ext-host/map-result.js'

it('reads a thenable once and maps its first settlement only', async () => {
  let reads = 0,
    mapped = 0
  const value = {
    // biome-ignore lint/suspicious/noThenProperty: intentional hostile thenable fixture
    get then() {
      reads++
      if (reads > 1) throw new Error('read twice')
      return (resolve: (value: unknown) => void, reject: (error: Error) => void) => {
        resolve(7)
        resolve(8)
        reject(new Error('late reject'))
      }
    },
  }
  expect(
    await mapResult(value, (result) => {
      mapped++
      return result
    }),
  ).toBe(7)
  expect(reads).toBe(1)
  expect(mapped).toBe(1)
})

it('preserves synchronous mapping and routes asynchronous validation failures to rejection', async () => {
  expect(mapResult(null, (value) => value)).toBeNull()
  const failure = new Error('invalid payload')
  expect(() =>
    mapResult({}, () => {
      throw failure
    }),
  ).toThrow(failure)
  await expect(
    mapResult(Promise.resolve({}), () => {
      throw failure
    }),
  ).rejects.toBe(failure)
  let mapped = false
  await expect(
    mapResult(Promise.reject(failure), () => {
      mapped = true
    }),
  ).rejects.toBe(failure)
  expect(mapped).toBe(false)
})
