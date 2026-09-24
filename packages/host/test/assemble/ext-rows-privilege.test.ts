import { describe, expect, it } from 'vitest'
import {
  EXT_ROW_EXTENSION_IDS,
  EXTENSION_ROW_GRANTS,
  extensionRowGrantFor,
} from '../../src/assemble/ext-rows.js'

describe('ext: row privilege grants', () => {
  it('is keyed on the builtin ROW id, not on a package name', () => {
    expect([...EXTENSION_ROW_GRANTS.keys()]).toEqual(['ext:agnes/computer-use'])
    expect(EXTENSION_ROW_GRANTS.get('ext:agnes/computer-use')).toEqual({ computerUse: true })
    // A package name must not be a key: that is exactly the condition this replaces.
    expect(EXTENSION_ROW_GRANTS.get('@agnes/base')).toBeUndefined()
  })

  it('grants nothing to any other row-backed extension', () => {
    for (const id of EXT_ROW_EXTENSION_IDS)
      if (id !== 'agnes/computer-use') expect(EXTENSION_ROW_GRANTS.get(`ext:${id}`)).toBeUndefined()
  })

  it('is refused to any owner other than the builtin package', () => {
    // buildEcosystemContext runs for EVERY extension the factory selector loads, not only for ext:
    // rows, and nothing reserves the `agnes/` id scope at runtime. A trusted third-party package
    // whose root manifest id is `agnes/computer-use` reaches that same code path (assemble.ts's
    // `specs` loop), so the row-id table alone would hand it computerUseBackendProvider.
    expect(extensionRowGrantFor('@agnes/base', 'agnes/computer-use')).toEqual({ computerUse: true })
    expect(extensionRowGrantFor('@acme/package', 'agnes/computer-use')).toBeUndefined()
    expect(extensionRowGrantFor('@agnes/code', 'agnes/computer-use')).toBeUndefined()
  })

  it('grants nothing for any other extension id, whoever owns it', () => {
    expect(extensionRowGrantFor('@agnes/base', 'agnes/tools-core')).toBeUndefined()
    expect(extensionRowGrantFor('@acme/package', 'agnes/tools-core')).toBeUndefined()
  })
})
