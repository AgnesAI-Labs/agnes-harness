import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'

// This piece is a seam implementation and nothing else: the host reaches it through the provider
// the package registers for its kind, never through the extension API. The entry exists so the piece has the same
// life cycle as every other bundled piece - loaded, and disposed with the rest - and it registers
// nothing, which is what the empty capability lists in the manifest say.
export default defineAgnesPlugin({
  apply() {},
})
