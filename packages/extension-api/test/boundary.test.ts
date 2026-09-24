import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = fileURLToPath(new URL('../src/', import.meta.url))
const files: string[] = []
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (e.endsWith('.ts')) files.push(p)
  }
}
walk(src)

describe('extension-api boundary', () => {
  it('imports only @agnes/protocol and no node:* modules', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/from ['"]node:/)
      const agnesImports = [...text.matchAll(/from ['"](@agnes\/[a-z-]+)/g)].map((m) => m[1])
      for (const dep of agnesImports) expect(dep, f).toBe('@agnes/protocol')
    }
  })
  it('has no seam-style registration symbols', () => {
    for (const f of files)
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/registerSeam|registerProvider|registerOperation/)
  })
  it('contains at least the index module', () => {
    expect(files.some((f) => basename(f) === 'index.ts')).toBe(true)
  })
})

// The package carries stand-ins for things protocol has not defined yet: the authz / jobs aliases
// in src/pending.ts. Each has to turn red on the day protocol supplies the real definition, because
// protocol puts every schema definition on its root export surface automatically — a local copy
// would then quietly shadow the authoritative one, and nothing would notice if the two shapes had
// drifted apart. ArtifactRef went through exactly that: protocol now defines it, the private copy in
// src/common.ts is gone, and the case below holds the re-attachment in place from both sides.
const protocolSchema = (f: string) => new URL(`../../protocol/schema/${f}`, import.meta.url)

describe('protocol re-attach guards', () => {
  it('jobs types come from protocol after its schema arrives', () => {
    expect(existsSync(protocolSchema('jobs.json'))).toBe(true)
    const pendingPath = new URL('../src/pending.ts', import.meta.url)
    const pending = existsSync(pendingPath) ? readFileSync(pendingPath, 'utf8') : ''
    expect(pending).not.toMatch(/export type (JobSpec|JobStatus) =/)
    const tool = readFileSync(new URL('../src/tool.ts', import.meta.url), 'utf8')
    expect(tool).toMatch(/import type \{[^}]*\bJobSpec\b[^}]*\bJobStatus\b[^}]*\} from '@agnes\/protocol'/)
  })
  it('ArtifactRef comes from protocol, not from a private copy', () => {
    const doc = JSON.parse(readFileSync(protocolSchema('session-v1.json'), 'utf8')) as {
      $defs: Record<string, unknown>
    }
    expect(Object.keys(doc.$defs), 'protocol owns ArtifactRef').toContain('ArtifactRef')
    const common = readFileSync(new URL('../src/common.ts', import.meta.url), 'utf8')
    expect(
      common,
      'src/common.ts declares its own ArtifactRef again, which shadows the authoritative one',
    ).not.toMatch(/export type ArtifactRef =/)
    expect(common).toMatch(/export type \{ ArtifactRef \} from '@agnes\/protocol'/)
  })
  it('authz types come from the protocol schema after reattachment', () => {
    expect(existsSync(protocolSchema('authz.json'))).toBe(true)
    const pendingPath = new URL('../src/pending.ts', import.meta.url)
    const pending = existsSync(pendingPath) ? readFileSync(pendingPath, 'utf8') : ''
    expect(pending).not.toMatch(/export type (Action|Target|Decision) =/)
    const tool = readFileSync(new URL('../src/tool.ts', import.meta.url), 'utf8')
    for (const name of ['Action', 'Target', 'Decision'])
      expect(tool).toMatch(
        new RegExp(String.raw`import type \{[^}]*\b${name}\b[^}]*\} from '@agnes/protocol'`),
      )
  })
})
