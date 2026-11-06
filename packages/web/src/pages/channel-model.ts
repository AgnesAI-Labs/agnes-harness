import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChannelOverview } from './channel-types.js'
import type { HomePageData } from './host.js'

export function useChannelOverview(data: HomePageData) {
  const [overview, setOverview] = useState<ChannelOverview>()
  const [error, setError] = useState(false)
  const alive = useRef(false)
  const reading = useRef(false)
  const refresh = useCallback(async () => {
    if (reading.current) return
    reading.current = true
    try {
      const value = await (data.channelCall ?? data.call)<ChannelOverview>('channels.overview', {})
      if (alive.current) {
        setOverview(value)
        setError(false)
      }
    } catch {
      if (alive.current) {
        setError(true)
      }
    } finally {
      reading.current = false
    }
  }, [data])
  useEffect(() => {
    alive.current = true
    void refresh()
    const focus = () => void refresh()
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh()
    }, 5000)
    window.addEventListener('focus', focus)
    window.addEventListener('agnes-channels-changed', focus)
    return () => {
      alive.current = false
      clearInterval(timer)
      window.removeEventListener('focus', focus)
      window.removeEventListener('agnes-channels-changed', focus)
    }
  }, [refresh])
  return { overview, error, refresh }
}
export const channelsChanged = () => window.dispatchEvent(new Event('agnes-channels-changed'))
