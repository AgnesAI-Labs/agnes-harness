import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dir = new URL('../schema/acp/', import.meta.url)
const schema = readFileSync(new URL('schema.json', dir))
const upstream = readFileSync(new URL('UPSTREAM.md', dir), 'utf8')
const deviations = readFileSync(new URL('DEVIATIONS.md', dir), 'utf8')

describe('acp vendor', () => {
  it('UPSTREAM.md sha256 matches schema.json', () => {
    const sha = createHash('sha256').update(schema).digest('hex')
    expect(upstream).toContain(`sha256: ${sha}`)
  })
  it('schema.json parses and has definitions', () => {
    const doc = JSON.parse(schema.toString('utf8'))
    const defs = doc.definitions ?? doc.$defs
    expect(defs).toBeDefined()
    expect(Object.keys(defs).length).toBeGreaterThan(20)
  })
  it('DEVIATIONS.md lists the first batch', () => {
    for (const id of ['E1', 'E2', 'E3', 'E4', 'R1', 'R2', 'U1', 'U2'])
      expect(deviations).toMatch(new RegExp(`^\\| ${id} \\|`, 'm'))
  })
})

// The "definitions used by this repo" line in UPSTREAM.md must list names actually verified against
// the vendored schema with `jq`, not guesses copied from somewhere else. This test pins "these 16
// names really do exist in the upstream schema.json" as a runtime assertion, rather than relying on a
// one-off manual check. The last six arrived with Task 6b, which pulled authenticate / session/load /
// session/set_mode forward into the I1 method table; the vendored schema.json itself did not change.
describe('acp vendor: definitions used by this repo actually exist upstream', () => {
  const USED_DEFINITIONS = [
    'InitializeRequest',
    'InitializeResponse',
    'NewSessionRequest',
    'NewSessionResponse',
    'PromptRequest',
    'PromptResponse',
    'CancelNotification',
    'SessionNotification',
    'RequestPermissionRequest',
    'RequestPermissionResponse',
    'AuthenticateRequest',
    'AuthenticateResponse',
    'LoadSessionRequest',
    'LoadSessionResponse',
    'SetSessionModeRequest',
    'SetSessionModeResponse',
  ]
  it('every definition UPSTREAM.md claims we use is present in $defs', () => {
    const doc = JSON.parse(schema.toString('utf8'))
    const defs = doc.definitions ?? doc.$defs
    for (const name of USED_DEFINITIONS) expect(defs).toHaveProperty(name)
  })
  it('UPSTREAM.md documents each of them by name', () => {
    for (const name of USED_DEFINITIONS) expect(upstream).toContain(name)
  })
})
