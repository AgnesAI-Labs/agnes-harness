import type { ClientModule, SkinMetadata } from '../../src/runtime/index.js'

type SkinStyle = Extract<ClientModule['styles'][number], { kind: 'skin' }>
type SkinTokens = NonNullable<SkinStyle['skin']['tokens']>
const tokens: SkinTokens = { accent: { light: 'white', dark: 'black' } }
const accent = tokens.accent
if (!accent) throw new Error('expected accent token')
const light: string = accent.light
const dark: string = accent.dark
// @ts-expect-error a theme token record cannot be a scalar
const scalar: SkinTokens = 'text'
// @ts-expect-error theme token values are strings
const numeric: SkinTokens = { accent: { light: 1, dark: 'black' } }
// @ts-expect-error each theme token requires both variants
const incomplete: SkinTokens = { accent: { light: 'white' } }
const metadata: NonNullable<SkinMetadata['tokens']> = tokens
const metadataAccent = metadata.accent
if (!metadataAccent) throw new Error('expected metadata token')
const metadataLight: string = metadataAccent.light
// @ts-expect-error a metadata token record cannot be a scalar
const invalidMetadata: NonNullable<SkinMetadata['tokens']> = 'text'
void [light, dark, scalar, numeric, incomplete, metadataLight, invalidMetadata]
