/** Source-level presentation fences. Catalog data, IDs and diagnostic errors are not copy. */
export type FrontendViolation = { rule: 'copy' | 'layout' | 'settings'; offset: number; text: string }
const readable = (value: string) => /[\p{L}]/u.test(value) && !/^https?:|^secret:\/\/|^\.[/]/.test(value)
export function frontendUiViolations(source: string, file: string): FrontendViolation[] {
  const results: FrontendViolation[] = []
  // Preserve string contents; strip only comments at line starts and JSX comment containers.
  const code = source
    .replace(/^[ \t]*\/\/.*$/gm, (v) => ' '.repeat(v.length))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (v) => ' '.repeat(v.length))
  const boundMarkup = (offset: number, match: string) => {
    const opening = code.lastIndexOf('<', offset + (match.startsWith('<') ? 1 : 0))
    const closing = code.indexOf('>', opening)
    if (opening < 0 || closing < 0 || closing < offset) return false
    const tag = code.slice(opening, closing + 1)
    if (match.startsWith('<')) return /\bdata-i18n=/.test(tag)
    if (/^(aria-label|title|placeholder)/.test(match))
      return new RegExp(
        `data-i18n-(?:${match.startsWith('aria-label') ? 'aria' : (match.split('=')[0] ?? '').trim()})=`,
      ).test(tag)
    return false
  }
  const report = (rule: FrontendViolation['rule'], pattern: RegExp, part: number) => {
    for (const match of code.matchAll(pattern))
      if (
        match[part] &&
        readable(match[part]) &&
        !match[part].includes('${') &&
        !boundMarkup(match.index, match[0])
      )
        results.push({ rule, offset: match.index, text: match[part].trim() })
  }
  report(
    'copy',
    /(?<![\w-])(?:aria-label|placeholder|title|label|hint|description|emptyText)\s*=\s*["']([^"']+)["']/g,
    1,
  )
  report(
    'copy',
    /(?<![\w-])(?:aria-label|placeholder|title|label|hint|description|emptyText)\s*=\s*\{\s*['"]([^'"\n]+)['"]\s*\}/g,
    1,
  )
  if (!/\/locales?\//.test(file) && !/-locale\.ts$/.test(file))
    report('copy', /\b(?:label|title|placeholder|emptyText|hint|ariaLabel)\s*:\s*['"]([^'"\n]+)['"]/g, 1)
  report('copy', /<[\w.-]+(?:\s[^<>]*?)?>\s*([^{}<>\n]*[\p{L}][^{}<>\n]*)\s*<\//gu, 1)
  report('copy', /(?:textContent|innerText)\s*=\s*['"]([^'"\n]+)['"]/g, 1)
  report('copy', /\.setAttribute\(\s*['"](?:aria-label|title|placeholder)['"]\s*,\s*['"]([^'"\n]+)['"]/g, 1)
  report('copy', /\b(?:alert|confirm|prompt)\(\s*['"]([^'"\n]+)['"]/g, 1)
  report('copy', />\s*\{\s*['"]([^'"\n]+)['"]\s*\}/g, 1)
  if (/packages\/web(?:-foundation|-admin|-conversation)?\/src\//.test(file)) {
    for (const match of code.matchAll(
      /\.setAttribute\(\s*['"]style['"]|\bstyle\s*=\s*\{|\.style\.(?:display|gap|padding|margin|gridTemplateColumns|alignItems|justifyContent)\s*=/g,
    ))
      results.push({ rule: 'layout', offset: match.index, text: match[0] })
    // Built-in runtime pages can be imported for helpers, but rendered only by the registry.
    if (!file.endsWith('/settings/registry.tsx')) {
      const names =
        'SearchPanel|ChildEnginesPanel|ContextPanel|ExamplesPanel|HistorySearchPanel|SchedulesPage|SecurityPanel|JobsPanel|SessionDefaultsPanel|BundlesPanel|PresetsPanel|PublicationPanel|GenerationsPanel|LocalPluginsPanel'
      const aliases = [...code.matchAll(new RegExp(`(?:${names})\\s+as\\s+(\\w+)`, 'g'))].map(
        (match) => match[1],
      )
      const roots = [names, ...aliases].join('|')
      for (const match of code.matchAll(new RegExp(`(?:<|createElement\\(\\s*)(?:${roots})\\b`, 'g')))
        results.push({ rule: 'settings', offset: match.index, text: match[0] })
    }
  }
  return results
}
