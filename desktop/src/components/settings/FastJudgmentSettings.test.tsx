import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fastJudgmentApi, type FastJudgmentStatus } from '../../api/fastJudgment'
import { useSettingsStore } from '../../stores/settingsStore'
import { openExternalUrl } from '../../lib/openExternalUrl'
import { FastJudgmentSettings } from './FastJudgmentSettings'

vi.mock('../../api/fastJudgment', () => ({ fastJudgmentApi: { status: vi.fn(), save: vi.fn(), test: vi.fn() } }))
vi.mock('../../lib/openExternalUrl', () => ({ openExternalUrl: vi.fn() }))
const status: FastJudgmentStatus = {
  provider: 'jev', enabled: false, browserEnabled: false, endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', timeoutMs: 800, hasApiKey: false,
  stats: { requests: 0, cacheHits: 0, fallbacks: 0, lastLatencyMs: null, lastError: null },
}
beforeEach(() => {
  vi.resetAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  vi.mocked(fastJudgmentApi.status).mockResolvedValue(status)
  vi.mocked(openExternalUrl).mockResolvedValue(undefined)
})

describe('fast judgment settings', () => {
  it('keeps browser acceleration off by default and saves its independent switch', async () => {
    vi.mocked(fastJudgmentApi.status).mockResolvedValue({ ...status, enabled: true, hasApiKey: true })
    vi.mocked(fastJudgmentApi.save).mockResolvedValue({ ...status, enabled: true, hasApiKey: true, browserEnabled: true })
    render(<FastJudgmentSettings pruningEnabled={false} />)
    const browser = screen.getByRole('switch', { name: 'Enable browser task acceleration' })
    await waitFor(() => expect(browser).not.toBeDisabled())
    expect(browser).not.toBeChecked()
    fireEvent.click(browser)
    await waitFor(() => expect(fastJudgmentApi.save).toHaveBeenCalledWith({ browserEnabled: true }))
    expect(browser).toBeChecked()
  })

  it('shows the local default and switches to Jev with its saved configuration', async () => {
    vi.mocked(fastJudgmentApi.status).mockResolvedValue({ ...status, provider: 'reflex', model: 'Qwen/Qwen3.5-4B', endpoint: 'http://127.0.0.1:8008/v1/systemone' })
    vi.mocked(fastJudgmentApi.save).mockResolvedValue({ ...status, hasApiKey: true })
    render(<FastJudgmentSettings pruningEnabled />)
    const select = screen.getByRole('combobox', { name: 'Judgment model' })
    await waitFor(() => expect(select).not.toBeDisabled())
    expect(select).toHaveValue('reflex')
    expect(screen.queryByRole('link', { name: 'Get an API key ↗' })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enable fast judgment' })).not.toBeDisabled()
    expect(screen.getByText(/Start Reflex on this machine/)).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'jev' } })
    await waitFor(() => expect(select).toHaveValue('jev'))
    expect(fastJudgmentApi.save).toHaveBeenCalledWith({ provider: 'jev' })
    expect(screen.getByLabelText('Model')).toHaveValue('jev-latest')
    expect(screen.getByRole('switch', { name: 'Enable fast judgment' })).not.toBeChecked()
    const keyLink = screen.getByRole('link', { name: 'Get an API key ↗' })
    expect(keyLink).toHaveAttribute('href', 'https://console.typesafe.ai/keys')
    fireEvent.click(keyLink)
    expect(openExternalUrl).toHaveBeenCalledWith('https://console.typesafe.ai/keys')
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'custom' } })
    expect(select).toBeDisabled()
  })

  it('shows the official key URL if opening the browser fails', async () => {
    vi.mocked(openExternalUrl).mockRejectedValue(new Error('Browser unavailable'))
    render(<FastJudgmentSettings pruningEnabled />)
    fireEvent.click(await screen.findByRole('link', { name: 'Get an API key ↗' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('https://console.typesafe.ai/keys')
    expect(fastJudgmentApi.save).not.toHaveBeenCalled()
  })

  it('saves the key without enabling automatically, clears input, then enables explicitly', async () => {
    vi.mocked(fastJudgmentApi.save).mockResolvedValue({ ...status, hasApiKey: true })
    render(<FastJudgmentSettings pruningEnabled={false} />)
    const save = await screen.findByRole('button', { name: 'Save' })
    await waitFor(() => expect(screen.getByLabelText('API Key')).not.toBeDisabled())
    expect(screen.getByRole('switch', { name: 'Enable fast judgment' })).toBeDisabled()
    expect(screen.getByText(/Enable Smart pruning above/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'test-private-key' } })
    fireEvent.click(save)
    await screen.findByText('Settings saved')
    expect(fastJudgmentApi.save).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-private-key' }))
    expect(vi.mocked(fastJudgmentApi.save).mock.calls[0]?.[0]).not.toHaveProperty('enabled')
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    vi.mocked(fastJudgmentApi.save).mockResolvedValue({ ...status, hasApiKey: true, enabled: true })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable fast judgment' }))
    await waitFor(() => expect(fastJudgmentApi.save).toHaveBeenLastCalledWith({ enabled: true }))
  })

  it('tests the saved configuration and shows measured latency', async () => {
    vi.mocked(fastJudgmentApi.status).mockResolvedValue({ ...status, hasApiKey: true })
    vi.mocked(fastJudgmentApi.test).mockResolvedValue({ ...status, hasApiKey: true, ok: true, stats: { ...status.stats, lastLatencyMs: 123 } })
    render(<FastJudgmentSettings pruningEnabled />)
    const button = screen.getByRole('button', { name: 'Test saved connection' })
    await waitFor(() => expect(button).not.toBeDisabled())
    fireEvent.click(button)
    expect(await screen.findByText('Connected · 123 ms')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'another-model' } })
    expect(button).toBeDisabled()
  })

  it('can explicitly remove a stored credential and handles a failed test', async () => {
    vi.mocked(fastJudgmentApi.status).mockResolvedValue({ ...status, hasApiKey: true })
    vi.mocked(fastJudgmentApi.save).mockResolvedValue(status)
    vi.mocked(fastJudgmentApi.test).mockResolvedValue({ ...status, ok: false })
    render(<FastJudgmentSettings pruningEnabled />)
    fireEvent.click(await screen.findByLabelText('Remove saved key'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Settings saved')
    expect(fastJudgmentApi.save).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: '' }))
    fireEvent.click(screen.getByRole('button', { name: 'Test saved connection' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection failed')
  })
})
