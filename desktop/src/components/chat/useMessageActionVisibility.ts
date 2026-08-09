import { useCallback, useEffect, useRef, useState } from 'react'

const ACTION_HIDE_DELAY_MS = 24

export function useMessageActionVisibility() {
  const [actionsVisible, setActionsVisible] = useState(false)
  const hideTimerRef = useRef<number | null>(null)

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }, [])

  const showActions = useCallback(() => {
    clearHideTimer()
    setActionsVisible(true)
  }, [clearHideTimer])

  const scheduleHideActions = useCallback(() => {
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      setActionsVisible(false)
    }, ACTION_HIDE_DELAY_MS)
  }, [clearHideTimer])

  const hideActions = useCallback(() => {
    clearHideTimer()
    setActionsVisible(false)
  }, [clearHideTimer])

  useEffect(() => clearHideTimer, [clearHideTimer])

  return {
    actionsVisible,
    showActions,
    scheduleHideActions,
    hideActions,
  }
}
