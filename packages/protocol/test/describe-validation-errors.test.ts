import { describe, expect, it } from 'vitest'
import { describeValidationErrors, type ValidationError } from '../src/index.js'

const error = (over: Partial<ValidationError>): ValidationError => ({
  path: '/data/durationMs',
  message: 'Expected integer to be greater or equal to 0',
  code: 'RANGE',
  ...over,
})

describe('describeValidationErrors', () => {
  it('puts the path in front of the first message', () => {
    expect(describeValidationErrors([error({})])).toBe(
      '/data/durationMs Expected integer to be greater or equal to 0',
    )
  })

  it('joins the parent path and the key of a missing property', () => {
    expect(
      describeValidationErrors([
        error({ path: '/data', key: 'effectId', code: 'MISSING', message: 'Expected required property' }),
      ]),
    ).toBe('/data/effectId Expected required property')
  })

  it('leaves a root-level error as its message alone', () => {
    expect(describeValidationErrors([error({ path: '', message: 'Expected object' })])).toBe(
      'Expected object',
    )
  })

  it('counts the errors after the first', () => {
    expect(describeValidationErrors([error({}), error({ path: '/a' }), error({ path: '/b' })])).toBe(
      '/data/durationMs Expected integer to be greater or equal to 0 (+2 more)',
    )
  })

  it('cuts a very long path', () => {
    const text = describeValidationErrors([error({ path: `/data/${'k'.repeat(500)}` })])
    expect(text.length).toBeLessThan(260)
    expect(text).toContain('…')
  })

  it('answers for an empty list', () => {
    expect(describeValidationErrors([])).toBe('invalid')
  })
})
