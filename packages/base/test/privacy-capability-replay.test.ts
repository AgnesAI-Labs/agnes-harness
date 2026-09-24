import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allowsContent, allowsUpload, transitionConsent } from '../extensions/privacy/src/consent.js'
import { type RedactRules, redactText } from '../extensions/privacy/src/redact.js'

type RedactCase = {
  id: string
  kind: 'redact'
  input: string
  rules: RedactRules
  expect: { text: string; hits: Record<string, number> }
}

type ConsentCase = {
  id: string
  kind: 'consent'
  from: 'DISABLED' | 'LOCAL' | 'ANON' | 'FULL'
  to: 'DISABLED' | 'LOCAL' | 'ANON' | 'FULL'
  explicit: boolean
  by: string
  expect: { ok: boolean; reason?: string; upload: boolean; content: boolean }
}

type CapabilityCase = RedactCase | ConsentCase

const cases = readFileSync(new URL('../fixtures/capability/privacy-consent.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as CapabilityCase)

describe('privacy capability replay corpus', () => {
  it('keeps a non-vacuous, uniquely named corpus', () => {
    expect(cases.length).toBeGreaterThanOrEqual(3)
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length)
    expect(new Set(cases.map((entry) => entry.kind))).toEqual(new Set(['redact', 'consent']))
  })

  it.each(cases)('$id', (entry) => {
    if (entry.kind === 'redact') {
      const result = redactText(entry.input, entry.rules)
      expect(result).toEqual(entry.expect)
      return
    }

    const result = transitionConsent(entry.from, entry.to, {
      explicit: entry.explicit,
      by: entry.by,
    })
    expect(result.ok).toBe(entry.expect.ok)
    if (!result.ok) expect(result.reason).toBe(entry.expect.reason)
    expect(allowsUpload(entry.to)).toBe(entry.expect.upload)
    expect(allowsContent(entry.to)).toBe(entry.expect.content)
  })
})
