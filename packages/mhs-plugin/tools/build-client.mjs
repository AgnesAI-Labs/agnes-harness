import { fileURLToPath } from 'node:url'
import { buildMhsClient } from '@agnes/mhs-ui/build'

await buildMhsClient(fileURLToPath(new URL('../dist/client', import.meta.url)))
