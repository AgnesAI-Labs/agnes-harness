export type ComponentRule = 'dom' | 'intrinsic' | 'className'
export type ComponentViolation = { rule: ComponentRule; offset: number; text: string }
const componentClass =
  /(?:^|\s)(?:agnes-ui-[\w-]+|agh-(?:btn|tag|menu|toast|drawer|dialog|field|icon|banner|list-row|empty-state|skeleton|sheet-handle|tooltip|count|meta|table|chart|data-list)[\w-]*|primary-button|secondary-button|icon-button)(?=$|\s)/g

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
    /\b(?!(?:React|react)\b)\w+(?:\.\w+)*\s*\.\s*createElement(?:NS)?\s*\(|(?:\.|\[\s*['"])innerHTML(?:['"]\s*\])?\s*=/g,
  )
  if (!inUi) {
    report(
      'intrinsic',
      /<(?:button|input|select|textarea|table)\b|\bcreateElement\s*\(\s*['"](?:button|input|select|textarea|table)['"]/g,
    )
    // Literal class tokens also catch multiline arrays, ternaries and class-name constants.
    // Selectors retain their leading dot and therefore do not match a class token.
    for (const literal of code.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g)) {
      // IDs and protocol message types can share a namespace with classes without being class writes.
      if (
        /(?:<[\w.-]+\b[^<>]*\b(?:id|type)\s*=|\b(?:id|type)\s*:|\.\s*(?:id|type)\s*(?:===|!==|==|!=|=))\s*$/.test(
          code.slice(0, literal.index),
        )
      )
        continue
      for (const name of literal[0].slice(1, -1).matchAll(componentClass))
        out.push({ rule: 'className', offset: literal.index, text: name[0].trim() })
    }
  }
  return out
}
