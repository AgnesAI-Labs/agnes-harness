/** Fingerprinted legacy ratchet: adding the same literal again is a new violation too. */
export type PresentationFinding = {
  rule: 'internal-button-class' | 'hex-color'
  literal: string
  offset: number
}
export function presentationFindings(source: string): PresentationFinding[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (text) => ' '.repeat(text.length))
    .replace(/^[ \t]*\/\/.*$/gm, (text) => ' '.repeat(text.length))
    .replace(/<!--[\s\S]*?-->/g, (text) => ' '.repeat(text.length))
  return [
    ...[...code.matchAll(/\b(?:primary-button|secondary-button|icon-button)\b/g)].map(
      (match): PresentationFinding => ({
        rule: 'internal-button-class',
        literal: match[0],
        offset: match.index,
      }),
    ),
    ...[...code.matchAll(/#[a-f\d]{3,8}\b/gi)].map(
      (match): PresentationFinding => ({
        rule: 'hex-color',
        literal: match[0].toLowerCase(),
        offset: match.index,
      }),
    ),
  ].sort((a, b) => a.offset - b.offset)
}
export function presentationCounts(source: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const finding of presentationFindings(source)) {
    const key = `${finding.rule}:${finding.literal}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}
export function newPresentationViolations(
  current: Record<string, number>,
  allowed: Record<string, number>,
): string[] {
  return Object.entries(current)
    .filter(([key, count]) => count > (allowed[key] ?? 0))
    .map(([key, count]) => `${key}: ${count} > ${allowed[key] ?? 0}`)
    .sort()
}
