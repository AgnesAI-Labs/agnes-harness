import { RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { createAuthorSchema } from './authoring-schema-core.js'

const refs = RuntimeMethodSchemaRefs['agh.pricing'].quote
/** Official quote method codecs; callers cannot substitute a validator for these full references. */
export const pricingInputSchema = createAuthorSchema(refs.input, (value) =>
  validateRuntime('PricingQuoteRequest', value),
)
export const pricingQuoteSchema = createAuthorSchema(refs.output, (value) =>
  validateRuntime('PriceQuote', value),
)
