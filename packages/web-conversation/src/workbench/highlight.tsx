/** A bounded lexical preview. Text is rendered by React, never interpreted as HTML. */
export function Highlight({ path, text }: { path: string; text: string }) {
  const supported = /\.(?:[cm]?[jt]sx?|json|css|html?|py|sh|md|ya?ml)$/i.test(path)
  if (!supported || text.length > 65536) return <code>{text}</code>
  const tokens = text.split(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|#[^\n]*|\b(?:const|let|var|function|return|import|export|from|class|if|else|true|false|null|def|for|while|async|await)\b|\b\d+(?:\.\d+)?\b)/g,
  )
  let offset = 0
  return (
    <code>
      {tokens.map((token) => {
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
      })}
    </code>
  )
}
