import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BASE_TARGETS, projectCcHookMap, projectSkillRoots } from '../generate/emit-base.js'
import { loadHooksMap, loadSkillRoots } from '../src/index.js'

describe('emit-base', () => {
  it('projects skill roots in precedence order without notes', () => {
    const output = projectSkillRoots(loadSkillRoots())
    expect(output).toHaveLength(5)
    expect(output.every((root) => !('note' in root))).toBe(true)
    expect(output.map((root) => root.root)).toEqual(loadSkillRoots().map((root) => root.root))
    expect(output[0]).toEqual({
      root: '~/.agh/skills',
      host: 'agnes',
      layout: 'dir/SKILL.md',
      trust: 'user',
    })
  })

  it('projects hooks in canonical CC order and deliberately omits field implementation detail', () => {
    const output = projectCcHookMap(loadHooksMap(), '0.0.0')
    expect(output.$generated).toBe('generated from @agnes/bridges@0.0.0 — do not edit')
    expect(output.version).toBe('0.0.0')
    expect(Object.keys(output.events)).toEqual(Object.keys(loadHooksMap().events))
    expect(output.events.PreToolUse).toEqual({ to: ['tool_call'], unsupportedFields: ['updatedInput'] })
    expect(output.events.Notification).toEqual({ to: null, reason: 'UI notification; no harness event' })
    expect('fields' in (output.events.PreToolUse as object)).toBe(false)
  })

  it('keeps both base targets in sync with a fresh stable projection', () => {
    expect(BASE_TARGETS.map((target) => target.relPath)).toEqual([
      'base/extensions/skills/generated/skill-roots.json',
      'base/extensions/hooks-runner/generated/cc-hook-map.json',
    ])
    for (const target of BASE_TARGETS) {
      const path = new URL(`../../${target.relPath}`, import.meta.url)
      expect(existsSync(path), target.relPath).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe(target.render('0.0.0'))
    }
  })
})
