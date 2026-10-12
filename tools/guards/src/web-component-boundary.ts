export type ComponentRule = 'dom' | 'intrinsic' | 'className'
export type ComponentViolation = { rule: ComponentRule; offset: number; text: string }
const componentClass =
  /(?:^|[\s.])(?:agnes-ui-[\w-]+|agh-(?:btn|tag|menu|toast|drawer|dialog|field|icon|banner|list-row|empty-state|skeleton|sheet-handle|tooltip|count|meta)[\w-]*|primary-button|secondary-button|icon-button)(?=$|[\s.])/g

/** Strip comments while preserving quoted strings and offsets; selectors are reads, not class writes. */
export function webComponentViolations(source: string, file: string): ComponentViolation[] {
  const out: ComponentViolation[] = []
  const inUi = file.startsWith('packages/web-ui/src/ui/')
  const code = source.replace(
    /<!--[\s\S]*?-->|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (text) => (/^(?:\/\/|\/\*|<!--)/.test(text) ? text.replace(/[^\n]/g, ' ') : text),
  )
  const report = (rule: ComponentRule, pattern: RegExp) => {
    for (const match of code.matchAll(pattern)) out.push({ rule, offset: match.index, text: match[0] })
  }
  report(
    'dom',
    /\b(?:document|\w+\.ownerDocument)\s*\.\s*createElement(?:NS)?\s*\(|(?:\.|\[\s*['"])innerHTML(?:['"]\s*\])?\s*=/g,
  )
  if (!inUi) {
    report(
      'intrinsic',
      /<(?:button|input|select|textarea|table)\b|\bcreateElement\s*\(\s*['"](?:button|input|select|textarea|table)['"]/g,
    )
    for (const match of code.matchAll(
      /\b(?:className|class)\s*(?:=|:)\s*(?:\{[^\n]*|[^\n;]*['"`][^\n;]*)|\.classList\.(?:add|toggle|replace)\([^\n]*|\.setAttribute\(\s*['"]class['"][^\n]*/g,
    )) {
      for (const literal of match[0].matchAll(/["'`]([^"'`]*)["'`]/g)) {
        for (const name of (literal[1] ?? '').matchAll(componentClass))
          out.push({ rule: 'className', offset: match.index + literal.index, text: name[0].trim() })
      }
    }
  }
  return out
}
