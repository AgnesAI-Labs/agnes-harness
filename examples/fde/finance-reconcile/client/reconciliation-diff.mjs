/** Reviewed self-contained renderer. Amounts remain integer USD cents; no ledger writes here. */
export const renderers = {
  '@agnes-fde/finance-reconcile/reconciliation-diff@1'(mount, props, api) {
    const chinese = api.readLocale() === 'zh-CN'
    const heading = document.createElement('h4')
    heading.textContent = chinese ? '对账差异（美元分）' : 'Reconciliation differences (USD cents)'
    const table = document.createElement('table')
    const caption = document.createElement('caption')
    caption.textContent = heading.textContent
    table.append(caption)
    const head = document.createElement('thead')
    const labels = chinese
      ? ['交易', '银行', '账簿', '差额', '状态']
      : ['Transaction', 'Bank', 'Books', 'Delta', 'Status']
    const header = document.createElement('tr')
    for (const label of labels) {
      const th = document.createElement('th')
      th.scope = 'col'
      th.textContent = label
      header.append(th)
    }
    head.append(header)
    table.append(head)
    const body = document.createElement('tbody')
    for (const item of props.rows) {
      const row = document.createElement('tr')
      for (const [index, value] of [
        item.id,
        item.bankCents,
        item.bookCents,
        item.differenceCents,
        item.status,
      ].entries()) {
        const cell = document.createElement(index === 0 ? 'th' : 'td')
        if (index === 0) cell.scope = 'row'
        cell.textContent = value === null ? '—' : String(value)
        row.append(cell)
      }
      body.append(row)
    }
    table.append(body)
    mount.dataset.theme = api.readTheme()
    mount.replaceChildren(table)
    if (props.actionable) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = chinese ? '审阅调整' : 'Review adjustments'
      button.dataset.testid = 'reconciliation-review'
      button.addEventListener('click', () => api.emitAction('approve'))
      mount.append(button)
    }
    return () => mount.replaceChildren()
  },
}
