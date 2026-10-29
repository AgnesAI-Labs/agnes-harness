import type { McpTool } from '@agnes/protocol'
import { useState } from 'react'
import { RESOURCE_DETAIL_LOCALE_NAMESPACE, resourceDetailLocaleCatalog } from './locales/resource-detail.js'
import { SettingsCode } from './settings-layout.js'
import { Disclosure } from './ui/disclosure.js'
import { useUiText } from './ui-locale.js'

type CatalogTool = Pick<McpTool, 'name' | 'description' | 'inputSchema'>
export type ToolCatalog = { items: readonly CatalogTool[]; nextCursor: string | undefined }

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** A bounded excerpt for scanning; the server's complete text remains available on expansion. */
function summary(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim()
  const sentence = text.match(/^.*?(?:[.!?](?:\s|$)|[。！？])/u)?.[0].trim() ?? text
  return sentence.length > 180 ? `${sentence.slice(0, 177)}…` : sentence
}

function ToolCard({ tool }: { tool: CatalogTool }) {
  const { t } = useUiText(RESOURCE_DETAIL_LOCALE_NAMESPACE, resourceDetailLocaleCatalog)
  const [open, setOpen] = useState(false)
  const schema = object(tool.inputSchema)
  const parameters = Object.entries(object(schema.properties))
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return (
    <Disclosure
      variant="card"
      className="mcp-tool-card"
      summary={<code>{tool.name}</code>}
      description={summary(tool.description) || t('mcp.tools.noDescription')}
      summaryProps={{ 'aria-label': t('mcp.tools.details', { name: tool.name }) }}
      open={open}
      onOpenChange={setOpen}
    >
      {open && (
        <div className="mcp-tool-details">
          <section>
            <h4>{t('mcp.tools.description')}</h4>
            <p className="mcp-tool-description">{tool.description || t('mcp.tools.noDescription')}</p>
          </section>
          {parameters.length > 0 && (
            <section>
              <h4>{t('mcp.tools.parameters')}</h4>
              <dl className="mcp-tool-parameters">
                {parameters.map(([name, value]) => {
                  const property = object(value)
                  const type =
                    typeof property.type === 'string'
                      ? property.type
                      : Array.isArray(property.type)
                        ? property.type.filter((item) => typeof item === 'string').join(' | ')
                        : ''
                  return (
                    <div key={name}>
                      <dt>
                        <code>{name}</code>
                        <span>{type || t('mcp.tools.schemaType')}</span>
                        <span>{t(required.has(name) ? 'mcp.tools.required' : 'mcp.tools.optional')}</span>
                      </dt>
                      {typeof property.description === 'string' && <dd>{property.description}</dd>}
                    </div>
                  )
                })}
              </dl>
            </section>
          )}
          <Disclosure variant="plain" summary={t('mcp.tools.schema')}>
            <SettingsCode label={t('mcp.tools.schema')} copy={JSON.stringify(tool.inputSchema, null, 2)}>
              {JSON.stringify(tool.inputSchema, null, 2)}
            </SettingsCode>
          </Disclosure>
        </div>
      )}
    </Disclosure>
  )
}

export function McpToolCatalog({ items }: { items: ToolCatalog['items'] }) {
  const { t } = useUiText(RESOURCE_DETAIL_LOCALE_NAMESPACE, resourceDetailLocaleCatalog)
  return items.length ? (
    <ul className="mcp-tool-catalog">
      {items.map((tool) => (
        <li key={tool.name}>
          <ToolCard tool={tool} />
        </li>
      ))}
    </ul>
  ) : (
    <p>{t('mcp.tools.empty')}</p>
  )
}
