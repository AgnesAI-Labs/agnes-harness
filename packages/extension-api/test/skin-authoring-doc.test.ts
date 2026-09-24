import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { THEME_TOKEN_NAMES } from '../src/index.js'

const repoRoot = new URL('../../..', import.meta.url)

/**
 * The authoring guide is only useful while it matches the code, and a guide that silently drifts is
 * worse than none. These cases tie its two structural lists to their real sources: the token list to
 * the generated whitelist, and the region list to the hooks actually present in the three pages.
 * Prose cannot be checked, so only the lists that carry a contract are.
 */
describe.each(['docs/develop/skins.md', 'docs/develop/skins.zh-CN.md'])(
  '%s matches the contract',
  (docPath) => {
    const doc = readFileSync(new URL(docPath, repoRoot), 'utf8')
    it('lists exactly the generated semantic tokens, in order', () => {
      const marked = /<!-- theme-tokens:begin -->\n([\s\S]*?)<!-- theme-tokens:end -->/.exec(doc)
      expect(marked, 'the guide must keep its theme-tokens markers').not.toBeNull()
      const listed = (marked?.[1] ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      expect(listed).toEqual([...THEME_TOKEN_NAMES])
      expect(listed.length).toBeGreaterThan(40)
    })

    // The region-table case lives in packages/web/test/skin-regions.test.ts, next to the EXPECTED
    // contract table it compares against. Several workbench regions (composer, transcript, ...) are
    // rendered by components at runtime, so the static HTML no longer declares them; sampling the
    // markup from this lower-layer package would under-report the contract the skin author can use.

    it('names the asset limits and the CSP refusal a skin author must design around', () => {
      // These are the facts an author gets wrong first, so the guide must state them rather than
      // merely linking out: the byte caps, the extension allowlist, and that url()/data: are refused.
      for (const fact of ['2 MB', '8 MB', '128 KB', 'data:', "default-src 'self'"])
        expect(doc, `the guide must state ${fact}`).toContain(fact)
      for (const extension of ['webp', 'png', 'jpg', 'jpeg', 'avif', 'woff2', 'woff'])
        expect(doc, `the guide must list .${extension}`).toContain(`.${extension}`)
    })

    it('documents the escape hatch and the three covered pages', () => {
      expect(doc).toContain('?skin=none')
      for (const route of ['`/`', '`/admin/plugins`', '`/admin/resources`']) expect(doc).toContain(route)
    })

    it('points at a checked-in example that really satisfies the contract', () => {
      // The guide names one runnable example. If that path moves or the example stops demonstrating
      // the contract, the guide is pointing at nothing useful — so the path itself is checked.
      const relative = /\]\(((?:\.\.\/)+examples\/packages\/skin-example\/[^)]+)\)/.exec(doc)?.[1]
      expect(relative, 'the guide must link the runnable example').toBeDefined()
      // A directory base needs its trailing slash, or the last segment is replaced.
      const target = new URL(`${relative as string}/`, new URL(docPath, repoRoot))
      const pkg = JSON.parse(readFileSync(new URL('package.json', target), 'utf8'))
      expect(pkg.agnes.clientDescriptors[0].rowId).toBe(pkg.agnes.plugins[0].id)
      const manifest = JSON.parse(readFileSync(new URL(pkg.agnes.clientDescriptors[0].path, target), 'utf8'))
      expect(manifest.skins).toHaveLength(1)
      const css = readFileSync(new URL(`extensions/main/${manifest.skins[0].css.slice(2)}`, target), 'utf8')
      expect(css).toContain('data-agnes-region')
      expect(css).toContain('.dark ')
    })
  },
)
