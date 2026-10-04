import { describe, expect, it } from 'vitest'
import { fakeProvider } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const image = (data = png) => ({ type: 'image' as const, mimeType: 'image/png', data })

describe('user message images', () => {
  it('accepts valid inline PNG content into the shared session input queue', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    const content = [image()]

    await session.enqueue('next-turn', { content, actor })

    expect(session.latest('inbox')).toMatchObject({ items: [{ content }] })
  })

  it('rejects malformed images before they enter the durable inbox', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })

    await expect(
      session.enqueue('next-turn', { content: [image(png.slice(0, 24))], actor }),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE' })

    expect(session.latest('inbox')).toBeUndefined()
    expect(await log.scan({ type: 'inbox', limit: 10 })).toHaveLength(0)
  })

  it('enforces image count and raw byte limits before decoding image payloads', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    const manyImages = Array.from({ length: 5 }, () => image())
    const oversizedImage = image('A'.repeat(4 * Math.ceil((1024 * 1024 + 1) / 3)))

    await expect(session.enqueue('next-turn', { content: manyImages, actor })).rejects.toMatchObject({
      code: 'E_ENVELOPE',
    })
    await expect(session.enqueue('next-turn', { content: [oversizedImage], actor })).rejects.toMatchObject({
      code: 'E_ENVELOPE',
    })
    expect(session.latest('inbox')).toBeUndefined()
  })
})
