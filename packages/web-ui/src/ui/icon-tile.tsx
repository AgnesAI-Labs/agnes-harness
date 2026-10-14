import { Icon } from './icon.js'
import type { IconName } from './icon-set.js'

/** The small tinted square that leads a settings row, a list row or a card header. */
export function IconTile({ name }: { name: IconName }) {
  return (
    <span className="agh-icon-tile" aria-hidden="true">
      <Icon name={name} />
    </span>
  )
}
