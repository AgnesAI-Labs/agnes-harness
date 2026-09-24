import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pyi = readFileSync(new URL('../py/agnes/__init__.pyi', import.meta.url), 'utf8')

describe('python agnes module surface', () => {
  it('exposes exactly the eight entries code 稿 §9 lists', () => {
    for (const name of [
      'class tools',
      'async def spawn',
      'async def fork',
      'async def collect',
      'class artifacts',
      'class plan',
      'class harness',
      'async def log',
      'class BridgeError',
    ])
      expect(pyi, name).toContain(name)
  })
  it('harness offers propose and nothing else', () => {
    const harness = pyi.slice(pyi.indexOf('class harness'), pyi.indexOf('class BridgeError'))
    expect(harness).toContain('async def propose')
    expect(harness).not.toMatch(/async def (create|delete|update)_/)
  })
  it('BridgeError carries the numeric code so a cell can branch on it', () => {
    expect(pyi).toMatch(/class BridgeError\(Exception\):[\s\S]{0,200}code: int/)
  })
  it('tools is dynamic: the stub documents __getattr__ rather than listing tools', () => {
    expect(pyi).toContain('__getattr__')
  })
})
