import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
const snapshot = JSON.parse(
  readFileSync(new URL('./api-surface.snapshot.json', import.meta.url), 'utf8'),
) as string[]

function walk(d: string, out: string[] = []): string[] {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    statSync(p).isDirectory() ? walk(p, out) : e.endsWith('.ts') && out.push(p)
  }
  return out
}

describe('ai public surface', () => {
  // Two-way: the snapshot file is the reviewable list of what this package promises, so adding an
  // export without recording it there is as red as dropping one.
  it('exports exactly the snapshot', async () => {
    const mod = await import('../src/index.js')
    expect(Object.keys(mod).sort()).toEqual([...snapshot].sort())
  })
  // The wire library is an implementation detail of the adapters that speak its protocol. Anywhere
  // else it would leak a third-party type into shapes other packages consume. The dependency itself
  // arrives with the adapters in Task 9; until then this holds vacuously and costs nothing.
  it('only adapters/pi and adapters/media import pi-ai', () => {
    const offenders = walk(srcDir)
      .filter((f) => /from ['"]@earendil-works\/pi-ai/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(srcDir.length).split(sep).join('/'))
      .filter((rel) => !rel.startsWith('adapters/pi/') && !rel.startsWith('adapters/media/'))
    expect(offenders).toEqual([])
  })
  // The gateway adapter is a subclass of the pi one, not a second implementation of the same wire
  // protocol: it reaches the library through `../pi/` so that a change to how a request is built
  // lands in one place. The directory arrives in a later task; until then this holds vacuously.
  it('adapters/agnes reaches the wire library only through adapters/pi', () => {
    const agnes = join(srcDir, 'adapters/agnes')
    const files = statSync(agnes, { throwIfNoEntry: false })?.isDirectory() ? walk(agnes) : []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/from ['"]@earendil-works\/pi-ai/)
      expect(text, f).not.toMatch(/from ['"]\.\.\/(?!pi\/)/)
    }
  })
  // The decode chain is specified as bytes, not as behaviour of one runtime: a second implementation
  // has to reproduce the same events from the same fixtures. Anything from node would make that
  // impossible to check, so the directory carries its own digest rather than importing one.
  it('decode/ imports no node builtins', () => {
    const decode = join(srcDir, 'decode')
    for (const f of walk(decode)) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from ['"]node:/)
  })
  it('index.ts does not re-export pi-ai types', () => {
    expect(readFileSync(join(srcDir, 'index.ts'), 'utf8')).not.toMatch(/pi-ai/)
  })
  // This package sits below the kernel and above nothing, so it may name only the protocol shapes.
  // Platform branching belongs to the host adapters that own it, never here.
  //
  // The `@agnes/core` half of this ban is deliberately stricter than the dependency allowlist, which
  // permits ai -> core: nothing here imports core today, and `Provider` lives in protocol rather
  // than core, so the stronger rule is the true one and is worth holding. Revisit it at the first
  // task that legitimately needs a core shape, and relax it then. If no task ever does, tighten the
  // allowlist to match this instead of loosening this to match the allowlist.
  it('never imports core, host, base or node platform checks', () => {
    for (const f of walk(srcDir)) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/from ['"]@agnes\/(core|host|base|code|daemon|cli)/)
      expect(text, f).not.toMatch(/process\.platform|os\.platform\(\)/)
    }
  })
})
