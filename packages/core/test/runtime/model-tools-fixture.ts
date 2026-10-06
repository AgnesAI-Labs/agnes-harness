import { readFileSync } from 'node:fs'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeSchemaRefs } from '@agnes/protocol/runtime'
import type { ResolvedTool, ResolvedTools } from '../../src/runtime/model/wire-tools.js'

const SCHEMA = 'https://json-schema.org/draft/2020-12/schema'
const schemaFile = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../protocol/schema/runtime/${name}`, import.meta.url), 'utf8'))
    .$defs as Record<string, W.JsonValue>
const rewrite = (node: W.JsonValue): W.JsonValue =>
  Array.isArray(node)
    ? node.map(rewrite)
    : node !== null && typeof node === 'object'
      ? Object.fromEntries(
          Object.entries(node).map(([k, v]) => [
            k,
            k === '$ref' && typeof v === 'string' ? v.replace(/^[^#]*#/, '#') : rewrite(v),
          ]),
        )
      : node

/** The real StandardToolOutput schema document, rebuilt from the published schema files. */
export function standardToolDocument() {
  return {
    $schema: SCHEMA,
    $ref: '#/$defs/StandardToolOutput',
    $defs: {
      JsonValue: rewrite(schemaFile('prototype.json').JsonValue as W.JsonValue),
      StandardToolOutput: rewrite(schemaFile('public.json').StandardToolOutput as W.JsonValue),
    },
  }
}

/** One catalog tool bound to the real document by its schema digest, and what a resolver answers for it. */
export function standardTool(name: string, description: string, document: unknown = standardToolDocument()) {
  const annotations = { content: [{ type: 'text', text: description }] }
  const definition: W.ToolDefinition = {
    resource: { resourceId: name, version: '1', digest: canonicalJsonDigest(`fixture-${name}`) },
    executor: {
      bindingId: 'tools-binding',
      contract: 'agh.tools',
      logicalName: 'default',
      providerId: 'agh.default/tools',
    },
    name,
    inputSchema: { ...RuntimeSchemaRefs.StandardToolOutput, digest: canonicalJsonDigest(document as never) },
    outputSchema: RuntimeSchemaRefs.StandardToolOutput,
    requiredCapabilities: [],
    retrySafety: 'idempotent',
    publicAnnotations: {
      kind: 'inline',
      schema: RuntimeSchemaRefs.StandardToolOutput,
      value: annotations,
      digest: canonicalJsonDigest(annotations),
      bytes: new TextEncoder().encode(JSON.stringify(annotations)).length,
    },
    policy: {
      version: '1',
      classifierRef: null,
      defaults: {
        isReadOnly: true,
        isDestructive: false,
        replay: 'idempotent',
        requiresApproval: 'never',
        approvalScopes: [],
      },
    },
    execution: {
      concurrency: 'parallel',
      isOpenWorld: false,
      costHint: null,
      deferLoading: false,
      requiredModelInput: [],
    },
  }
  return { definition, resolved: { name, description, document } as ResolvedTool }
}

export const toolCatalogOf = (definitions: readonly W.ToolDefinition[]): W.ToolCatalog => ({
  revision: 1,
  digest: canonicalJsonDigest({ revision: 1, tools: definitions } as never),
  tools: [...definitions],
})

/** A route that offers tools on the fixture route, for a prepare request. */
export const toolRoute = (route: W.ModelRouteSnapshot): W.ModelRouteSnapshot => ({
  ...route,
  features: { ...route.features, tools: true },
})

export const resolverOf = (resolved: ResolvedTools) => ({
  resolve: async () => ({ ok: true as const, value: resolved }),
})
