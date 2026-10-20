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

/** The shell's published text format; incomplete/timeout output stays untouched and has no exit badge. */
export function shellTranscript(text: string | undefined): {
  stdout: string
  stderr?: string
  exit?: number
  truncated?: boolean
} {
  const raw = text ?? ''
  const end = /\n?\[exit (-?\d+)\]( \[output truncated by sandbox\])?\s*$/.exec(raw)
  const body = end ? raw.slice(0, end.index).trimEnd() : raw
  const split = body.indexOf('[stderr]\n')
  return {
    stdout: (split < 0 ? body : body.slice(0, split)).trimEnd(),
    ...(split < 0 ? {} : { stderr: body.slice(split + '[stderr]\n'.length).trimEnd() }),
    ...(end ? { exit: Number(end[1]), ...(end[2] ? { truncated: true } : {}) } : {}),
  }
}
