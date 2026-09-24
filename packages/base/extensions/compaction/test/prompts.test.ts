import { describe, expect, it } from 'vitest'
import { fileDetails } from '../src/details.js'
import { buildPrompts, IN_PROGRESS_NOTE, SUMMARY_SYSTEM } from '../src/prompts.js'

describe('compaction prompts', () => {
  it('names every required section and forbids invention', () => {
    for (const section of [
      'Goal',
      'Constraints',
      'Progress',
      'Key decisions',
      'Next steps',
      'Critical context',
    ])
      expect(SUMMARY_SYSTEM).toContain(section)
    expect(SUMMARY_SYSTEM).toMatch(/never invent/i)
  })

  it('builds initial and iterative variants with optional turn prefix', () => {
    const initial = buildPrompts({ hasPrevious: false, hasPrefix: false })
    expect(initial.history).toContain('preceding conversation segment')
    expect(initial.prefix).toBeUndefined()

    const update = buildPrompts({
      hasPrevious: true,
      hasPrefix: true,
      customInstructions: 'keep all file paths',
    })
    expect(update.history).toContain('previous summary')
    expect(update.history).toMatch(/PRESERVE.*ADD.*UPDATE/s)
    expect(update.prefix).toContain('turn continues below')
    expect(Object.values(initial).join('\n')).not.toMatch(/\{\{(?:HISTORY|PREVIOUS_SUMMARY)\}\}/)
    expect(Object.values(update).join('\n')).not.toMatch(/\{\{(?:HISTORY|PREVIOUS_SUMMARY)\}\}/)
    expect(update.system.endsWith('Additional instructions (highest priority):\nkeep all file paths')).toBe(
      true,
    )
  })
})

describe('in-progress tail', () => {
  it('asks for the opening request and no predictions when the range ends inside a running turn', () => {
    for (const hasPrevious of [false, true]) {
      const prompts = buildPrompts({ hasPrevious, hasPrefix: false, inProgressTail: true })
      expect(prompts.history.endsWith(IN_PROGRESS_NOTE)).toBe(true)
      expect(Object.values(prompts).join('\n')).not.toMatch(/\{\{[^}]*\}\}/)
      expect(buildPrompts({ hasPrevious, hasPrefix: false }).history).not.toContain(IN_PROGRESS_NOTE)
    }
    expect(IN_PROGRESS_NOTE).toMatch(/request that opened/)
    expect(IN_PROGRESS_NOTE).toContain('turn continues below')
    expect(buildPrompts({ hasPrevious: false, hasPrefix: true }).prefix).toMatch(/request that opened/)
  })
})

describe('fileDetails', () => {
  it('classifies paths, deduplicates them, and finds simple shell redirects', () => {
    expect(
      fileDetails([
        { name: 'read', args: { path: 'a.ts' } },
        { name: 'grep', args: { pattern: 'x', path: 'src' } },
        { name: 'read', args: { path: 'a.ts' } },
        { name: 'edit', args: { path: 'a.ts', edits: [] } },
        { name: 'write', args: { path: 'b.md', content: '' } },
        { name: 'shell', args: { command: 'echo hi > "out file.txt" && ls | tee -a log.txt 2>&1' } },
      ]),
    ).toEqual({
      readFiles: ['a.ts', 'src'],
      modifiedFiles: ['a.ts', 'b.md', 'out file.txt', 'log.txt'],
    })
  })

  it('caps each accumulated list at fifty paths', () => {
    const calls = Array.from({ length: 55 }, (_, index) => ({
      name: 'read',
      args: { path: `${index}.txt` },
    }))
    expect(fileDetails(calls).readFiles).toHaveLength(50)
  })
})
