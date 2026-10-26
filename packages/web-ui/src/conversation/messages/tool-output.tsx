import type { RefObject } from 'react'
import type { Translate } from '../../locales/index.js'
import { childListOutput } from '../../tool-presentation.js'
import { Disclosure } from '../../ui/disclosure.js'
import { Tag } from '../../ui/tag.js'
import type { ToolNode } from './context.js'
import { shellTranscript } from './shell-output.js'

/**
 * Arguments arrive as the clipped one-line JSON the tool received. Re-indenting it keeps a nested
 * payload readable in the technical fold; a preview clipped mid-value is not JSON, so it stays as is.
 */
function rawArgsText(preview: string): string {
  try {
    return JSON.stringify(JSON.parse(preview), null, 2)
  } catch {
    return preview
  }
}

/** A readable receipt first; exact call arguments remain in a separate technical fold. */
export function ToolOutput({
  node,
  command,
  output,
  environment,
  appendix,
  section,
  t,
  host,
}: {
  node: ToolNode
  command?: string | undefined
  output?: string | undefined
  environment?: string | undefined
  appendix?: string | undefined
  section: string
  t: Translate
  host: RefObject<HTMLDivElement>
}) {
  const shell = node.name === 'shell' || node.name === 'bash' ? shellTranscript(output) : undefined
  return (
    <div ref={host} className="tool-output" data-testid="tool-detail-text">
      {command && (
        <section>
          <p>{t('tool.detail.command')}</p>
          <pre data-testid="tool-command">{command}</pre>
        </section>
      )}
      {shell ? (
        <>
          {shell.stdout && (
            <section>
              <p>{t('tool.detail.stdout')}</p>
              <pre data-testid="tool-stdout">{shell.stdout}</pre>
            </section>
          )}
          {shell.stderr && (
            <section>
              <p>{t('tool.detail.stderr')}</p>
              <pre data-testid="tool-stderr">{shell.stderr}</pre>
            </section>
          )}
          {!shell.stdout && !shell.stderr && <p>{t('tool.detail.noOutput')}</p>}
          {shell.exit !== undefined && (
            <Tag tone={shell.exit === 0 ? 'info' : 'bad'}>
              {t('tool.status.exitCode', { code: shell.exit })}
            </Tag>
          )}
          {shell.truncated && <p>{t('tool.detail.truncated')}</p>}
        </>
      ) : output ? (
        <section>
          <p>{section}</p>
          <pre data-testid="tool-output-text">
            {node.name === 'subagent_list' ? childListOutput(output, t) : output}
          </pre>
        </section>
      ) : null}
      {environment && (
        <Disclosure variant="plain" summary={t('tool.environment')}>
          <pre>{environment}</pre>
        </Disclosure>
      )}
      {node.argsPreview && (
        <Disclosure variant="plain" summary={t('tool.detail.rawArgs')}>
          <p>{node.name}</p>
          <pre data-testid="tool-raw-args">{rawArgsText(node.argsPreview)}</pre>
        </Disclosure>
      )}
      {appendix && (
        <Disclosure variant="plain" summary={t('tool.detail.reply')}>
          <p>{appendix}</p>
        </Disclosure>
      )}
    </div>
  )
}
