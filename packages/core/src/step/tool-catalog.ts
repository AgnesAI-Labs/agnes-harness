import type { SessionImpl } from './session.js'

export function sessionToolCatalog(session: SessionImpl): import('@agnes/protocol').SessionToolsResult {
  const context = session.operationContext()
  return {
    sessionId: session.key,
    tools: context.snapshot.defs.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(tool.parameters),
      source: context.snapshot.byName.get(tool.name)?.source.source ?? '',
      deferred: tool.meta.deferLoading === true,
      readOnly: tool.meta.isReadOnly,
    })),
    resources: (session.hooks.resources?.() ?? []).map(({ id, kind, name, description }) => ({
      id,
      kind,
      name,
      description,
    })),
  }
}
