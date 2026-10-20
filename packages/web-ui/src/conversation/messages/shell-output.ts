/** Separate only recognized sandbox diagnostics in successful, complete shell output. */
export function shellOutput(text: string | undefined): { text: string | undefined; environment?: string } {
  if (!text || !/\[exit 0\]\s*$/.test(text)) return { text }
  const marker = text.indexOf('[stderr]\n')
  if (marker < 0) return { text }
  const before = text.slice(0, marker)
  const stderr = text.slice(marker + '[stderr]\n'.length).replace(/\n?\[exit 0\]\s*$/, '')
  const environment: string[] = []
  const errors: string[] = []
  for (const line of stderr.split('\n')) {
    // Match diagnostic signatures, not merely a variable or filename mentioned in real errors.
    if (
      /(?:xcrun|python3|git): (?:error|warning): (?:couldn't|unable to) (?:create|write).*xcrun_db/i.test(
        line,
      ) ||
      /(?:confstr\(\).*failed.*DARWIN_USER_TEMP_DIR|(?:confstr\(\)|getconf).*DARWIN_USER_TEMP_DIR.*(?:failed|error|using \/tmp))/i.test(
        line,
      )
    )
      environment.push(line)
    else errors.push(line)
  }
  if (!environment.length) return { text }
  const remaining = errors.join('\n').trim()
  return {
    text: `${before}${remaining ? `[stderr]\n${remaining}\n` : ''}[exit 0]`,
    environment: environment.join('\n'),
  }
}
