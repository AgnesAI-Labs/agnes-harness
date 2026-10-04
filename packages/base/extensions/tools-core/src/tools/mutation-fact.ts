import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

/** Facts about a completed fs.write acknowledgement, not independent readback or task correctness. */
export function mutationFact(tool: 'write' | 'edit', cwd: string, path: string, content: string) {
  const bytes = new TextEncoder().encode(content)
  return {
    codec: 'agnes-host-tool-fact-v1',
    tool,
    target: { kind: 'file', path: resolve(cwd, path) },
    write: {
      acknowledged: true,
      versionSource: 'submitted-utf8-bytes-sha256',
      size: bytes.byteLength,
      digest: createHash('sha256').update(bytes).digest('hex'),
    },
  }
}
