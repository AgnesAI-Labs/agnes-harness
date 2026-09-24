import { join } from 'node:path'
import { createPackageManager, parseSource } from '../../src/index.js'

const [root, point, integrity] = process.argv.slice(2)
if (!root || !point || !integrity) throw new Error('missing fixture arguments')
const manager = createPackageManager({
  dataDir: root,
  cwd: root,
  agnesVersion: '0.1.0',
  references: async () => [], // This isolated fixture has no running generation or deployment.
  checkpoint: (current) => {
    if (current === point) process.exit(74)
  },
})
await manager.update(join(root, 'profiles', 'local-dev'), 'acme/pkg-a', parseSource('file:./candidate'), {
  expectedIntegrity: integrity,
  onProgress: ({ phase }) => {
    if (phase === point) process.exit(74)
  },
})
process.exit(75)
