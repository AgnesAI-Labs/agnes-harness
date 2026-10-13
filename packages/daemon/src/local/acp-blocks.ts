import { type ContentBlock, toAcpPrompt } from '@agnes/protocol'

const sized = (bytes: number) => `${bytes} bytes`

/** Every block of a user message as ACP content; a lean attachment is named, never silently dropped. */
export function acpUserBlocks(content: readonly ContentBlock[], seq: number): unknown[] {
  // The same 1-based, per-kind numbering the session-image:// and session-file:// readers use.
  let image = 0
  let file = 0
  return content.flatMap((block) => {
    if (block.type === 'image') image++
    if (block.type === 'file') file++
    if ((block.type === 'image' || block.type === 'file') && 'dataOmitted' in block) {
      const omitted = (block as { dataOmitted: { bytes: number } }).dataOmitted.bytes
      return [
        block.type === 'image'
          ? { type: 'text', text: `[image omitted: ${sized(omitted)}; read session-image://${seq}/${image}]` }
          : {
              type: 'text',
              text: `[file ${JSON.stringify((block as { name: string }).name)} omitted: ${sized(omitted)}; read session-file://${seq}/${file}]`,
            },
      ]
    }
    return toAcpPrompt([block])
  })
}
