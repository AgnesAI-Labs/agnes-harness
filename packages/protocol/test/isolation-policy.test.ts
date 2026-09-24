import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { validateExtensionIsolationPolicy, validateExtensionIsolationRequest } from '../src/index.js'
import { runFixtureLine } from '../tools/conformance-core.js'

const rows = readFileSync(new URL('../fixtures/configs/isolation.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
it.each(rows)('$id', (row) => expect(runFixtureLine(row).pass).toBe(true))
it('copies data without invoking policy accessors and enforces exact IDs and requests', () => {
  let called = false
  expect(
    validateExtensionIsolationPolicy({
      get extensions() {
        called = true
        return {}
      },
    }).ok,
  ).toBe(false)
  expect(called).toBe(false)
  const input = { backend: 'auto', extensions: { 'acme/plugin': 'required' } },
    checked = validateExtensionIsolationPolicy(input)
  expect(checked.ok).toBe(true)
  if (checked.ok) expect(checked.value).not.toBe(input)
  expect(validateExtensionIsolationRequest({ extensions: { 'acme/plugin': 'off' } }).ok).toBe(false)
})
