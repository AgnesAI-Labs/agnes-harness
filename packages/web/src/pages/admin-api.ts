import { PluginAdminApi } from '@agnes/web-admin/admin/plugins/api'
import type { AdminContext } from '@agnes/web-admin/admin/plugins/types'
import { useEffect, useState } from 'react'

export type HomeAdmin = Readonly<{ api: PluginAdminApi; context: AdminContext }>

let shared: Promise<HomeAdmin> | undefined

/** One plugin admin connection for the home pages; a failed read is retried by the next caller. */
export function homeAdmin(): Promise<HomeAdmin> {
  shared ??= PluginAdminApi.context()
    .then((context) => ({ api: new PluginAdminApi(context), context }))
    .catch((error: unknown) => {
      shared = undefined
      throw error
    })
  return shared
}

/** Whether the admin context allows an operation that changes state. */
export function canEffect(admin: HomeAdmin | undefined, permission: string): boolean {
  return (
    !!admin &&
    !admin.context.readOnly &&
    (admin.context.permissions as readonly string[]).includes(permission)
  )
}

/** The admin connection for a page: undefined while it loads, and when it is unavailable. */
export function useHomeAdmin(): HomeAdmin | undefined {
  const [admin, setAdmin] = useState<HomeAdmin>()
  useEffect(() => {
    let current = true
    void homeAdmin().then(
      (value) => {
        if (current) setAdmin(value)
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [])
  return admin
}
