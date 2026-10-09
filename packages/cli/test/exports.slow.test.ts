import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('cli export surface and guards', () => {
  it('keeps root runtime exports stable', async () => {
    const mod = await import('../src/index.js')
    expect(Object.keys(mod).sort()).toMatchSnapshot()
  }, 15_000)

  it('keeps args.ts under 300 code lines', () => {
    const lines = readFileSync(new URL('../src/args.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('//'))
    expect(lines.length).toBeLessThanOrEqual(300)
  })

  it('keeps every command module outside core and extension-api', () => {
    const dir = new URL('../src/commands/', import.meta.url)
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), 'utf8')
      expect(source, file).not.toMatch(/['"]@agnes\/(?:core|extension-api)(?:\/[^'"]*)?['"]/)
    }
  })
})
