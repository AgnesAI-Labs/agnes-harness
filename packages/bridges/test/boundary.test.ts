import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageDir = fileURLToPath(new URL('../', import.meta.url))
const srcDir = fileURLToPath(new URL('../src/', import.meta.url))

function listTypeScript(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? listTypeScript(path) : entry.endsWith('.ts') ? [path] : []
  })
}

describe('bridges package boundary', () => {
  it('publishes only exits backed by files and does not claim the future service bin', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      exports: Record<string, string>
      bin?: Record<string, string>
    }
    expect(manifest.bin).toBeUndefined()
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './convert': './src/convert/index.ts',
      './trajectory': './src/trajectory/upload-client.ts',
      './data/*': './data/*',
    })
    for (const target of Object.values(manifest.exports).filter((path) => !path.includes('*')))
      expect(existsSync(join(packageDir, target)), target).toBe(true)
    expect(existsSync(join(packageDir, 'data/skill-roots.json'))).toBe(true)
    expect(existsSync(join(packageDir, 'data/hooks-map.json'))).toBe(true)
  })

  it('keeps the pure half on the protocol-only dependency boundary', () => {
    for (const file of listTypeScript(srcDir).filter(
      (path) => path.includes('/convert/') || path.includes('/data/'),
    )) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/from ['"]node:/)
      expect(source, file).not.toMatch(/from ['"]@agnes\/(?!protocol)/)
      expect(source, file).not.toMatch(/from ['"]@modelcontextprotocol/)
    }
  })

  it('never imports upward into core, host, base, daemon, or code', () => {
    for (const file of listTypeScript(srcDir))
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from ['"]@agnes\/(core|host|base|daemon|code)/)
  })
})
