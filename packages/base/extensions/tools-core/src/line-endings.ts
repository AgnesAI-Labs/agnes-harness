// Models write `\n` whatever the platform. Two kinds of file need more than that: a batch file,
// which cmd.exe misparses with bare LF line breaks (a parenthesized block fails with ". was
// unexpected at this time." and the window closes before anyone reads it), and a file that is CRLF
// throughout, whose line breaks an overwrite or an edit must not quietly change.

/** True when the text has a line break and every line break in it is CRLF. */
export function usesCrlf(text: string): boolean {
  let any = false
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (text[i - 1] !== '\r') return false
    any = true
  }
  return any
}

/** Every bare LF becomes CRLF; a CRLF already there is left as it is. */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

/** A file cmd.exe runs, which it only parses reliably with CRLF line breaks. */
export function isBatchFile(path: string): boolean {
  return /\.(bat|cmd)$/i.test(path)
}
