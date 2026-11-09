import { Button, Icon, IconTile, useUiText } from '@agnes/web-ui'
import { exploreCapabilitiesCatalog } from './explore-capabilities-locale.js'

export function ExploreCapabilities({ hidden, onContact }: { hidden: boolean; onContact: () => void }) {
  const { t } = useUiText('@agnes/web/explore-capabilities', exploreCapabilitiesCatalog)
  return (
    <section
      className="explore-capabilities mhs-slide"
      id="explore-slide-1"
      aria-labelledby="explore-capabilities-title"
      hidden={hidden}
    >
      <header className="explore-capabilities-heading">
        <div>
          <h2 id="explore-capabilities-title">{t('title')}</h2>
          <p>{t('lead')}</p>
        </div>
        <span>{t('billing')}</span>
      </header>
      <div className="explore-capability-grid">
        {(
          [
            ['maas', 'bot'],
            ['sandbox', 'terminal'],
            ['search', 'search'],
            ['memory', 'archive'],
          ] as const
        ).map(([id, icon]) => (
          <article className="explore-capability-card" key={id} aria-labelledby={`explore-${id}-title`}>
            <div className="explore-capability-header">
              <IconTile name={icon} />
              <span>{t(`${id}.category`)}</span>
            </div>
            <div className="explore-capability-content">
              <h3 id={`explore-${id}-title`}>{t(`${id}.title`)}</h3>
              <p>{t(`${id}.copy`)}</p>
              <Button
                appearance="secondary"
                htmlType="button"
                aria-label={`${t('contact')} · ${t(`${id}.title`)}`}
                onClick={onContact}
              >
                {t('contact')} <Icon name="arrow-up" className="explore-capability-arrow" />
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
