import type { ReferenceProvider } from './index.js'
import { configReferenceProvider } from './providers/config.js'

export const registeredReferenceProviders: readonly ReferenceProvider[] = [configReferenceProvider]
