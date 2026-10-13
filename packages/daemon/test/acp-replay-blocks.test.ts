import { expect, it } from 'vitest'
import { acpUserBlocks } from '../src/local/acp-blocks.js'

it('replays every block and names an omitted attachment instead of dropping it', () => {
  const blocks = acpUserBlocks(
    [
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', data: 'QUJD' },
      { type: 'image', mimeType: 'image/jpeg', dataOmitted: { bytes: 3_000_000 } } as never,
      {
        type: 'file',
        mimeType: 'application/zip',
        name: 'a.zip',
        dataOmitted: { bytes: 95_000_000 },
      } as never,
    ],
    7,
  )
  expect(blocks).toEqual([
    { type: 'text', text: 'look' },
    { type: 'image', mimeType: 'image/png', data: 'QUJD' },
    { type: 'text', text: '[image omitted: 3000000 bytes; read session-image://7/2]' },
    { type: 'text', text: '[file "a.zip" omitted: 95000000 bytes; read session-file://7/1]' },
  ])
})
