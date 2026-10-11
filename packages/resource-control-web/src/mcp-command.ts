/** Parse command tokens without invoking a shell; quoted whitespace is preserved. */
export function parseMcpCommand(command: string): string[] {
  const tokens: string[] = []
  let token = '',
    quote = '',
    started = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (char === '\\' && ['\\', '"', "'", ' '].includes(command[index + 1] ?? '') && quote !== "'") {
      token += command[++index]
      started = true
    } else if (quote) {
      if (char === quote) quote = ''
      else token += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        tokens.push(token)
        token = ''
        started = false
      }
    } else {
      token += char
      started = true
    }
  }
  if (quote) throw new Error('Unclosed quote')
  if (started) tokens.push(token)
  return tokens
}
export function formatMcpCommand(tokens: string[]): string {
  return tokens
    .map((token) => (!token || /[\s"'\\]/.test(token) ? '"' + token.replace(/["\\]/g, '\\$&') + '"' : token))
    .join(' ')
}
