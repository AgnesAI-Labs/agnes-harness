import type { ProviderPluginContext } from '@agnes/extension-api'
import type { SeamInit, SeamProvider } from '@agnes/extension-api/seams'
import {
  approvalKind,
  artifactsKind,
  billingKind,
  checkpointKind,
  principalsKind,
  repairKind,
  verifierKind,
} from '@agnes/extension-api/seams'
import { approvalPolicy } from '../extensions/approval-policy/src/seam.js'
import { artifactsLocal } from '../extensions/artifacts-local/src/seam.js'
import { budgetBilling } from '../extensions/budget/src/seam.js'
import { fsCheckpoint } from '../extensions/fs-checkpoint/src/seam.js'
import { repairPolicy, verifierT0 } from '../extensions/loop-hygiene/src/seam.js'
import { principalsLocal } from '../extensions/principals-local/src/seam.js'
import type { SeamFactory, SeamInitContext } from './seam-init.js'

const VERSION = '1.0.0'

/**
 * The Host hands a bundled package the wider `SeamInitContext`; every other provider only ever sees
 * the plain `SeamInit`. The cast is the one place that difference is spelled.
 */
function provider<T extends object>(id: string, factory: SeamFactory<T>): SeamProvider<T> {
  return { id, version: VERSION, create: (init: SeamInit) => factory(init as SeamInitContext) }
}

/** The ids the built-in profile templates select. */
export const BASE_SEAM_PROVIDERS = Object.freeze({
  approval: provider('local-prompt', approvalPolicy),
  principals: provider('local', principalsLocal),
  billing: provider('budget', budgetBilling),
  checkpoint: provider('fs', fsCheckpoint),
  artifacts: provider('local', artifactsLocal),
  verifier: provider('t0', verifierT0),
  repair: provider('default', repairPolicy),
})

/** Registers Base's seam implementations through the same path any package uses. */
export const seamProvidersPlugin = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext) {
    const { providers } = ctx
    providers.register(approvalKind, BASE_SEAM_PROVIDERS.approval)
    providers.register(principalsKind, BASE_SEAM_PROVIDERS.principals)
    providers.register(billingKind, BASE_SEAM_PROVIDERS.billing)
    providers.register(checkpointKind, BASE_SEAM_PROVIDERS.checkpoint)
    providers.register(artifactsKind, BASE_SEAM_PROVIDERS.artifacts)
    providers.register(verifierKind, BASE_SEAM_PROVIDERS.verifier)
    providers.register(repairKind, BASE_SEAM_PROVIDERS.repair)
  },
}
