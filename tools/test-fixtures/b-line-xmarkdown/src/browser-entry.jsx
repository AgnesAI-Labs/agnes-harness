import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import '@ant-design/x-markdown/themes/light.css'
import '@ant-design/x-markdown/themes/dark.css'
import { AdaptedMarkdown, CoordinatedMarkdown, DefaultMarkdown } from './adapt.jsx'

const host = document.getElementById('root')
const root = createRoot(host)
const report = document.getElementById('report')
const violations = []
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI })
  report.textContent = JSON.stringify({ ...JSON.parse(report.textContent || '{}'), violations }, null, 2)
})
const safetyCorpus =
  '<script>window.pwned = true</script>\n\nFish &amp; Chips\n\n[good](https://example.test/?a=1&amp;b=2) [fragment](#notes) [relative](../notes) [data](data:text/html,hi) [encoded](java&#x73;cript:alert(1))\n\n**保留粗体** \\<img src="https://example.test/literal.png" data-note="a&amp;b"> &lt;em&gt;literal entity&lt;/em&gt; 和 *强调*\n\n![diagram alt](/brand-mark.png)\n\n```ts\nshown code\n```'
let stableParagraph
let stableSpan
let focusedCopy
let lastArgs
function snapshot() {
  const links = [...host.querySelectorAll('a')].map((link) => ({
    text: link.textContent,
    href: link.getAttribute('href'),
  }))
  return {
    text: host.textContent,
    imageCount: host.querySelectorAll('img').length,
    links,
    copyCount: host.querySelectorAll('.code-copy').length,
    stableParagraph: stableParagraph ? stableParagraph === host.querySelector('p') : null,
    stableFirstSpan: stableSpan ? stableSpan === host.querySelector('p span') : null,
    focusedCopy: focusedCopy ? focusedCopy === document.activeElement : null,
    selectedText: document.getSelection()?.toString(),
    animationSpans: [...host.querySelectorAll('span[style*="animation"]')].map((span) => ({
      text: span.textContent,
      style: span.getAttribute('style'),
      computed: getComputedStyle(span).animationName,
    })),
    themeClass: host.querySelector('.x-markdown')?.className,
    themeColor: host.querySelector('.x-markdown')
      ? getComputedStyle(host.querySelector('.x-markdown')).color
      : null,
    userAgent: navigator.userAgent,
    sheets: [...document.styleSheets].map((sheet) => sheet.href),
    resources: performance
      .getEntriesByType('resource')
      .filter((entry) => entry.name.includes('brand-mark'))
      .map((entry) => entry.name),
    violations,
  }
}
function show() {
  report.textContent = JSON.stringify(snapshot(), null, 2)
}
window.probe = {
  render(mode, content, streaming = false, animation = false) {
    lastArgs = [mode, content, streaming, animation]
    const Component =
      mode === 'default' ? DefaultMarkdown : mode === 'coordinated' ? CoordinatedMarkdown : AdaptedMarkdown
    const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    flushSync(() =>
      root.render(<Component content={content} streaming={streaming} animation={animation} theme={theme} />),
    )
    show()
    return host.innerHTML
  },
  host,
}
window.probe.render('adapted', '# Browser probe\n\nStable paragraph', false)
for (const button of document.querySelectorAll('button[data-case]')) {
  button.addEventListener('click', () => {
    switch (button.dataset.case) {
      case 'default-safety':
        window.probe.render('default', safetyCorpus, false)
        break
      case 'adapted-safety':
        window.probe.render('adapted', safetyCorpus, false)
        break
      case 'stream-start':
        window.probe.render('adapted', '固定段落\n\n[文档][ref]', true)
        setTimeout(() => {
          stableParagraph = host.querySelector('p')
          show()
        }, 40)
        break
      case 'stream-ref':
        window.probe.render('adapted', '固定段落\n\n[文档][ref]\n\n[ref]: https://example.test/docs', true)
        break
      case 'stream-final':
        window.probe.render('adapted', '固定段落\n\n[文档][ref]\n\n[ref]: https://example.test/docs', false)
        break
      case 'syntax-start':
        window.probe.render('adapted', '稳定段落\n\n**加', true)
        break
      case 'syntax-close':
        window.probe.render('adapted', '稳定段落\n\n**加粗**\n\n```ts\nconst x = 1\n```', true)
        break
      case 'replace-final':
        window.probe.render('adapted', '最终结果', false)
        break
      case 'animation-start':
        window.probe.render('adapted', '逐字', true, true)
        setTimeout(() => {
          stableParagraph = host.querySelector('p')
          stableSpan = host.querySelector('p span')
          show()
        }, 40)
        break
      case 'animation-delta':
        window.probe.render('adapted', '逐字追加', true, true)
        break
      case 'selection-delta': {
        window.probe.render('coordinated', '固定段落\n\n流式尾部', true)
        setTimeout(() => {
          stableParagraph = host.querySelector('p')
          const range = document.createRange()
          range.selectNodeContents(stableParagraph)
          document.getSelection().removeAllRanges()
          document.getSelection().addRange(range)
          window.probe.render('coordinated', '固定段落\n\n流式尾部 **完成**', true)
          show()
        }, 40)
        break
      }
      case 'selection-release':
        document.getSelection().removeAllRanges()
        document.dispatchEvent(new Event('selectionchange'))
        break
      case 'focus-delta': {
        window.probe.render('coordinated', '```\nold code\n```', false)
        focusedCopy = host.querySelector('.code-copy')
        focusedCopy.focus()
        window.probe.render('coordinated', '```\nnew code\n```', false)
        break
      }
      case 'focus-release':
        focusedCopy?.blur()
        document.dispatchEvent(new Event('focusout'))
        break
      case 'theme-dark':
        document.documentElement.classList.toggle('dark')
        window.probe.render(...lastArgs)
        break
    }
    setTimeout(show, 60)
  })
}
