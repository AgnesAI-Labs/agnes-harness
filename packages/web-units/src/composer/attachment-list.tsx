import { Button } from '@agnes/web-ui'
import type { ReactNode } from 'react'
import type { ComposerDependencies } from './contracts.js'
import type { ComposerAttachment } from './image-files.js'

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
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: retain the attachment live region label. */}
      <div className="composer-image-preview-list" aria-label={hint} aria-live="polite">
        {uploads}
        {attachments.map((attachment, index) => (
          <figure
            className={attachment.type === 'image' ? 'composer-image-preview' : 'composer-file-preview'}
            key={attachment.id}
            data-testid="attachment-ready"
          >
            {attachment.type === 'image' ? (
              <img src={attachment.previewUrl} alt={t('composer.image.alt', { index: index + 1 })} />
            ) : (
              <span title={attachment.name}>{attachment.name}</span>
            )}
            {attachment.type !== 'image' ? (
              <small>{`${(attachment.size / 1024).toFixed(1)} KiB`}</small>
            ) : null}
            <Button
              htmlType="button"
              data-remove-image="true"
              data-testid="attachment-remove"
              aria-label={t('composer.attachment.remove', { index: index + 1 })}
              disabled={disabled}
              onClick={() => onRemove(attachment.id)}
            >
              {'×'}
            </Button>
          </figure>
        ))}
        {pendingCount > 0 ? (
          <span className="composer-image-pending" role="status">
            {t('composer.image.reading')}
          </span>
        ) : undefined}
      </div>
    </div>
  )
}
