/** @vitest-environment happy-dom */
import { type ContentBlock, USER_MESSAGE_ATTACHMENT_LIMITS } from '@agnes/protocol'
import { attachmentErrorMessage } from '@agnes/web-units'
import { describe, expect, it } from 'vitest'
import { createSubmissionController } from '../src/app/submission-controller.js'
import { enT, zhT } from './helpers/locale.js'

describe('composer submission validation', () => {
  it.each([
    [enT, 'A message can hold at most 50 attachments.'],
    [zhT, '一条消息最多添加 50 个附件。'],
  ] as const)(
    'keeps the draft and reports a real validator refusal in the interface language',
    (t, message) => {
      const attachments: ContentBlock[] = Array.from(
        { length: USER_MESSAGE_ATTACHMENT_LIMITS.maxCount + 1 },
        () => ({ type: 'file', name: 'fixture.txt', mimeType: 'text/plain', data: 'eA==' }),
      )
      let draft = 'keep this draft'
      let sent = false
      let refusal: string | undefined
      const context = {
        current: {
          id: 'fixture-session',
          prompt: async () => {
            sent = true
          },
        },
        composerRuntime: {
          getDraft: () => draft,
          setDraft: (value: string) => {
            draft = value
          },
          getAttachmentBlocks: () => attachments,
          hasPendingImages: () => false,
          clearImageBlocks: () => {
            attachments.length = 0
          },
        },
        references: { getSnapshot: () => [] },
        configured: true,
        connected: true,
        sending: false,
        stopping: false,
        sessionPending: false,
        sessionYoloEnabled: false,
        selectedModelAvailable: () => true,
        runtimeModels: [],
        t,
        showError: (error: unknown) => {
          refusal = attachmentErrorMessage(error, t)
        },
      } as unknown as Parameters<typeof createSubmissionController>[0]
      createSubmissionController(context).submitComposer()
      expect(sent).toBe(false)
      expect(draft).toBe('keep this draft')
      expect(attachments).toHaveLength(USER_MESSAGE_ATTACHMENT_LIMITS.maxCount + 1)
      expect(refusal).toBe(message)
    },
  )
})
