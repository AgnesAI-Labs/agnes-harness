import { Context } from '@agnes/cordis'
import { describe, expect, it } from 'vitest'
import { greeting } from './index.js'

function currentGreeting(ctx: Context): unknown {
  return (ctx as Context & { demoGreeting?: unknown }).demoGreeting
}

describe('Cordis greeting example', () => {
  it('enables, updates configuration, rejects bad configuration, and disables cleanly', async () => {
    const root = new Context()
    const standard = greeting.Config?.['~standard']
    if (!standard) throw new Error('example schema is missing')
    const validate = standard.validate
    let schemaCalls = 0
    greeting.Config = {
      '~standard': {
        ...standard,
        validate(value: unknown) {
          schemaCalls += 1
          return validate(value)
        },
      },
    }

    const fiber = root.plugin(greeting, { message: '  hello  ' })
    await fiber
    expect(currentGreeting(root)).toBe('hello')

    await fiber.update({ message: 'updated' })
    await fiber.await()
    expect(currentGreeting(root)).toBe('updated')
    expect(schemaCalls).toBeGreaterThanOrEqual(2)

    expect(() => fiber.update({ message: 42 } as never)).toThrow(/message must be a string/)
    expect(currentGreeting(root)).toBe('updated')

    await fiber.dispose()
    expect(currentGreeting(root)).toBeUndefined()
  })
})
