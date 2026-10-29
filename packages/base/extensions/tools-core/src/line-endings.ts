/** Mixed files keep their exact spelling; only a consistently CRLF file selects CRLF. */
export function usesCrlf(text: string): boolean {
  return text.includes('\r\n') && !/(?<!\r)\n/.test(text)
}

export function crlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

export function writeContent(path: string, content: string, previous: string): string {
  const text = /\.(bat|cmd)$/i.test(path) || usesCrlf(previous) ? crlf(content) : content
  return previous.startsWith('\uFEFF') && !text.startsWith('\uFEFF') ? `\uFEFF${text}` : text
}
