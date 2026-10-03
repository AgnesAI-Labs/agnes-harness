import { createReferenceResources } from '../../../../examples/runtime-reference/src/providers/resources.js'
import {
  resourceCatalogContext,
  resourceCatalogFixtureInput,
} from '../../../../packages/extension-api/testkit/runtime/contracts/resources.js'
import { createResourcesService } from '../../../../packages/host/src/runtime/providers/resources.js'

// Test-only executable. Every invocation constructs a provider from disk in a fresh process.
const [provider, directory, resourceId, version] = process.argv.slice(2)
if (!directory || !resourceId || !version || !['default', 'reference'].includes(provider ?? ''))
  throw new Error('invalid fixture invocation')
const options = resourceCatalogFixtureInput(directory)
const subject = provider === 'default' ? createResourcesService(options) : createReferenceResources(options)
try {
  const result = await subject.call('describe', { resourceId, version }, resourceCatalogContext())
  process.stdout.write(JSON.stringify(result))
} finally {
  subject.close()
}
