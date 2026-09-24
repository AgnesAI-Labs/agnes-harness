import { defineExtension } from '@agnes/extension-api'

// This piece is a seam implementation and nothing else: the host reaches it through the package's
// named `seams` export, never through the extension API. The entry exists so the piece has the same
// life cycle as every other bundled piece - loaded, and disposed with the rest - and it registers
// nothing, which is what the empty capability lists in the manifest say.
export default defineExtension(() => undefined)
