/** @vitest-environment happy-dom */

import { homeEntries } from '@agnes/web-client'
import { afterEach, describe, expect, it } from 'vitest'
import { registerBuiltinHomeEntries } from '../src/pages/entries.js'
import { enT, zhT } from './helpers/locale.js'

describe('home entry names', () => {
  let dispose: (() => void) | undefined
  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('names the FDE entry and its page "Agent FDE" in both languages', () => {
    for (const t of [enT, zhT]) {
      expect(t('home.entry.agents')).toBe('Agent')
      expect(t('home.entry.agents.sub')).toBe('FDE')
    }
    dispose = registerBuiltinHomeEntries()
    const agents = homeEntries.get('agents')
    // The sidebar entry and the page title read the same two keys: the name, then FDE in the quiet note.
    expect(agents?.titleKey).toBe('home.entry.agents')
    expect(agents?.subtitleKey).toBe('home.entry.agents.sub')
  })
})
