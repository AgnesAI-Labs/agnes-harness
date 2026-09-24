import { HOOK_EVENTS, type HookSpec } from '../src/hooks.js'
import { SLOT_NAMES, type SlotSpec } from '../src/slots.js'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected metadata object')
  return value as Record<string, unknown>
}
function members(value: unknown, names: readonly string[]): Record<string, unknown> {
  const table = record(value)
  for (const key of Object.keys(table))
    if (!names.includes(key)) throw new Error(`unknown metadata member ${key}`)
  for (const key of names) if (!Object.hasOwn(table, key)) throw new Error(`missing metadata member ${key}`)
  return table
}
const one = (value: unknown, choices: readonly unknown[]) => choices.includes(value)
function render(source: string, kind: 'Hook' | 'Slot', rows: string[]): string {
  const lower = kind.toLowerCase(),
    name = kind.toUpperCase()
  return `// generated from packages/protocol/schema/${source} by tools/gen-tables.ts — do not edit\nimport type { ${kind}${kind === 'Hook' ? 'Event' : 'Name'}, ${kind}Spec } from '../${lower}s.js'\n\nexport const ${name}_TABLE = Object.freeze({\n${rows.join('\n')}\n} as const satisfies Record<${kind}${kind === 'Hook' ? 'Event' : 'Name'}, ${kind}Spec>)\n`
}
export function renderHookTable(input: unknown): string {
  const table = members(input, HOOK_EVENTS)
  return render(
    'hooks.json',
    'Hook',
    HOOK_EVENTS.map((name) => {
      const s = record(table[name])
      if (
        Object.keys(s).sort().join(',') !== 'category,failPolicy,mode,replayOnResume,timeoutMs' ||
        !one(s.category, ['observe', 'directive', 'transform']) ||
        !one(s.failPolicy, ['open', 'closed']) ||
        !Number.isSafeInteger(s.timeoutMs) ||
        (s.timeoutMs as number) <= 0 ||
        typeof s.replayOnResume !== 'boolean' ||
        !(s.category === 'observe'
          ? one(s.mode, ['emit', 'parallel'])
          : s.category === 'directive'
            ? s.mode === 'serial'
            : s.mode === 'waterfall')
      )
        throw new Error(`invalid hook metadata ${name}`)
      const spec = s as HookSpec
      return `  ${name}: Object.freeze(${JSON.stringify(spec)}),`
    }),
  )
}
export function renderSlotTable(input: unknown): string {
  const table = members(input, SLOT_NAMES)
  return render(
    'slots.json',
    'Slot',
    SLOT_NAMES.map((name) => {
      const s = record(table[name])
      if (
        !one(s.cardinality, ['single', 'multi']) ||
        !Number.isSafeInteger(s.order) ||
        !one(s.failPolicy, ['open', 'closed']) ||
        !Array.isArray(s.surfaces) ||
        s.surfaces.length === 0 ||
        new Set(s.surfaces).size !== s.surfaces.length ||
        !s.surfaces.every((x) => one(x, ['tui', 'web', 'channel']))
      )
        throw new Error(`invalid slot metadata ${name}`)
      const spec = s as SlotSpec
      return `  ${JSON.stringify(name)}: Object.freeze({ cardinality: ${JSON.stringify(spec.cardinality)}, order: ${spec.order}, surfaces: Object.freeze(${JSON.stringify(spec.surfaces)} as const), failPolicy: ${JSON.stringify(spec.failPolicy)} }),`
    }),
  )
}
/**
 * Read the semantic token names a skin may override out of the Web client's stylesheet.
 * `packages/web/public/style.css` is the colour authority and declares three top-level `:root`
 * blocks in order: the raw colour scale, the semantic layer, then the scale layer. Only the second
 * one is a skin's vocabulary, so a rename there is what renames the whitelist.
 * @param css - Full contents of the Web client stylesheet.
 * @returns Token names in declaration order, deduplicated.
 */
export function extractThemeTokenNames(css: string): string[] {
  const blocks = [...css.matchAll(/:root\s*\{/g)]
  const open = blocks[1]
  if (open?.index === undefined) throw new Error('style.css is missing its semantic :root block')
  const start = open.index + open[0].length
  let depth = 1
  let i = start
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') depth -= 1
    i += 1
  }
  if (depth !== 0) throw new Error('style.css semantic :root block is unterminated')
  const names: string[] = []
  for (const match of css.slice(start, i - 1).matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
    const name = match[1]
    // The raw colour scale is the skin author's palette source, not their vocabulary.
    if (name !== undefined && !name.startsWith('--agnes-color-')) names.push(name)
  }
  const unique = [...new Set(names)]
  if (unique.length === 0) throw new Error('style.css semantic :root block declares no tokens')
  return unique
}
/**
 * Render the generated theme-token whitelist module.
 * @param names - Semantic token names in declaration order.
 * @returns TypeScript source for `src/generated/theme-tokens.ts`.
 */
export function renderThemeTokenTable(names: readonly string[]): string {
  if (names.length === 0) throw new Error('expected at least one theme token')
  for (const name of names)
    if (!/^--[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`invalid theme token name ${name}`)
  if (new Set(names).size !== names.length) throw new Error('duplicate theme token name')
  return `// generated from packages/web/public/style.css by tools/gen-tables.ts — do not edit
export const THEME_TOKEN_NAMES = Object.freeze([
${names.map((n) => `  ${JSON.stringify(n)},`).join('\n')}
] as const)
export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number]

/** Membership test for \`checkManifest\`; the array above is its only source. */
export const THEME_TOKENS: ReadonlySet<string> = new Set<string>(THEME_TOKEN_NAMES)
`
}
