import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { commandNotificationSchema, commandRequestSchema, commandResponseSchema } from '../src/commands.js'
import { dataSchemas } from '../src/observations.js'
import { observationSchema, registrationSchema } from '../src/schema.js'

const path = new URL('../schema/mhs-v1.json', import.meta.url)
const raw = `${JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: { registration: registrationSchema, observation: observationSchema, ...dataSchemas, commandRequest: commandRequestSchema, commandNotification: commandNotificationSchema, commandResponse: commandResponseSchema } }, null, 2)}\n`
const text = execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL('../../../node_modules/@biomejs/biome/bin/biome', import.meta.url)),
    'format',
    '--stdin-file-path=schema.json',
  ],
  { input: raw, encoding: 'utf8' },
)
for (const target of [path, new URL('../python/src/agnes_mhs/schema.json', import.meta.url)]) {
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== text) throw new Error('MHS schema is stale')
  } else writeFileSync(target, text)
}
