import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./components/layout/AppShell', () => ({
  AppShell: () => <div data-testid="app-shell" />,
}))

vi.mock('./components/shared/UpdateChecker', () => ({
  UpdateChecker: () => <div data-testid="update-checker" />,
}))

import { App } from './App'

describe('App', () => {
  it('mounts the background updater with the main desktop shell', () => {
    render(<App />)

    expect(screen.getByTestId('update-checker')).toBeInTheDocument()
    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
  })
})
