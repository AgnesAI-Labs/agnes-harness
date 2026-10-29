import type { ReactNode } from 'react'

const TOKENS =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\/[^\n]*|#[^\n]*|\b(?:const|let|var|function|return|import|export|from|class|if|else|true|false|null|def|for|while|async|await)\b|\b\d+(?:\.\d+)?\b)/g

function tokens(line: string): ReactNode[] {
  let offset = 0
  return line.split(TOKENS).map((token) => {
    const position = offset
    offset += token.length
    const tone = /^(?:\/\/|#)/.test(token)
      ? 'comment'
      : /^["']/.test(token)
        ? 'string'
        : /^\d/.test(token)
          ? 'number'
          : /^\w+$/.test(token)
            ? 'keyword'
            : undefined
    return tone ? (
      <span key={position} className={`workbench-code-${tone}`}>
        {token}
      </span>
    ) : (
      token
    )
  })
}

/**
 * A bounded lexical preview, one block per line so the gutter can number it. Text is rendered by
 * React, never interpreted as HTML. Tokens never cross a line: a string that spans lines is plain.
 */
export function Highlight({ path, text }: { path: string; text: string }) {
  const supported = /\.(?:[cm]?[jt]sx?|json|css|html?|py|sh|md|ya?ml)$/i.test(path) && text.length <= 65536
  const lines = text.split('\n')
  return (
    <code>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's number is its identity in an immutable read.
        <span key={index} className="workbench-code-line">
          <span className="workbench-code-text">
            {supported ? tokens(line) : line}
            {index < lines.length - 1 ? '\n' : ''}
          </span>
        </span>
      ))}
    </code>
  )
}
