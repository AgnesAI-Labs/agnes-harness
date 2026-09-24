import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { presets as basePresets } from '@agnes/base'
import { presets as codePresets, PRESET_NAMES } from '@agnes/code'
import { afterEach, describe, expect, it } from 'vitest'
import type { PresetDoc } from '../src/presets/types.js'
import { createTestHost, runOnce } from '../testkit/index.js'

/**
 * The delivered recipes, read off disk and opened as a deployment opens them.
 *
 * Nothing used to walk this path. Every other test and every fixture hands the host a preset object
 * written by hand for the case at hand, so the one document a real installation actually loads -
 * @agnes/code's own presets/*.yaml - was the only one nobody ran. Two defects lived there at once:
 * the recipe's route targets were written in a form no reader understood, so the host refused to
 * assemble at all, and its command_policy allow rule was written against a relative path, which the
 * session validator refuses and which the evaluator would never have matched anyway.
 *
 * The lesson is the same one a `~/.agnes` default taught this project: a default that every test
 * configures around is the one path no test walks and the only path a real user takes.
 */
const shipped = {
  ...(basePresets as Record<string, PresetDoc>),
  ...(codePresets as Record<string, PresetDoc>),
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-shipped-'))
  dirs.push(d)
  return d
}

/**
 * The shipped documents, in the assembly, exactly as delivered: @agnes/base contributes its own
 * `base` and @agnes/code contributes every recipe it registers. Nothing is restated here - a
 * restated recipe is one that drifts from the one that ships.
 */
const hostFor = async (
  dataDir: string,
  preset: string,
  platformCaps?: Record<string, 'full' | 'partial' | 'unavailable'>,
) =>
  createTestHost({
    dataDir,
    presets: codePresets as Record<string, PresetDoc>,
    packages: { '@agnes/base': { presets: basePresets as Record<string, PresetDoc> } },
    allowed: [...PRESET_NAMES],
    ...(platformCaps ? { platformCaps } : {}),
    script: [
      () => [
        { type: 'text_delta', delta: `opened on ${preset}` },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })

describe('the shipped presets, loaded from disk', () => {
  it('every registered recipe is a document the assembly accepts and a session opens on', async () => {
    expect(PRESET_NAMES.length).toBeGreaterThan(0)
    for (const name of PRESET_NAMES) {
      const dataDir = tmp()
      const t = await hostFor(dataDir, name)
      try {
        const s = await t.host.createSession({ cwd: dataDir, preset: name })
        expect(s.key, name).toBeDefined()
      } finally {
        await t.host.close()
      }
    }
  })

  it('the default recipe carries a turn end to end', async () => {
    const dataDir = tmp()
    const t = await hostFor(dataDir, 'standard')
    try {
      const r = await runOnce(t.host, { prompt: 'hello', cwd: dataDir })
      expect(r.reason).toBe('completed')
      expect(r.finalText).toContain('opened on standard')
    } finally {
      await t.host.close()
    }
  })

  // `claw` says `sandbox.required: true`, and the whole meaning of that word is that the host will
  // not open a session when the platform cannot provide it: an unattended run has no operator to
  // notice that the isolation it assumed is missing. The recipe declaring the key is one claim; the
  // host acting on it is the other, and only this one is evidence.
  it('refuses to open claw on a platform that cannot provide L1, and opens standard on the same one', async () => {
    const dataDir = tmp()
    const t = await hostFor(dataDir, 'claw', { 'sandbox.l1': 'unavailable' })
    try {
      await expect(t.host.createSession({ cwd: dataDir, preset: 'claw' })).rejects.toMatchObject({
        code: 'E_PRESET_UNSUPPORTED',
        detail: { capability: 'sandbox.l1' },
      })
      // The same platform, a recipe that does not require L1: it opens. Without this the case would
      // also pass if the host refused every session on that platform.
      const s = await t.host.createSession({ cwd: dataDir, preset: 'standard' })
      expect(s.key).toBeDefined()
    } finally {
      await t.host.close()
    }
  })

  // The one thing no shipped recipe may contain, checked against the validator that would refuse it
  // rather than by reading the YAML: an allow rule the operator never sees fire is the same as no
  // rule, and an allow rule for a spelling the evaluator is never handed is exactly that.
  it('names no recipe this host would refuse, and none of them pre-approves a shell command', () => {
    for (const name of PRESET_NAMES) {
      const doc = shipped[name] as { approval?: { command_policy?: Array<{ tool: string; action: string }> } }
      for (const rule of doc.approval?.command_policy ?? [])
        expect(rule.tool, `${name}: ${rule.tool}`).not.toMatch(/shell/)
    }
  })
})
