// The client module of a plugin package written outside this repository. It renders the package's
// note view, through a Web component and through a text format for the TUI and SDK clients, and serves
// the UI registry and the Web shell a selection of the package needs. It imports React and the public
// client types of @agnes/extension-api, nothing else. client-module.json is its catalog entry.
import type {
  RendererDefinition,
  RuntimeError,
  ShellProvider,
  TextRenderer,
  UIRegistryFactory,
  WebRendererDefinition,
} from '@agnes/extension-api/client'

/** The data of an acme.notes/note@1 view. */
type Note = { title: string; body: string }

export const component: WebRendererDefinition<Note>['component'] = ({ view }) => (
  <article className="acme-note">
    <h3>{view.data.title}</h3>
    <p>{view.data.body}</p>
  </article>
)

export const format: TextRenderer['format'] = (view) => {
  const { title, body } = view.data as Note
  return {
    ok: true,
    value: {
      viewId: view.viewId,
      revision: view.revision,
      parts: [
        { kind: 'text', text: title },
        { kind: 'text', text: body },
      ],
      // The note card shows no actions, so a view that offers some is not shown in full.
      complete: view.actions.length === 0,
      unsupportedRequiredFeatures: [],
    },
  }
}

const refused = (message: string): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: {
    code: 'conflict',
    detailCode: 'renderer_conflict',
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'acme-notes-registry',
  },
})

/** Holds the renderers registered with it and binds each match through the client host. */
export const createRegistry: UIRegistryFactory = (host) => {
  const held = new Map<string, RendererDefinition>()
  return {
    ok: true,
    value: {
      register(definition) {
        const { id } = definition.descriptor
        if (held.has(id)) return refused(`renderer ${id} is already registered`)
        held.set(id, definition)
        return {
          ok: true,
          value: {
            id,
            ownerToken: `acme.notes/registry/${id}`,
            dispose: async () => {
              if (held.get(id) === definition) held.delete(id)
            },
          },
        }
      },
      resolve({ renderKey, viewSchema, target, requiredFeatures }) {
        const found = [...held.values()].find(
          ({ descriptor }) =>
            descriptor.renderKey === renderKey &&
            descriptor.targets.includes(target) &&
            descriptor.viewSchemaRanges.some(
              (range) =>
                range.typeId === viewSchema.typeId &&
                range.minRevision <= viewSchema.revision &&
                viewSchema.revision <= range.maxRevision,
            ) &&
            requiredFeatures.every(
              (feature) =>
                descriptor.requiredFeatures.includes(feature) ||
                descriptor.optionalFeatures.includes(feature),
            ),
        )
        if (found === undefined)
          return { ok: true, value: { kind: 'fallback', reason: 'no_matching_renderer' } }
        const bound = host.bindRenderer(found)
        if (!bound.ok) return bound
        return { ok: true, value: { kind: 'matched', descriptor: found.descriptor, handle: bound.value } }
      },
    },
  }
}

const STATE = { typeId: 'acme.notes/shell-state@1', revision: 1, digest: 'c'.repeat(64) }
const done = { ok: true, value: undefined } as const

/** The package's Web shell. It lays out nothing of its own and keeps no state. */
export function notesShell(): ShellProvider {
  return {
    descriptor: {
      id: 'acme.notes/shell',
      apiMajor: 1,
      stateSchema: STATE,
      requiredRegions: ['conversation'],
    },
    mount: async () => done,
    update: async () => done,
    exportState: async () => ({ ok: true, value: { schema: STATE, data: null } }),
    importState: async () => done,
    stopAdmission() {},
    dispose: async () => done,
  }
}
