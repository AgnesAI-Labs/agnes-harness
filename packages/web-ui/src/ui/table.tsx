import { Table as AntTable, type TableProps as AntTableProps, Tooltip as AntTooltip } from 'antd'
import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
} from 'react'
import { fallbackT } from '../locales/index.js'

export type TableProps<T extends object> = AntTableProps<T> & {
  captionRepeatsHeading?: boolean
  caption?: string
  empty?: ReactNode
  scrollLabel?: string
  testId?: string
}
const TableCaption = createContext<{
  caption: string | undefined
  testId: string | undefined
  repeats: boolean | undefined
}>({ caption: undefined, testId: undefined, repeats: undefined })
function CaptionTable({ children, ...props }: HTMLAttributes<HTMLTableElement>) {
  const { caption, testId, repeats } = useContext(TableCaption)
  return (
    <table {...props} data-testid={testId}>
      {caption && <caption data-repeats-heading={repeats || undefined}>{caption}</caption>}
      {children}
    </table>
  )
}

/** antd stamps a native title on ellipsis sortable headers; the sorter Tooltip already covers them and aria-label names them. */
function HeaderCell({ title: _title, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return <th {...props} />
}

/** Sticky, sortable antd table with an independently focusable horizontal scroll region. */
export function Table<T extends object>({
  caption,
  captionRepeatsHeading,
  empty,
  scrollLabel,
  testId,
  columns,
  className,
  ...props
}: TableProps<T>) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    for (const scrollport of root.current?.querySelectorAll<HTMLElement>(
      '.ant-table-body, .ant-table-content',
    ) ?? []) {
      scrollport.tabIndex = 0
      scrollport.setAttribute('role', 'region')
      scrollport.setAttribute('aria-label', scrollLabel ?? caption ?? fallbackT('ui.table'))
    }
  })
  const enhanced = columns?.map((column) => {
    if ('children' in column) return column
    const render = column.render
    return {
      ...column,
      ellipsis: column.ellipsis ?? { showTitle: false },
      render(value: unknown, row: T, index: number) {
        const rendered = render ? render(value, row, index) : value
        if ((typeof rendered === 'string' || typeof rendered === 'number') && column.ellipsis !== false) {
          const text = String(rendered)
          return (
            <AntTooltip title={text} rootClassName="agh-tooltip" mouseEnterDelay={0.5}>
              <span className="agh-table-cell">{text}</span>
            </AntTooltip>
          )
        }
        return rendered as ReactNode
      },
    }
  })
  return (
    <TableCaption.Provider value={{ caption, testId, repeats: captionRepeatsHeading }}>
      <div ref={root} className="agnes-intelligent-table-scroll agh-table-scroll">
        <AntTable<T>
          size="small"
          pagination={false}
          sticky={{ getContainer: () => root.current?.ownerDocument.defaultView ?? window }}
          showSorterTooltip={{ rootClassName: 'agh-tooltip' }}
          scroll={{ x: 'max-content' }}
          {...props}
          className={['agh-table', className].filter(Boolean).join(' ')}
          columns={enhanced ?? []}
          locale={{ emptyText: empty ?? <p role="status">{fallbackT('ui.tableEmpty')}</p>, ...props.locale }}
          components={{
            ...props.components,
            header: { ...props.components?.header, cell: HeaderCell },
            table: CaptionTable,
          }}
        />
      </div>
    </TableCaption.Provider>
  )
}
