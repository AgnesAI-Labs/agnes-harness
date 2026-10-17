import { compare } from './contract.mjs'
import { demo } from './offline.mjs'

const reports = await demo()
process.stdout.write(`${JSON.stringify({ reports, comparison: compare(reports[0], reports[1]) }, null, 2)}\n`)
