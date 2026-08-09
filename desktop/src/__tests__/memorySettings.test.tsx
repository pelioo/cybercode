import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySettings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'

const userEntry = '用户给 CyberCode/AI 取名为「零」。'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function memoryFile(
  target: 'soul' | 'brief' | 'project' | 'user',
  content = '',
  entries = content ? [content] : [],
) {
  return {
    target,
    filename: `${target.toUpperCase()}.md`,
    path: `/tmp/${target.toUpperCase()}.md`,
    exists: Boolean(content),
    content,
    entries,
    format: entries.length > 1 ? 'entries' : content ? 'plain' : 'empty',
    charCount: content.length,
    limit: 3000,
    overLimit: false,
  }
}

describe('MemorySettings evolution profile', () => {
  let userEntries: string[]
  let injectionEnabled: boolean
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    userEntries = [userEntry]
    injectionEnabled = true
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ toasts: [] })
    fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname === '/api/prompt-memory/insights') {
        return Promise.resolve(jsonResponse({
          insights: userEntries.map((raw, index) => {
            const tag = raw.match(/^\[([a-z-]+)\]\s*/)
            return {
              id: `user-${index}`,
              target: 'user',
              category: tag?.[1] ?? 'identity',
              content: raw.replace(/^\[[a-z-]+\]\s*/, ''),
              raw,
              source: 'manual',
            }
          }),
          stats: {
            total: userEntries.length,
            user: userEntries.length,
            project: 0,
            globalMethods: 0,
            methods: 0,
            dimensions: userEntries.length ? 1 : 0,
            automaticUpdates: 0,
          },
        }))
      }
      if (url.pathname === '/api/prompt-memory/logs') {
        return Promise.resolve(jsonResponse([]))
      }
      if (
        url.pathname === '/api/prompt-memory/user/entries' &&
        init?.method === 'POST'
      ) {
        const body = JSON.parse(String(init.body)) as {
          action: 'add' | 'replace' | 'remove'
          content?: string
          oldText?: string
        }
        let changed = false
        if (body.action === 'add' && body.content) {
          changed = !userEntries.includes(body.content)
          if (changed) userEntries.push(body.content)
        } else if (body.action === 'replace' && body.content && body.oldText) {
          changed = body.content !== body.oldText
          userEntries = userEntries.map(entry =>
            entry === body.oldText ? body.content! : entry,
          )
        } else if (body.action === 'remove' && body.oldText) {
          changed = userEntries.includes(body.oldText)
          userEntries = userEntries.filter(entry => entry !== body.oldText)
        }
        return Promise.resolve(jsonResponse({ changed }))
      }
      if (
        url.pathname === '/api/prompt-memory/config' &&
        init?.method === 'PATCH'
      ) {
        injectionEnabled = JSON.parse(String(init.body)).injectEvolutionMemory
        return Promise.resolve(jsonResponse({
          version: 1,
          injectEvolutionMemory: injectionEnabled,
        }))
      }
      if (url.pathname === '/api/prompt-memory') {
        return Promise.resolve(jsonResponse({
          config: {
            version: 1,
            injectEvolutionMemory: injectionEnabled,
          },
          files: {
            soul: memoryFile('soul', 'You are CyberCode.'),
            brief: memoryFile('brief'),
            project: memoryFile('project'),
            user: memoryFile(
              'user',
              userEntries.join('\n\n---\n\n'),
              userEntries,
            ),
          },
        }))
      }
      return Promise.reject(new Error(`Unexpected request: ${input}`))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  it('edits a visible profile insight without opening the raw file editor', async () => {
    render(<MemorySettings />)
    await screen.findByText(userEntry)

    fireEvent.click(screen.getByRole('button', { name: 'Edit memory' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit this memory' })
    const editor = within(dialog).getByRole('textbox', { name: 'Memory' })
    expect(editor).toHaveValue(userEntry)
    fireEvent.change(editor, {
      target: { value: '用户给 CyberCode/AI 取名为「Nova」。' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3456/api/prompt-memory/user/entries',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            action: 'replace',
            oldText: userEntry,
            content: '[identity] 用户给 CyberCode/AI 取名为「Nova」。',
          }),
        }),
      )
    })
    expect(
      await screen.findByText('用户给 CyberCode/AI 取名为「Nova」。'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('textbox', { name: 'Prompt memory editor' }),
    ).not.toBeInTheDocument()
  })

  it('adds one categorized memory from the profile', async () => {
    render(<MemorySettings />)
    await screen.findByText(userEntry)

    fireEvent.click(screen.getAllByRole('button', { name: 'Add memory' })[0]!)
    const dialog = screen.getByRole('dialog', { name: 'Add a memory' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Memory' }), {
      target: { value: '先讨论模糊的产品行为，再开始实现。' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3456/api/prompt-memory/user/entries',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            action: 'add',
            content: '[collaboration] 先讨论模糊的产品行为，再开始实现。',
          }),
        }),
      )
    })
    expect(
      await screen.findByText('先讨论模糊的产品行为，再开始实现。'),
    ).toBeInTheDocument()
  })

  it('does not report success or close the editor for a duplicate memory', async () => {
    const existing = '[collaboration] 先讨论模糊的产品行为，再开始实现。'
    userEntries = [existing]
    render(<MemorySettings />)
    await screen.findByText('先讨论模糊的产品行为，再开始实现。')

    fireEvent.click(screen.getAllByRole('button', { name: 'Add memory' })[0]!)
    const dialog = screen.getByRole('dialog', { name: 'Add a memory' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Memory' }), {
      target: { value: '先讨论模糊的产品行为，再开始实现。' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))

    expect(await within(dialog).findByText('This memory already exists.')).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
    expect(userEntries).toEqual([existing])
    expect(useUIStore.getState().toasts).not.toContainEqual(
      expect.objectContaining({ type: 'success' }),
    )
  })

  it('requires confirmation before removing a learned user memory', async () => {
    render(<MemorySettings />)
    await screen.findByText(userEntry)

    fireEvent.click(screen.getByRole('button', { name: 'Remove memory' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove this memory?' })
    expect(dialog).toHaveTextContent(userEntry)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3456/api/prompt-memory/user/entries',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ action: 'remove', oldText: userEntry }),
        }),
      )
    })
    await waitFor(() => {
      expect(screen.queryByText(userEntry)).not.toBeInTheDocument()
    })
  })

  it('can pause self-evolution memory injection without removing the profile', async () => {
    render(<MemorySettings />)
    await screen.findByText(userEntry)

    const toggle = screen.getByRole('switch', {
      name: 'Use self-evolution memory in new conversations',
    })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3456/api/prompt-memory/config',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ injectEvolutionMemory: false }),
        }),
      )
    })
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(screen.getByText(userEntry)).toBeInTheDocument()
  })
})
