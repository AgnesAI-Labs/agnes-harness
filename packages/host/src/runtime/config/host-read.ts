import type { ConfigReadResult } from '@agnes/protocol/runtime'
import { type ConfigOutcome, configRefusal } from './config-digest.js'

type ConfigReader = {
  read(input: unknown): ConfigOutcome<ConfigReadResult>
}

// Read one admitted revision. A missing revision stays missing; this entry never asks for the latest snapshot.
export function readPinnedConfigDocument(
  provider: ConfigReader,
  sourceRef: string,
  revision: number,
): ConfigOutcome<ConfigReadResult> {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return {
      ok: false,
      refusal: configRefusal('schema_invalid', '/revision', 'revision must be a positive integer'),
    }
  }
  return provider.read({ sourceRef, revision })
}
