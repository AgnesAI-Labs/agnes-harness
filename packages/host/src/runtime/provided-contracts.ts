import * as observabilityContract from '@agnes/observability/contract'
import { registerProvidedExternal } from '@agnes/plugin-runtime/provided-externals'
import * as feedbackContract from './feedback/contract.js'

// Bind before any loader snapshots the externals table, including loaders created before createHost.
// Only leaf contracts cross this boundary; the Host and exporter implementations stay private.
registerProvidedExternal('@agnes/observability/contract', observabilityContract)
registerProvidedExternal('@agnes/host/feedback-contract', feedbackContract)
