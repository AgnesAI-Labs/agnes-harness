import { AttachmentThumbnail, AttachmentThumbnailGroup, Button } from '@agnes/web-ui'
import type { ReactNode } from 'react'
import type { ComposerDependencies } from './contracts.js'
import type { ComposerAttachment } from './image-files.js'

/**
 * A draft image shows as a thumbnail once its bytes are local: pasted images carry them inline,
 * uploaded ones arrive as a resource link whose `previewUrl` was made from the picked file.
 * Previewing those local bytes does not depend on whether the model accepts image input. The
 * attachment's original block still determines how it is sent.
 */
const showsThumbnail = (attachment: ComposerAttachment): boolean =>
  !!attachment.previewUrl &&
  (attachment.type === 'image' ||
    attachment.mimeType?.startsWith('image/') === true ||
    (attachment.type === 'resource_link' && !!attachment.attachment?.image))

/** Draft attachments above the writing area; the list is the live region for adds and removals. */
export function ComposerAttachmentList({
  attachments,
  uploads,
  pendingCount,
  hint,
  disabled,
  onRemove,
  t,
}: {
  attachments: readonly ComposerAttachment[]
  uploads: ReactNode
  pendingCount: number
  hint: string
  disabled: boolean
  onRemove(id: string): void
  t: ComposerDependencies['translate']
}) {
  return (
    <div className="composer-image-attachments">
      {/* One preview layer for the whole draft, so the arrows move between its images. */}
      <AttachmentThumbnailGroup>
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: retain the attachment live region label. */}
        <div className="composer-image-preview-list" aria-label={hint} aria-live="polite">
          {uploads}
          {attachments.map((attachment, index) => {
            const previewSrc = showsThumbnail(attachment) ? attachment.previewUrl : undefined
            // Inline images carry no file name; the other blocks name the file.
            const fileName = attachment.type === 'image' ? undefined : attachment.name
            return (
              <figure
                className={previewSrc ? 'composer-image-preview' : 'composer-file-preview'}
                key={attachment.id}
                data-testid="attachment-ready"
              >
                {previewSrc ? (
                  <AttachmentThumbnail src={previewSrc} alt={t('composer.image.alt', { index: index + 1 })} />
                ) : (
                  <>
                    <span title={fileName}>{fileName}</span>
                    <small>{`${(attachment.size / 1024).toFixed(1)} KiB`}</small>
                  </>
                )}
                <Button
                  htmlType="button"
                  data-remove-image="true"
                  data-testid="attachment-remove"
                  aria-label={t('composer.attachment.remove', { index: index + 1 })}
                  disabled={disabled}
                  onClick={(event) => {
                    // Removing a draft must not also open the preview behind the button.
                    event.stopPropagation()
                    onRemove(attachment.id)
                  }}
                >
                  {'×'}
                </Button>
              </figure>
            )
          })}
          {pendingCount > 0 ? (
            <span className="composer-image-pending" role="status">
              {t('composer.image.reading')}
            </span>
          ) : undefined}
        </div>
      </AttachmentThumbnailGroup>
    </div>
  )
}
