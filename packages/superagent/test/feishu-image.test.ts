// Adapted from dsh-superagent (MIT)
/**
 * Downloading Feishu message images for an assessment (source `sources/feishu-image.ts`).
 * The Feishu Source keeps its lark-cli calls until it is rewired to the channels of the host; these cases are moved
 * from the prototype's tests and rewritten with that change.
 */
import { describe, it } from 'vitest'

describe('feishu-image', () => {
  it.todo('retains the source-message pairing, commits an image reference and removes temporary files')
  it.todo('rejects arbitrary keys and non-visual models before downloading')
  it.todo('cleans up refused attachments and failed downloads without returning an image')
  it.todo('refuses escaped output paths, oversize files and unsupported types')
})
