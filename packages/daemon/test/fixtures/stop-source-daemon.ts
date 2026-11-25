import { stopDaemon } from '../../src/supervisor/control.js'

const home = process.argv[2]
if (!home) throw new Error('source daemon stop fixture requires a home')

if ((await stopDaemon(home)) === 'timeout') throw new Error('source daemon did not stop within its deadline')
