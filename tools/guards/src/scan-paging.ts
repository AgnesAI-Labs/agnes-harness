import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { createScanner } from 'typescript/unstable/ast/scanner'
import { DEFAULT_EXCLUDE_DIRS, isTestFile, listSourceFiles } from './repo.js'

/** The most rows one adapter scan returns; a literal limit above it is silently cut. */
export const PAGE_MAX = 500

type Token = { kind: number; text: string; start: number }

const kindOf = (text: string): number => createScanner(true, 0, text).scan()
const K = {
  eof: kindOf(''),
  ident: kindOf('scan'),
  templateHead: kindOf('`a${'),
  slash: kindOf('/'),
  slashEquals: kindOf('/='),
  closeParen: kindOf(')'),
  closeBracket: kindOf(']'),
  closeBrace: kindOf('}'),
  openBrace: kindOf('{'),
  number: kindOf('1'),
  string: kindOf("'s'"),
  template: kindOf('`s`'),
}

/**
 * Tokens with comments, strings, templates and regular expressions recognised as such, so text that
 * merely looks like a scan call inside one of them is never reported.
 */
export function tokenize(text: string): Token[] {
  const scanner = createScanner(true, 0, text)
  const out: Token[] = []
  // Brace depth at each open template expression; its closing brace resumes the template.
  const templates: number[] = []
  let depth = 0
  let prev: Token | undefined
  const push = (kind: number): void => {
    prev = { kind, text: scanner.getTokenText(), start: scanner.getTokenStart() }
    out.push(prev)
  }
  for (;;) {
    let kind = scanner.scan()
    if (kind === K.eof) return out
    if (kind === K.slash || kind === K.slashEquals) {
      const endsExpression =
        prev !== undefined &&
        [K.ident, K.closeParen, K.closeBracket, K.closeBrace, K.number, K.string, K.template].includes(
          prev.kind,
        )
      if (!endsExpression) kind = scanner.reScanSlashToken()
    }
    if (kind === K.templateHead) {
      templates.push(depth)
      push(kind)
      continue
    }
    if (kind === K.openBrace) depth++
    if (kind === K.closeBrace) {
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        kind = scanner.reScanTemplateToken(false)
        if (scanner.getTokenText().endsWith('`')) templates.pop()
        push(kind)
        continue
      }
      depth--
    }
    push(kind)
  }
}

export type ScanObject = { props: Map<string, string>; spread: boolean }
export type ScanCall = { line: number; call: string; objects: ScanObject[] }

const OPEN = new Set(['(', '[', '{'])
const CLOSE = new Set([')', ']', '}'])
const squash = (s: string): string => s.replace(/\s+/g, '')

/** One top-level object literal argument, starting at its `{`; returns it and the index of its `}`. */
function objectAt(text: string, ts: Token[], open: number): [ScanObject, number] {
  const props = new Map<string, string>()
  let spread = false
  let i = open + 1
  let atKey = true
  while (i < ts.length) {
    const t = ts[i] as Token
    if (t.text === '}') return [{ props, spread }, i]
    if (atKey && t.text === '...') {
      spread = true
      atKey = false
    } else if (atKey && ts[i + 1]?.text === ':') {
      let j = i + 2
      let nest = 0
      const from = (ts[j] as Token).start
      let to = from
      while (j < ts.length) {
        const v = (ts[j] as Token).text
        if (nest === 0 && (v === ',' || v === '}')) break
        if (OPEN.has(v)) nest++
        if (CLOSE.has(v)) nest--
        to = (ts[j] as Token).start + v.length
        j++
      }
      props.set(t.text, squash(text.slice(from, to)))
      i = j
      atKey = false
      continue
    } else if (atKey) {
      props.set(t.text, t.text)
      atKey = false
    } else if (OPEN.has(t.text)) {
      let nest = 1
      while (nest > 0 && ++i < ts.length) {
        const v = (ts[i] as Token).text
        if (OPEN.has(v)) nest++
        if (CLOSE.has(v)) nest--
      }
    }
    if ((ts[i] as Token | undefined)?.text === ',') atKey = true
    i++
  }
  return [{ props, spread }, i]
}

/** Every `.scan(` / `?.scan(` call in a source text, with its top-level object literal arguments. */
export function scanCalls(text: string): ScanCall[] {
  const ts = tokenize(text)
  const calls: ScanCall[] = []
  for (let i = 0; i + 2 < ts.length; i++) {
    const [dot, name, paren] = [ts[i], ts[i + 1], ts[i + 2]] as [Token, Token, Token]
    if ((dot.text !== '.' && dot.text !== '?.') || name.text !== 'scan' || paren.text !== '(') continue
    const objects: ScanObject[] = []
    let j = i + 3
    let nest = 1
    for (; j < ts.length; j++) {
      const t = (ts[j] as Token).text
      if (t === '{' && nest === 1 && ['(', ','].includes((ts[j - 1] as Token).text)) {
        const [object, end] = objectAt(text, ts, j)
        objects.push(object)
        j = end
        continue
      }
      if (OPEN.has(t)) nest++
      if (CLOSE.has(t) && --nest === 0) break
    }
    const end = j < ts.length ? (ts[j] as Token).start + 1 : text.length
    calls.push({
      line: text.slice(0, dot.start).split('\n').length,
      call: text.slice(name.start, end).replace(/\s+/g, ' '),
      objects,
    })
  }
  return calls
}

export type ScanFinding = { file: string; line: number; call: string; rule: 'limit-over-page' | 'unbounded' }

/** A query that cannot silently lose rows: a limit the adapter honours, or one exact seq. */
export function findings(text: string, file: string): ScanFinding[] {
  const out: ScanFinding[] = []
  for (const c of scanCalls(text))
    for (const o of c.objects) {
      const limit = o.props.get('limit')
      if (limit !== undefined) {
        if (/^[0-9_]+$/.test(limit) && Number(limit.replace(/_/g, '')) > PAGE_MAX)
          out.push({ file, line: c.line, call: c.call, rule: 'limit-over-page' })
        continue
      }
      const from = o.props.get('fromSeq')
      const pointRead = !o.spread && from !== undefined && from === o.props.get('toSeq')
      if (!pointRead) out.push({ file, line: c.line, call: c.call, rule: 'unbounded' })
    }
  return out
}

/** Package source and testkits: the code other packages run, which a test tree is not. */
const repositoryPath = (root: string, file: string): string => relative(root, file).split(sep).join('/')

export function scannedFiles(root: string): string[] {
  const exclude = [...DEFAULT_EXCLUDE_DIRS, 'fixtures', 'test']
  return listSourceFiles(join(root, 'packages'), { excludeDirs: exclude })
    .filter((f) => !isTestFile(f) && !f.endsWith('.d.ts'))
    .filter((f) => /^packages\/(.+\/)?(src|testkit)\//.test(repositoryPath(root, f)))
}

export function scanRepo(root: string): { calls: number; findings: ScanFinding[] } {
  let calls = 0
  const out: ScanFinding[] = []
  for (const file of scannedFiles(root)) {
    const text = readFileSync(file, 'utf8')
    calls += scanCalls(text).length
    out.push(...findings(text, repositoryPath(root, file)))
  }
  return { calls, findings: out }
}
