import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../public/styles/27-conversation-stream.css', import.meta.url), 'utf8')

describe('answer action row', () => {
  it('is always shown, not only on hover', () => {
    expect(css).not.toMatch(/\.turn-footer\s*\{[^}]*opacity:\s*0/)
    expect(css).not.toMatch(/:hover\s+\.turn-footer/)
  })
})
