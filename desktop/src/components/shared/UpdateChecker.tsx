import { useEffect } from 'react'
import { isTauriRuntime } from '../../lib/desktopRuntime'
import { useUpdateStore } from '../../stores/updateStore'

export const BACKGROUND_UPDATE_INTERVAL_MS = 30 * 60 * 1000
export const BACKGROUND_UPDATE_RESUME_STALE_MS = BACKGROUND_UPDATE_INTERVAL_MS

export function UpdateChecker() {
  const initialize = useUpdateStore((s) => s.initialize)

  useEffect(() => {
    if (!isTauriRuntime()) return

    void initialize()

    const checkIfStale = () => {
      if (document.visibilityState !== 'visible') return

      const state = useUpdateStore.getState()
      if (['checking', 'downloading', 'downloaded', 'restarting'].includes(state.status)) {
        return
      }
      if (
        state.checkedAt &&
        Date.now() - state.checkedAt < BACKGROUND_UPDATE_RESUME_STALE_MS
      ) {
        return
      }

      void state.checkForUpdates({ silent: true })
    }

    const interval = window.setInterval(checkIfStale, BACKGROUND_UPDATE_INTERVAL_MS)
    window.addEventListener('focus', checkIfStale)
    document.addEventListener('visibilitychange', checkIfStale)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', checkIfStale)
      document.removeEventListener('visibilitychange', checkIfStale)
    }
  }, [initialize])

  if (!isTauriRuntime()) return null

  return null
}
