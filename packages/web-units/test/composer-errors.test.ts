import { describe, expect, it } from 'vitest'
import { attachmentErrorMessage } from '../src/composer-errors.js'
import { webUnitsLocaleCatalog } from '../src/locales/index.js'

for (const locale of ['en', 'zh-CN'] as const)
  describe(locale, () => {
    const t = (key: string, vars?: Readonly<Record<string, string | number>>) =>
      (webUnitsLocaleCatalog[locale][key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
        String(vars?.[name] ?? name),
      )
    it.each([
      'ATTACHMENT_COUNT',
      'ATTACHMENT_DATA',
      'ATTACHMENT_NAME',
      'ATTACHMENT_BYTES',
      'PIXEL_LIMIT',
      'BYTE_LIMIT',
      'FORMAT_INVALID',
      'MIME_MISMATCH',
      'ATTACHMENT_PIXELS',
      'ATTACHMENT_MIME',
      'ATTACHMENT_HASH_MISMATCH',
      'ATTACHMENT_NOT_AUTHORIZED',
      'ATTACHMENT_MISSING',
      'ATTACHMENT_QUOTA',
      'ATTACHMENT_CANCELLED',
      'ATTACHMENT_TIMEOUT',
      'ATTACHMENT_UNAVAILABLE',
      'ATTACHMENT_TOO_LARGE',
    ])('uses the same safe translation for local and submitted %s errors', (code) => {
      const local = attachmentErrorMessage({ code, message: 'untrusted details' }, t)
      expect(local).toBeTruthy()
      expect(local).not.toContain('composer.')
      expect(local).not.toContain('untrusted')
      expect(attachmentErrorMessage({ data: { code: 'E_INVALID_PARAMS', reason: code } }, t)).toBe(local)
      expect(attachmentErrorMessage({ data: { code } }, t)).toBe(local)
      expect(attachmentErrorMessage({ code: 'E_ATTACHMENT', detail: { code } }, t)).toBe(local)
      expect(attachmentErrorMessage({ data: { code: 'E_ATTACHMENT', detail: { code } } }, t)).toBe(local)
    })
    it('preserves the caller fallback when a translation is missing', () => {
      expect(attachmentErrorMessage({ code: 'ATTACHMENT_BYTES' }, (key) => key)).toBeUndefined()
    })
    it('distinguishes image limits, malformed images and invalid MIME and does not reinterpret unknown errors', () => {
      expect(
        new Set(
          ['PIXEL_LIMIT', 'BYTE_LIMIT', 'FORMAT_INVALID', 'MIME_MISMATCH'].map((code) =>
            attachmentErrorMessage({ code }, t),
          ),
        ).size,
      ).toBe(4)
      for (const error of [
        null,
        new Error('ATTACHMENT_BYTES'),
        { code: 'toString' },
        { data: { reason: 'private bytes' } },
      ])
        expect(attachmentErrorMessage(error, t)).toBeUndefined()
    })
  })
