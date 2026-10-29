import { describe, expect, it } from 'vitest'
import { ProvisionalComposer } from '../src/provisional-composer.js'
import { FakeTerminal } from '../src/terminal.js'

function open(interrupts: string[] = []) {
  const term = new FakeTerminal({ columns: 80, rows: 12 })
  const composer = new ProvisionalComposer(term, {
    locale: 'en',
    cwd: '/w',
    onInterrupt: () => interrupts.push('interrupt'),
  })
  composer.start()
  return { term, composer, screen: () => term.writes.join('') }
}

describe('ProvisionalComposer', () => {
  it('draws the composer with a connecting status and takes typing', async () => {
    const { term, composer, screen } = open()
    expect(screen()).toContain('Connecting…')
    term.feed('hello')
    await Promise.resolve()
    expect(composer.draft).toBe('hello')
    expect(screen()).toContain('hello')
  })

  it('keeps the draft on Enter and says it cannot be sent yet', async () => {
    const { term, composer, screen } = open()
    term.feed('hello')
    term.feed('\r')
    await Promise.resolve()
    expect(composer.draft).toBe('hello')
    expect(screen()).toContain('your draft is kept')
  })

  it('hands the draft over without leaving the alternate screen', () => {
    const { term, composer, screen } = open()
    term.feed('hello')
    expect(composer.release()).toBe('hello')
    expect(screen()).not.toContain('\x1b[?1049l')
    expect(term.raw).toBe(false)
    term.feed('x')
    expect(composer.draft).toBe('hello')
  })

  it('returns the draft with control characters removed when abandoned, and leaves the screen', () => {
    const { term, composer, screen } = open()
    term.feed('\x1b[200~keep\x1b[31m me\x1b[201~')
    const line = composer.abandon()
    expect(line).toMatch(/^Unsent draft: .*keep.*me/)
    expect(line).not.toContain('\x1b')
    expect(screen()).toContain('\x1b[?1049l')
  })

  it('has nothing to print when no draft was typed, and treats Ctrl-C as giving up', () => {
    const interrupts: string[] = []
    const { term, composer } = open(interrupts)
    term.feed('\x03')
    expect(interrupts).toEqual(['interrupt'])
    expect(composer.abandon()).toBeUndefined()
  })
})
