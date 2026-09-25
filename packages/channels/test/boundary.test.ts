import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const roots = [
  fileURLToPath(new URL('../src/', import.meta.url)),
  fileURLToPath(new URL('../testkit/', import.meta.url)),
]

function sourceFiles(): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith('.ts')) files.push(path)
    }
  }
  for (const root of roots) if (existsSync(root)) walk(root)
  return files
}

describe('channels boundary', () => {
  it('publishes only entrypoints that exist', () => {
    const packageRoot = new URL('../', import.meta.url)
    const packageJson = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
      exports?: Record<string, string>
      bin?: Record<string, string>
    }

    for (const [name, target] of Object.entries({
      ...packageJson.exports,
      ...packageJson.bin,
    })) {
      expect(existsSync(fileURLToPath(new URL(target, packageRoot))), `${name} -> ${target}`).toBe(true)
    }
  })

  it('keeps daemon discovery and private-file dependencies in their designated entrypoints', () => {
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8')
      const imports = text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](@agnes\/[a-z-]+)/g)
      const allowed = ['@agnes/sdk', '@agnes/protocol']
      if (file === fileURLToPath(new URL('../src/runner/client.ts', import.meta.url)))
        allowed.push('@agnes/daemon')
      if (file === fileURLToPath(new URL('../src/runner/config.ts', import.meta.url)))
        allowed.push('@agnes/system-node')
      for (const match of imports) {
        expect(allowed, `${file} imports ${match[1]}`).toContain(match[1])
      }
    }
  })

  it('confines platform inspection to the private credential reader and the ref store sync', () => {
    for (const file of sourceFiles()) {
      let source = readFileSync(file, 'utf8')
      if (file === fileURLToPath(new URL('../src/runner/config.ts', import.meta.url)))
        source = source.replace(
          /^const windowsSecrets = process\.platform === 'win32' \/\/ guards-allow-platform: Channels private credential file reader\.\r?$/m,
          '',
        )
      if (file === fileURLToPath(new URL('../src/runner/ref-store.ts', import.meta.url)))
        source = source.replace(
          /^const darwin = process\.platform === 'darwin' \/\/ guards-allow-platform: F_FULLFSYNC is darwin-only\.\r?$/m,
          '',
        )
      expect(source, file).not.toMatch(/process\.platform|os\.platform\(\)|os\.type\(\)/)
    }
  })
})
