import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import type { PromptMemoryInsights } from '../../api/promptMemory'
import { EvolutionProfile } from './EvolutionProfile'

const overview: PromptMemoryInsights = {
  insights: [
    {
      id: 'identity-1',
      target: 'user',
      category: 'identity',
      content: 'The user calls CyberCode Zero.',
      raw: '[identity] The user calls CyberCode Zero.',
      source: 'explicit',
    },
    {
      id: 'project-1',
      target: 'project',
      category: 'decision',
      content: 'Keep route selection in the desktop settings store.',
      raw: '[decision] Keep route selection in the desktop settings store.',
      source: 'observed',
    },
    {
      id: 'method-1',
      target: 'brief',
      category: 'meta-method',
      content: 'Discuss ambiguous product behavior before implementation.',
      raw: '[meta-method] Discuss ambiguous product behavior before implementation.',
      source: 'observed',
    },
  ],
  stats: {
    total: 3,
    user: 1,
    project: 1,
    globalMethods: 1,
    methods: 2,
    dimensions: 3,
    automaticUpdates: 3,
  },
}

describe('EvolutionProfile', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('separates user understanding, project experience, and global methods', () => {
    render(
      <EvolutionProfile
        overview={overview}
        removingId={null}
        onRemove={vi.fn()}
        onSaveEntry={vi.fn().mockResolvedValue({ ok: true })}
      />,
    )

    const userHeading = screen.getByRole('heading', { name: 'What CyberCode understands about you' })
    expect(userHeading).toBeInTheDocument()
    expect(userHeading.className).toContain('whitespace-normal')
    expect(userHeading.className).not.toContain('truncate')
    expect(screen.getByText('Current project experience')).toBeInTheDocument()
    expect(screen.getByText('Cross-project global methods')).toBeInTheDocument()
    expect(screen.getByText('Identity & names')).toBeInTheDocument()
    expect(screen.getByText('Project decision')).toBeInTheDocument()
    expect(screen.getByText('Meta method')).toBeInTheDocument()
    expect(screen.getByText('Explicit')).toBeInTheDocument()
    expect(screen.getAllByText('Repeated pattern')).toHaveLength(2)
    expect(
      screen.getAllByRole('button', { name: 'Edit memory' })[0]?.parentElement,
    ).toHaveClass(
      'opacity-0',
      'pointer-events-none',
      'group-hover:opacity-100',
      'group-hover:pointer-events-auto',
    )
  })

  it('edits one memory without opening the raw file editor', async () => {
    const onSaveEntry = vi.fn().mockResolvedValue({ ok: true })
    const onRemove = vi.fn()
    render(
      <EvolutionProfile
        overview={overview}
        removingId={null}
        onRemove={onRemove}
        onSaveEntry={onSaveEntry}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit memory' })[0]!)
    expect(screen.getByRole('dialog', { name: 'Edit this memory' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'communication' },
    })
    fireEvent.change(screen.getByLabelText('Memory'), {
      target: { value: 'The user calls CyberCode Nova.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(onSaveEntry).toHaveBeenCalledWith({
        target: 'user',
        category: 'communication',
        content: 'The user calls CyberCode Nova.',
        original: overview.insights[0],
      })
    })
    expect(screen.queryByRole('dialog', { name: 'Edit this memory' })).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove memory' })[0]!)
    expect(onRemove).toHaveBeenCalledWith(overview.insights[0])
  })

  it('adds a categorized memory from the relevant profile group', async () => {
    const onSaveEntry = vi.fn().mockResolvedValue({ ok: true })
    render(
      <EvolutionProfile
        overview={overview}
        removingId={null}
        onRemove={vi.fn()}
        onSaveEntry={onSaveEntry}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Add memory' })[0]!)
    expect(screen.getByRole('dialog', { name: 'Add a memory' })).toBeInTheDocument()
    expect(screen.getByLabelText('Category')).toHaveValue('collaboration')
    fireEvent.change(screen.getByLabelText('Memory'), {
      target: { value: 'Ask before changing an agreed product direction.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(onSaveEntry).toHaveBeenCalledWith({
        target: 'user',
        category: 'collaboration',
        content: 'Ask before changing an agreed product direction.',
        original: undefined,
      })
    })
  })

  it('defaults a new project entry to the project-method category', async () => {
    const onSaveEntry = vi.fn().mockResolvedValue({ ok: true })
    render(
      <EvolutionProfile
        overview={overview}
        removingId={null}
        onRemove={vi.fn()}
        onSaveEntry={onSaveEntry}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Add memory' })[1]!)
    expect(screen.getByLabelText('Category')).toHaveValue('project-method')
    fireEvent.change(screen.getByLabelText('Memory'), {
      target: { value: 'Keep provider state in the settings store.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(onSaveEntry).toHaveBeenCalledWith({
        target: 'project',
        category: 'project-method',
        content: 'Keep provider state in the settings store.',
        original: undefined,
      })
    })
  })

  it('keeps the focused editor open when a memory already exists', async () => {
    const onSaveEntry = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'This memory already exists.',
      })
      .mockResolvedValueOnce({ ok: true })
    render(
      <EvolutionProfile
        overview={overview}
        removingId={null}
        onRemove={vi.fn()}
        onSaveEntry={onSaveEntry}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Add memory' })[0]!)
    fireEvent.change(screen.getByLabelText('Memory'), {
      target: { value: 'The user calls CyberCode Zero.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(await screen.findByText('This memory already exists.')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Add a memory' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Memory'), {
      target: { value: 'The user prefers concise replies.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(onSaveEntry).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('dialog', { name: 'Add a memory' })).not.toBeInTheDocument()
    })
  })
})
