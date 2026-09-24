import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadPreset,
  MINIMAL_RL_SHA256,
  PRESETS_DIR,
  readFrozenSha256,
  verifyFrozenPreset,
} from '../src/index.js'

const YAML = join(PRESETS_DIR, 'minimal-rl.yaml')
const SHA = join(PRESETS_DIR, 'minimal-rl.sha256')

/**
 * Every case that changes bytes changes them in a copy.
 *
 * Editing the tracked file in place and restoring it in an afterEach is flaky by construction under
 * a parallel runner: other test files import this package in other workers, and importing it runs
 * the gate. A crash between the edit and the restore also leaves a dirty working tree. Both
 * functions take a directory for exactly this.
 */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function scratch(o: { yaml?: string; sha?: string | null } = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'agnes-freeze-'))
  dirs.push(d)
  if (o.yaml === undefined) copyFileSync(YAML, join(d, 'minimal-rl.yaml'))
  else writeFileSync(join(d, 'minimal-rl.yaml'), o.yaml)
  if (o.sha === null) {
    /* deliberately absent */
  } else if (o.sha === undefined) copyFileSync(SHA, join(d, 'minimal-rl.sha256'))
  else writeFileSync(join(d, 'minimal-rl.sha256'), o.sha)
  return d
}

describe('minimal-rl freeze gate', () => {
  // True on the day it is written, by construction: the same algorithm produced the file it is
  // compared against. It is kept as a forward pin against drift - it is the case that goes red the
  // first time somebody edits the recipe without re-signing it - not as evidence of anything today.
  it('the frozen hash still matches the file', () => {
    expect(createHash('sha256').update(readFileSync(YAML)).digest('hex')).toBe(MINIMAL_RL_SHA256)
    expect(() => verifyFrozenPreset()).not.toThrow()
  })

  // The one with information in it: the gate refuses a file that differs by a single byte, and by a
  // byte that changes nothing a parser would notice.
  it('fails loudly when one byte changes, comments included', () => {
    const original = readFileSync(YAML, 'utf8')
    for (const [why, text] of [
      ['a trailing newline', `${original}\n`],
      [
        'one character of a comment',
        original.replace('# The reinforcement-learning baseline.', '# the reinforcement-learning baseline.'),
      ],
      ['a value', original.replace('max_steps: 100', 'max_steps: 101')],
      ['nothing but whitespace', original.replace('name: minimal-rl', 'name:  minimal-rl')],
    ] as Array<[string, string]>) {
      expect(text, why).not.toBe(original)
      const dir = scratch({ yaml: text })
      expect(() => verifyFrozenPreset(dir), why).toThrow(/E_PRESET_INVALID: minimal-rl bytes changed/)
    }
  })

  it('passes when the bytes are identical, so the refusal above is about the change', () => {
    expect(() => verifyFrozenPreset(scratch())).not.toThrow()
  })

  // The gate runs at module load, so this failure stops every import of the package. An ENOENT
  // naming a file the reader has never heard of is the wrong thing to hand whoever hits it.
  it('says how to fix itself when the recorded hash is missing', () => {
    const dir = scratch({ sha: null })
    for (const call of [() => readFrozenSha256(dir), () => verifyFrozenPreset(dir)]) {
      expect(call).toThrow(/E_PRESET_INVALID/)
      expect(call).toThrow(/minimal-rl\.sha256/)
      expect(call).toThrow(/pnpm --filter @agnes\/code gen/)
    }
  })

  it('does not extend anything and carries every field explicitly', () => {
    const doc = loadPreset('minimal-rl')
    expect(doc.extends).toBeUndefined()
    for (const key of [
      'surfaces',
      'model',
      'disclosure',
      'tools',
      'mcp',
      'skills_roots',
      'compaction',
      'budget',
      'approval',
      'sandbox',
      'subagent',
      'verifier',
      'completion_gate',
      'harness',
      'telemetry',
      'hooks',
      'locale',
    ])
      expect(doc, key).toHaveProperty(key)
  })

  it('is the two-tool training baseline with an empty prompt suffix', () => {
    const doc = loadPreset('minimal-rl')
    expect((doc.tools as { core: string[] }).core).toEqual(['shell', 'edit'])
    expect((doc.model as { prompt_sections: string[] }).prompt_sections).toEqual([])
    expect((doc.harness as { auto_refine: { enabled: boolean } }).auto_refine.enabled).toBe(false)
    expect((doc.subagent as { max_depth: number }).max_depth).toBe(0)
    expect((doc.telemetry as { consent: string }).consent).toBe('DISABLED')
    // Nothing is pre-approved: every destructive call reaches a human, and with nobody connected
    // `deny` refuses it. That posture is the baseline, not an oversight.
    const approval = doc.approval as { command_policy: unknown[]; on_unavailable: string }
    expect(approval.command_policy).toEqual([])
    expect(approval.on_unavailable).toBe('deny')
  })

  // Nine keys in this file have no reader. They are kept - the baseline states its whole intent,
  // including the parts the kernel has not been taught to honour - and each one says so in the file,
  // so nobody reads `consent: DISABLED` as a setting that is in force. This is what stops the
  // annotations being quietly deleted.
  it('marks every key that nothing reads', () => {
    const text = readFileSync(YAML, 'utf8')
    // Each of these is declared here and read by nothing, today.
    for (const key of [
      'surfaces',
      'core',
      'mcp',
      'skills_roots',
      'attribution',
      'completion_gate',
      'auto_refine',
      'consent',
      'hooks',
      'locale',
    ])
      expect(text, key).toContain(key)
    // One marker per unread key. A count, not a mere presence, so deleting eight of the nine
    // annotations while leaving one is still a failure.
    expect(text.match(/NOT CONSUMED/g)?.length ?? 0).toBeGreaterThanOrEqual(9)
    // And the recipe says how to re-sign itself, which is the only supported way to change it.
    expect(text).toContain('pnpm --filter @agnes/code')
  })
})
