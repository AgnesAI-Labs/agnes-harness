// Test-only caller. Killing this process must close the helper's owner pipe.
import { spawn } from 'node:child_process'

const [helper, executable, trace] = process.argv.slice(2)
const child = spawn(
  helper,
  ['8000', '10000', '536870912', '65536', '16', 'five-limits', executable, 'wall', trace],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
)
child.stdin.on('error', () => {})
child.stdin.write(Buffer.alloc(4))
child.stdout.resume()
child.stderr.resume()
child.on('error', () => process.exit(125))
child.on('close', (code) => process.exit(code ?? 125))
