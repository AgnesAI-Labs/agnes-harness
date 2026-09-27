import {
  AssistantRuntimeProvider,
  ConversationMarkdown,
  createConversationProjectionStore,
  useConversationRuntime,
} from '@agnes/web-ui/assistant-ui'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

const root = createRoot(document.getElementById('probe-root'))
const store = createConversationProjectionStore({ sessionId: 'w5a-browser', nodes: [] })
const safety =
  '<script>window.pwned = true</script>\n\nFish &amp; Chips\n\n[good](https://example.test/docs) [bad](java&#x73;cript:alert(1))\n\n![diagram alt](/brand-mark.png) \\<img src="https://example.test/literal.png">\n\n未闭合 \\<img src="https://example.test/unclosed.png"\n\n```ts\nshown code\n```'
const structure =
  '# 标题\n\n正文 **重点**、*强调* 和 `inline()`\n\n- 第一项\n  - 子项\n\n> 引用\n\n| 名称 | 数值 |\n| :--- | ---: |\n| Agnes | 1 |\n\n[文档][ref]\n\n[ref]: https://example.test/docs'
let copied = ''
const violations = []
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push(`${event.effectiveDirective}:${event.blockedURI}`)
  snapshot()
})

function HookProbe() {
  const runtime = useConversationRuntime(store)
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <span id="hook-result">hook-ok</span>
    </AssistantRuntimeProvider>
  )
}

function App() {
  const [source, setSource] = useState(structure)
  const [part, setPart] = useState('body')
  const [theme, setTheme] = useState('light')
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])
  return (
    <>
      <nav>
        <button
          type="button"
          onClick={() => {
            setSource(structure)
            setPart('body')
          }}
        >
          结构
        </button>
        <button
          type="button"
          onClick={() => {
            setSource(safety)
            setPart('body')
          }}
        >
          安全
        </button>
        <button
          type="button"
          onClick={() => {
            setSource('思考 **文本**')
            setPart('thinking')
          }}
        >
          思考
        </button>
        <button type="button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
          切换主题
        </button>
      </nav>
      <HookProbe />
      <section id="markdown-host">
        <ConversationMarkdown
          source={source}
          part={part}
          theme={theme}
          onCopy={async (value) => {
            copied = value
            snapshot()
          }}
        />
      </section>
    </>
  )
}

function snapshot() {
  const host = document.getElementById('markdown-host')
  const markdown = host?.querySelector('.conversation-markdown')
  document.getElementById('report').textContent = JSON.stringify(
    {
      text: host?.textContent,
      part: host?.querySelector('[data-conversation-markdown]')?.getAttribute('data-conversation-markdown'),
      theme: markdown?.className,
      color: markdown ? getComputedStyle(markdown).color : null,
      background: markdown
        ? getComputedStyle(markdown.querySelector('.code-block') ?? markdown).backgroundColor
        : null,
      links: [...(host?.querySelectorAll('a') ?? [])].map((link) => link.getAttribute('href')),
      images: host?.querySelectorAll('img').length,
      copied,
      copyState: host?.querySelector('.code-copy')?.getAttribute('data-copy-state'),
      hooks: document.getElementById('hook-result')?.textContent,
      violations,
    },
    null,
    2,
  )
}
root.render(<App />)
document.addEventListener('click', () => setTimeout(snapshot, 0))
setTimeout(snapshot, 100)
