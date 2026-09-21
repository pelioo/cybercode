import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import {
  BACKGROUND_UPDATE_INTERVAL_MS,
  BACKGROUND_UPDATE_RESUME_STALE_MS,
  UpdateChecker,
} from './UpdateChecker'
import { useUpdateStore } from '../../stores/updateStore'

describe('UpdateChecker', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI__', {
      value: {},
      configurable: true,
    })
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    })

    useUpdateStore.setState({
      status: 'downloaded',
      availableVersion: '0.1.5',
      releaseNotes: '# CyberCode v0.1.5\n\n[Release notes](https://example.com/releases/v0.1.5)',
      progressPercent: 100,
      downloadedBytes: 2048,
      totalBytes: 2048,
      error: null,
      checkedAt: null,
      shouldPrompt: false,
      initialize: vi.fn().mockResolvedValue(undefined),
      checkForUpdates: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined),
      dismissPrompt: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initializes background update checks without rendering a popup', () => {
    const initialize = vi.fn().mockResolvedValue(undefined)
    useUpdateStore.setState({ initialize })

    render(<UpdateChecker />)

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/v0\.1\.5/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /update/i })).not.toBeInTheDocument()
  })

  it('checks again when the app regains focus after the stale interval', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'))
    const checkForUpdates = vi.fn().mockResolvedValue(null)
    useUpdateStore.setState({
      status: 'up-to-date',
      checkedAt: Date.now() - BACKGROUND_UPDATE_RESUME_STALE_MS - 1,
      initialize: vi.fn().mockResolvedValue(undefined),
      checkForUpdates,
    })

    render(<UpdateChecker />)
    act(() => window.dispatchEvent(new Event('focus')))

    expect(checkForUpdates).toHaveBeenCalledWith({ silent: true })
  })

  it('keeps checking periodically while the desktop app remains open', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'))
    const checkForUpdates = vi.fn().mockResolvedValue(null)
    useUpdateStore.setState({
      status: 'up-to-date',
      checkedAt: Date.now() - BACKGROUND_UPDATE_INTERVAL_MS,
      initialize: vi.fn().mockResolvedValue(undefined),
      checkForUpdates,
    })

    render(<UpdateChecker />)
    act(() => vi.advanceTimersByTime(BACKGROUND_UPDATE_INTERVAL_MS))

    expect(checkForUpdates).toHaveBeenCalledWith({ silent: true })
  })

  it('does not interrupt an active download when the window regains focus', () => {
    const checkForUpdates = vi.fn().mockResolvedValue(null)
    useUpdateStore.setState({
      status: 'downloading',
      checkedAt: null,
      initialize: vi.fn().mockResolvedValue(undefined),
      checkForUpdates,
    })

    render(<UpdateChecker />)
    act(() => window.dispatchEvent(new Event('focus')))

    expect(checkForUpdates).not.toHaveBeenCalled()
  })
})
