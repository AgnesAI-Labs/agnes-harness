/** @vitest-environment happy-dom */
import { createDocumentLocaleSource, UiLocaleProvider } from '@agnes/web-ui'
import { fireEvent, getByRole } from '@testing-library/dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ExplorePage } from '../src/pages/explore-page.js'

function requiredElement<T extends Element = HTMLElement>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector<T>(selector)
  if (!element) throw new Error(`Expected test element: ${selector}`)
  return element
}

it.each(['en', 'zh-CN'])('shows exploration pages and collects a localized inquiry in %s', async (locale) => {
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
          <ExplorePage context={{ t: (key) => key }} />
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
    const zh = locale === 'zh-CN'
    const pagination = requiredElement(host, '.mhs-pagination')
    const book = requiredElement<HTMLElement>(host, '#explore-slide-0')
    const overview = requiredElement<HTMLElement>(host, '#mhs-overview')
    const workflow = requiredElement<HTMLElement>(host, '#mhs-workflow')
    const capabilities = requiredElement<HTMLElement>(host, '#explore-slide-1')
    const contact = requiredElement<HTMLElement>(host, '#explore-slide-2')
    const next = () => getByRole(host, 'button', { name: zh ? '下一页' : 'Next', exact: true })
    const previous = () => getByRole(host, 'button', { name: zh ? '上一页' : 'Previous', exact: true })
    expect(book.hidden).toBe(false)
    expect(workflow.parentElement?.hidden).toBe(true)
    expect(pagination.textContent).toContain('01 / 03')
    await act(async () =>
      fireEvent.click(
        getByRole(host, 'button', {
          name: zh ? '能力流程' : 'How it works',
          exact: true,
        }),
      ),
    )
    expect(workflow.parentElement?.hidden).toBe(false)
    expect(overview.parentElement?.getAttribute('aria-hidden')).toBe('true')
    expect(pagination.textContent).toContain('01 / 03')
    await act(async () =>
      fireEvent.click(
        getByRole(host, 'button', {
          name: zh ? '返回产品概览' : 'Back to overview',
          exact: true,
        }),
      ),
    )
    expect(workflow.parentElement?.hidden).toBe(true)
    await act(async () =>
      fireEvent.click(
        getByRole(host, 'button', {
          name: zh ? '翻页查看能力流程' : 'Turn to how it works',
          exact: true,
        }),
      ),
    )
    expect(workflow.parentElement?.hidden).toBe(false)
    await act(async () => fireEvent.click(next()))
    expect(book.hidden).toBe(true)
    expect(capabilities.hidden).toBe(false)
    expect(capabilities.querySelectorAll('article')).toHaveLength(4)
    expect([...capabilities.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual(
      zh ? ['MaaS', '沙箱', '搜索', '记忆'] : ['MaaS', 'Sandbox', 'Search', 'Memory'],
    )
    expect(contact.hidden).toBe(true)
    expect(pagination.textContent).toContain('02 / 03')
    expect(pagination.textContent).toContain(zh ? '单项能力' : 'Paid capabilities')
    for (const button of capabilities.querySelectorAll('button')) {
      await act(async () => fireEvent.click(button))
      expect(contact.hidden).toBe(false)
      await act(async () => fireEvent.click(previous()))
    }
    await act(async () => fireEvent.click(next()))
    expect(capabilities.hidden).toBe(true)
    expect(contact.hidden).toBe(false)
    expect(pagination.textContent).toContain('03 / 03')
    expect(host.querySelector('.mhs-page-arrow-right')).toBeNull()
    await act(async () => fireEvent.click(previous()))
    expect(capabilities.hidden).toBe(false)
    await act(async () => fireEvent.click(previous()))
    expect(book.hidden).toBe(false)
    expect(host.querySelector('.mhs-page-arrow-left')).toBeNull()
    await act(async () =>
      fireEvent.click(
        getByRole(host, 'button', {
          name: zh ? '产品概览' : 'Overview',
          exact: true,
        }),
      ),
    )
    expect(workflow.parentElement?.hidden).toBe(true)
    await act(async () => fireEvent.click(requiredElement(host, 'button.mhs-sales-link')))
    expect(contact.hidden).toBe(false)
    const form = requiredElement<HTMLFormElement>(host, 'form')
    const code = requiredElement<HTMLInputElement>(form, '[name="callingCode"]')
    const picker = requiredElement<HTMLElement>(form, '.mhs-code-picker')
    const chooseCallingCode = async (value: string) => {
      await act(async () => fireEvent.mouseDown(requiredElement(picker, 'input[role="combobox"]')))
      const option = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find((entry) =>
        entry.textContent?.startsWith(`${value} `),
      )
      if (!option) throw new Error(`Expected calling code option: ${value}`)
      await act(async () => fireEvent.click(option))
    }
    expect(code.value).toBe(locale === 'zh-CN' ? '+86' : '+1')
    expect(picker.querySelector('.ant-select-content')?.textContent?.trim()).toBe(code.value)
    await act(async () => fireEvent.mouseDown(requiredElement(picker, 'input[role="combobox"]')))
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain(
      locale === 'zh-CN' ? '+86 中国' : '+86 China',
    )
    const selectedOption = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
      (entry) => entry.textContent?.startsWith(`${code.value} `),
    )
    if (!selectedOption) throw new Error(`Expected selected calling code: ${code.value}`)
    await act(async () => fireEvent.click(selectedOption))
    expect(picker.querySelector('.ant-select-content')?.textContent?.trim()).toBe(code.value)
    expect(form.querySelector<HTMLInputElement>('[name="name"]')?.required).toBe(true)
    expect(form.querySelector<HTMLInputElement>('[name="phone"]')?.required).toBe(true)
    expect(form.querySelector('[name="company"], [name="message"]')).toBeNull()
    expect(form.querySelector<HTMLInputElement>('[name="github"]')?.required).toBe(false)
    const type = requiredElement<HTMLSelectElement>(form, '[name="requestType"]')
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
    const name = requiredElement<HTMLInputElement>(form, '[name="name"]')
    const phone = requiredElement<HTMLInputElement>(form, '[name="phone"]')
    const github = requiredElement<HTMLInputElement>(form, '[name="github"]')
    await act(async () => {
      fireEvent.input(name, { target: { value: 'Example organization' } })
      fireEvent.input(phone, { target: { value: '2025550123' } })
      fireEvent.input(github, { target: { value: 'https://github.com/example/project' } })
      fireEvent.change(type, { target: { value: 'other' } })
    })
    await act(async () => {
      fireEvent.input(requiredElement(form, '[name="otherDetails"]'), {
        target: { value: 'Device integration' },
      })
      document.documentElement.lang = locale === 'zh-CN' ? 'en' : 'zh-CN'
      window.dispatchEvent(new Event('agnes:locale-changed'))
    })
    expect(code.value).toBe(locale === 'zh-CN' ? '+86' : '+1')
    expect(picker.querySelector('.ant-select-content')?.textContent?.trim()).toBe(code.value)
    expect(name.value).toBe('Example organization')
    expect(phone.value).toBe('2025550123')
    expect(github.value).toBe('https://github.com/example/project')
    expect(type.value).toBe('other')
    expect(form.querySelector<HTMLInputElement>('[name="otherDetails"]')?.value).toBe('Device integration')
    await chooseCallingCode('+44')
    await act(async () => {
      document.documentElement.lang = locale
      window.dispatchEvent(new Event('agnes:locale-changed'))
    })
    expect(code.value).toBe('+44')
    expect(picker.querySelector('.ant-select-content')?.textContent?.trim()).toBe('+44')
    expect(new FormData(form).get('callingCode')).toBe('+44')
    expect(phone.value).toBe('2025550123')
  } finally {
    await act(async () => root.unmount())
    source.dispose()
    host.remove()
    document.documentElement.lang = previousLang
  }
})
