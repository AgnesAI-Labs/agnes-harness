import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DYNAMIC_MASK_SELECTORS,
  MATRIX_COMBINATIONS,
  PARITY_LAYERS,
  STATE_MATRIX,
  THEMES,
  VIEWPORTS,
  // @ts-expect-error The acceptance harness is executable ESM JavaScript and intentionally has no product TS API.
} from '../../../tools/acceptance/web-parity.mjs'

const repoRoot = resolve(
  process.cwd().endsWith('/packages/web') ? process.cwd() : resolve(process.cwd(), 'packages/web'),
  '../..',
)
const script = resolve(repoRoot, 'tools/acceptance/web-parity.mjs')

describe('web parity acceptance harness', () => {
  it('has a runnable deterministic and reverse-mutation self-test', () => {
    expect(existsSync(script)).toBe(true)
    const output = execFileSync(process.execPath, [script, '--self-test'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(output).toContain('SELF-TEST PASS')
    expect(output).toContain('4 reverse mutations')
  })

  it('freezes the complete D31 matrix and its only dynamic mask vocabulary', () => {
    expect(PARITY_LAYERS).toEqual(['pixels', 'text', 'accessibility', 'interaction'])
    expect(VIEWPORTS.map(({ width, height }: { width: number; height: number }) => [width, height])).toEqual([
      [1440, 1000],
      [390, 844],
    ])
    expect(THEMES).toEqual(['light', 'dark'])
    expect(STATE_MATRIX.map(({ id }: { id: string }) => id)).toEqual(
      expect.arrayContaining(['settings-model', 'approval-pending', 'admin-page', 'resources-page']),
    )
    expect(MATRIX_COMBINATIONS).toHaveLength(STATE_MATRIX.length * 4)
    expect(new Set(MATRIX_COMBINATIONS.map(({ id }: { id: string }) => id)).size).toBe(
      MATRIX_COMBINATIONS.length,
    )
    expect(new Set(DYNAMIC_MASK_SELECTORS).size).toBe(DYNAMIC_MASK_SELECTORS.length)
    expect(DYNAMIC_MASK_SELECTORS).toEqual(
      expect.arrayContaining(['#config-base-url', '.workspace-option-path', '.session-row']),
    )
  })
})
