/** @vitest-environment happy-dom */
import { createDocumentLocaleSource, UiLocaleProvider } from '@agnes/web-ui'
import { fireEvent } from '@testing-library/dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { MhsPage } from '../src/pages/mhs-page.js'

it.each(['en', 'zh-CN'])('collects a localized sales inquiry in %s', async (locale) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const previousLang = document.documentElement.lang
  document.documentElement.lang = locale
  const source = createDocumentLocaleSource({})
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <UiLocaleProvider source={source.source}>
          <MhsPage context={{ t: (key) => key }} />
        </UiLocaleProvider>,
      ),
    )
    const mediaOrigin =
      locale === 'zh-CN' ? 'https://cos-agent-default.agnes-ai.cn' : 'https://cos-agent-default.agnes-ai.com'
    const language = locale === 'zh-CN' ? 'zh' : 'en'
    expect(host.querySelector('video')?.getAttribute('poster')).toBe(
      `${mediaOrigin}/mhs/robot-arm-${language}.png`,
    )
    expect(host.querySelector('video source')?.getAttribute('src')).toBe(
      `${mediaOrigin}/mhs/robot-arm-${language}.mp4`,
    )
    const form = host.querySelector('form')!
    const code = form.querySelector<HTMLSelectElement>('[name="callingCode"]')!
    expect(code.value).toBe(locale === 'zh-CN' ? '+86' : '+1')
    expect(form.querySelector<HTMLInputElement>('[name="name"]')?.required).toBe(true)
    expect(form.querySelector<HTMLInputElement>('[name="phone"]')?.required).toBe(true)
    expect(form.querySelector('[name="company"], [name="message"]')).toBeNull()
    expect(form.querySelector<HTMLInputElement>('[name="github"]')?.required).toBe(false)
    const type = form.querySelector<HTMLSelectElement>('[name="requestType"]')!
    expect(type.required).toBe(true)
    expect([...type.options].slice(1).map((option) => option.textContent)).toEqual(
      locale === 'zh-CN'
        ? ['技术咨询', '商业合作', '私有化部署', '其他']
        : ['Tech Consulting', 'Business Cooperation', 'On-Premises Deployment', 'Other'],
    )
    expect(form.querySelector('[name="otherDetails"]')).toBeNull()
    await act(async () => fireEvent.change(type, { target: { value: 'other' } }))
    expect(form.querySelector<HTMLInputElement>('[name="otherDetails"]')?.required).toBe(true)
    await act(async () => fireEvent.change(type, { target: { value: 'tech' } }))
    expect(form.querySelector('[name="otherDetails"]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    source.dispose()
    host.remove()
    document.documentElement.lang = previousLang
  }
})
