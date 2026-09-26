import { type ComponentProps, XMarkdown, type XMarkdownProps } from '@ant-design/x-markdown'

function SafeLink({ children, href }: ComponentProps<{ href?: string }>) {
  return <a href={href}>{children}</a>
}

const props: XMarkdownProps = {
  content: '[safe](https://example.test)',
  escapeRawHtml: true,
  components: { a: SafeLink },
  streaming: { hasNextChunk: true, enableAnimation: true, animationConfig: { fadeDuration: 480 } },
}

export const checkedElement = <XMarkdown {...props} />
