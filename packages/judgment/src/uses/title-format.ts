/** Units kept from the start of a stored text. */
export const TITLE_HEAD = 1334
/** Units kept from the end of a stored text. */
export const TITLE_TAIL = 667

/** A text reduced to its first and last units plus its real length. */
export type TitleSection = { head: string; tail: string; length: number }

export const section = (text: string): TitleSection => ({
  head: text.slice(0, TITLE_HEAD),
  tail: text.slice(-TITLE_TAIL),
  length: text.length,
})

export type TitleTurn = {
  seq: number
  role: 'user' | 'assistant'
  text: TitleSection
  thinking: TitleSection
}

/** Longest document returned unabridged. */
const LIMIT = 2000

/** A fixed piece of markup, or a stored text known only by its ends. */
type Piece = string | TitleSection

const notice = (omitted: number): string => `\n[… ${omitted} chars omitted …]\n`

/** The first `want` units of the document, never touching the middle of a stored text. */
function readFront(pieces: Piece[], want: number): string {
  let out = ''
  for (const piece of pieces) {
    const take = Math.min(want - out.length, piece.length)
    if (typeof piece === 'string') out += piece.slice(0, take)
    else if (take <= piece.head.length) out += piece.head.slice(0, take)
    else {
      const { head, tail, length } = piece
      out += head + tail.slice(tail.length - (length - head.length), tail.length - (length - take))
    }
    if (out.length >= want) break
  }
  return out
}

/** The last `want` units of the document, never touching the middle of a stored text. */
function readBack(pieces: Piece[], want: number): string {
  let out = ''
  for (let i = pieces.length - 1; i >= 0; i--) {
    const piece = pieces[i] as Piece
    const take = Math.min(want - out.length, piece.length)
    const source = typeof piece === 'string' ? piece : piece.tail
    out = (take ? source.slice(-take) : '') + out
    if (out.length >= want) break
  }
  return out
}

/** Render turns as a chat transcript, abridged to LIMIT units with a count of what was left out. */
export function formatTitleContext(turns: TitleTurn[]): string {
  const pieces: Piece[] = []
  for (const turn of turns) {
    const { role, text, thinking } = turn
    if (text.length === 0 && thinking.length === 0) continue
    pieces.push(pieces.length === 0 ? '<chat>\n' : '\n\n', `<${role}>\n`)
    if (text.length > 0) pieces.push(text)
    if (thinking.length > 0) {
      if (text.length > 0) pieces.push('\n\n')
      pieces.push('<think>\n', thinking, '\n</think>')
    }
    pieces.push(`\n</${role}>`)
  }
  if (pieces.length === 0) return ''
  pieces.push('\n</chat>')

  let total = 0
  for (const piece of pieces) total += piece.length
  if (total <= LIMIT) return readFront(pieces, total)

  // The notice's own width depends on the count it prints, so size it twice.
  let omitted = total - LIMIT
  let front = 0
  let back = 0
  for (let pass = 0; pass < 2; pass++) {
    const room = Math.max(0, LIMIT - notice(omitted).length)
    front = Math.ceil((room * 2) / 3)
    back = room - front
    omitted = total - front - back
  }
  return readFront(pieces, front) + notice(omitted) + readBack(pieces, back)
}
