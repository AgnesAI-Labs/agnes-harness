import type { DefaultLoopSource } from '@agnes/core'
import type { Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import type { SelectedModelCatalog } from './model-catalog-capture.js'
import {
  LOOP_MODEL_SLOT,
  resolveSessionModelSelection,
  type SelectionRoutes,
  selectionRefusal,
} from './model-selection.js'

export type SessionModelSourcePorts = Readonly<{
  catalog: Readonly<{ capture(): SelectedModelCatalog }>
  routes: SelectionRoutes
  parameters: Readonly<{ verify(frame: Wire.RunFrame): Promise<Outcome<void>> }>
}>

const same = (a: unknown, b: unknown) =>
  canonicalJsonDigest(a as Wire.JsonValue) === canonicalJsonDigest(b as Wire.JsonValue)

/**
 * Puts the model the frame's parameter revision selects into the loop inputs: the one allowed route,
 * its catalog revision, the thinking level and a context limit that cannot exceed the target's window.
 * It reads only the frame; a newer revision is seen by the next frame, never by this one. It sits
 * inside the credential wrapper, which picks its consumer from the route chosen here.
 */
export function sessionModelSelectionSource(
  base: DefaultLoopSource,
  ports: SessionModelSourcePorts,
): DefaultLoopSource {
  return {
    checkCurrent: (context) => base.checkCurrent(context),
    async readInputs(frame, stage, reads) {
      const inputs = await base.readInputs(frame, stage, reads)
      if (!inputs.ok) return inputs
      const { value, reference } = frame.sessionParameters
      if (value.sessionId !== frame.sessionId || !same(inputs.value.sessionParameterRef, reference))
        return selectionRefusal('conflict', 'model_selection_parameters')
      const verified = await ports.parameters.verify(frame)
      if (!verified.ok) return verified
      const selection = resolveSessionModelSelection({
        revision: value,
        slot: LOOP_MODEL_SLOT,
        catalog: ports.catalog.capture(),
        routes: ports.routes,
        needs: inputs.value.routing.requiredFeatures,
      })
      if (!selection.ok) return selection
      const { snapshot, thinking, record } = selection.value
      const { target } = inputs.value.context
      return {
        ok: true,
        value: {
          ...inputs.value,
          routing: {
            ...inputs.value.routing,
            allowedRoutes: [snapshot],
            catalogRevision: snapshot.catalogRevision,
          },
          generation: { ...inputs.value.generation, thinking },
          context: {
            ...inputs.value.context,
            target: {
              ...target,
              modelRoute: snapshot.routeId,
              tokenLimit: Math.min(target.tokenLimit, record.contextWindow),
            },
          },
        },
      }
    },
  }
}
