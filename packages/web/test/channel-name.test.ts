import { describe, expect, it } from 'vitest'
import { channelName } from '../src/pages/channel-name.js'

describe('channel names', () => {
  it('selects the UI language without changing identity and falls back for older providers', () => {
    const manifest = {
      id: 'example',
      displayName: '旧名称',
      displayNames: { en: 'Example', 'zh-CN': '示例' },
    }
    expect(channelName(manifest, false)).toBe('Example')
    expect(channelName(manifest, true)).toBe('示例')
    expect(channelName(manifest, false)).toBe('Example')
    expect(manifest.id).toBe('example')
    expect(channelName({ ...manifest, displayNames: { 'zh-CN': '示例' } }, false)).toBe('旧名称')
    expect(channelName({ id: 'legacy', displayName: 'Legacy' }, true)).toBe('Legacy')
    expect(channelName({ id: 'legacy', displayName: '' }, false)).toBe('legacy')
  })
})
