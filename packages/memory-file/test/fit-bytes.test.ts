import { describe, expect, it } from 'vitest'
import { fitBytes } from '../src/content.js'
import { omissionLine } from '../src/paragraphs.js'

const notice = ({ paragraphs, kb }: { paragraphs: number; kb: string }) =>
  `[${paragraphs} more ${paragraphs === 1 ? 'paragraph' : 'paragraphs'} (about ${kb} KB) not shown.]`

describe('fitBytes', () => {
  it('does not count an omission line as a paragraph left out', () => {
    const content = `kept line\n\n${'x'.repeat(200)}\n\n${omissionLine(2)}\n`
    const fit = fitBytes(content, 120, notice)
    expect(fit.omitted).toBe(true)
    expect(fit.content).toContain('[1 more paragraph (about')
  })

  it('fits a large file in time that grows with its size, not its square', () => {
    const lines = Array.from({ length: 200_000 }, (_, i) => `- line ${i}`).join('\n')
    const started = performance.now()
    const fit = fitBytes(lines, 1_000_000, notice)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(Buffer.byteLength(fit.content)).toBeLessThanOrEqual(1_000_000)
    expect(fit.content).toMatch(/- line \d+\n\[\d+ more paragraphs? \(about [\d.]+ KB\) not shown\.\]$/u)
  })
})
