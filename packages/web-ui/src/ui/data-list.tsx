import type { HTMLAttributes, Key, ReactNode } from 'react'
import { ListRow, type ListRowProps } from './list-row.js'

export type DataListProps<T> = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  items: readonly T[]
  rowKey(item: T): Key
  renderRow(item: T): ListRowProps
  empty?: ReactNode
}
/** Flat detail rows with independent actions, using the shared ListRow interaction contract. */
export function DataList<T>({ items, rowKey, renderRow, empty, className, ...props }: DataListProps<T>) {
  return (
    <div {...props} className={['agh-data-list', className].filter(Boolean).join(' ')}>
      {items.length ? items.map((item) => <ListRow key={rowKey(item)} {...renderRow(item)} />) : empty}
    </div>
  )
}
