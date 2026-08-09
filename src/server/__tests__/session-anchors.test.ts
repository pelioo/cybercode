/**
 * Unit tests for session user-question anchors (service + extraction rules)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionService } from '../services/sessionService.js'
import { extractUserMessageAnchors } from '../services/sessionAnchors.js'

let tmpDir: string
let service: SessionService

async function setupTmpConfigDir(): Promise<void> {
  tmpDir = path.join(os.tmpdir(), `anchors-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
}

async function cleanupTmpDir(): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
  delete process.env.CLAUDE_CONFIG_DIR
}

async function writeSessionFile(
  projectDir: string,
  sessionId: string,
  entries: Record<string, unknown>[],
): Promise<void> {
  const dir = path.join(tmpDir, 'projects', projectDir)
  await fs.mkdir(dir, { recursive: true })
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), content, 'utf-8')
}

function makeUserEntry(content: unknown, uuid?: string): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid: uuid || crypto.randomUUID(),
    timestamp: '2026-01-01T00:01:00.000Z',
    userType: 'external',
    cwd: '/tmp/test',
    sessionId: 'test-session',
  }
}

function makeAssistantEntry(content: string): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    message: { role: 'assistant', content },
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:02:00.000Z',
    sessionId: 'test-session',
  }
}

describe('extractUserMessageAnchors', () => {
  it('keeps real user text and skips notifications, commands and reminders', () => {
    const anchors = extractUserMessageAnchors([
      { id: 'u1', type: 'user', content: 'hello world', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', type: 'assistant', content: 'answer', timestamp: '2026-01-01T00:00:01.000Z' },
      { id: 'u2', type: 'user', content: '<system-reminder>secret</system-reminder>real question', timestamp: '2026-01-01T00:00:02.000Z' },
      { id: 'u3', type: 'user', content: '<system-reminder>only a reminder</system-reminder>', timestamp: '2026-01-01T00:00:03.000Z' },
      { id: 'u4', type: 'user', content: '<task-notification>done</task-notification>', timestamp: '2026-01-01T00:00:04.000Z' },
      { id: 'u5', type: 'user', content: '<command-message>init</command-message>', timestamp: '2026-01-01T00:00:05.000Z' },
      { id: 'u6', type: 'user', content: '<teammate-message teammate_id="x">hi</teammate-message>', timestamp: '2026-01-01T00:00:06.000Z' },
      { id: 'u7', type: 'user', content: [{ type: 'text', text: 'multi\nline question' }, { type: 'image', source: { data: 'x' } }], timestamp: '2026-01-01T00:00:07.000Z' },
    ])
    expect(anchors).toEqual([
      { seq: 0, messageId: 'u1', preview: 'hello world', answerPreview: 'answer' },
      { seq: 1, messageId: 'u2', preview: 'real question' },
      { seq: 2, messageId: 'u7', preview: 'multi' },
    ])
  })

  it('uses the final assistant text before the next user turn as the answer preview', () => {
    const anchors = extractUserMessageAnchors([
      { id: 'u1', type: 'user', content: 'inspect this', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', type: 'assistant', content: 'I will inspect the files.', timestamp: '2026-01-01T00:00:01.000Z' },
      { id: 't1', type: 'tool_use', content: {}, timestamp: '2026-01-01T00:00:02.000Z' },
      { id: 'a2', type: 'assistant', content: [{ type: 'text', text: '## Fixed\nDetails follow.' }], timestamp: '2026-01-01T00:00:03.000Z' },
      { id: 'u2', type: 'user', content: 'next question', timestamp: '2026-01-01T00:00:04.000Z' },
    ])

    expect(anchors[0]).toEqual({
      seq: 0,
      messageId: 'u1',
      preview: 'inspect this',
      answerPreview: 'Fixed',
    })
    expect(anchors[1]).toEqual({ seq: 1, messageId: 'u2', preview: 'next question' })
  })

  it('skips entries whose first visible line is still a tag', () => {
    const anchors = extractUserMessageAnchors([
      { id: 'u1', type: 'user', content: '<some-xml>\ntext after', timestamp: '2026-01-01T00:00:00.000Z' },
    ])
    expect(anchors).toEqual([{ seq: 0, messageId: 'u1', preview: 'text after' }])
  })
})

describe('SessionService.getSessionUserAnchors', () => {
  beforeEach(async () => {
    await setupTmpConfigDir()
    service = new SessionService()
  })

  afterEach(async () => {
    await cleanupTmpDir()
  })

  it('returns anchors for the whole transcript regardless of pagination', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const entries: Record<string, unknown>[] = []
    for (let i = 0; i < 120; i += 1) {
      entries.push(makeUserEntry(`question ${i}`, `user-uuid-${i}`))
      entries.push(makeAssistantEntry(`answer ${i}`))
    }
    await writeSessionFile('-tmp-project', sessionId, entries)

    const anchors = await service.getSessionUserAnchors(sessionId)
    expect(anchors).toHaveLength(120)
    expect(anchors[0]).toEqual({ seq: 0, messageId: 'user-uuid-0', preview: 'question 0', answerPreview: 'answer 0' })
    expect(anchors[119]).toEqual({ seq: 119, messageId: 'user-uuid-119', preview: 'question 119', answerPreview: 'answer 119' })
  })

  it('honors the projectPath locator', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-project-old', sessionId, [makeUserEntry('old question')])
    await writeSessionFile('-project-new', sessionId, [makeUserEntry('new question')])

    const anchors = await service.getSessionUserAnchors(sessionId, { projectPath: '-project-new' })
    expect(anchors.map((a) => a.preview)).toEqual(['new question'])
  })

  it('throws for a non-existent session', async () => {
    await expect(
      service.getSessionUserAnchors('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow('Session not found')
  })

  it('invalidates a cached transcript after a same-size rewrite', async () => {
    const sessionId = '11111111-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-same-size-project'
    const userId = 'same-size-user'
    await writeSessionFile(projectDir, sessionId, [makeUserEntry('first question', userId)])

    expect((await service.getSessionUserAnchors(sessionId))[0]?.preview).toBe('first question')

    await writeSessionFile(projectDir, sessionId, [makeUserEntry('other question', userId)])
    const filePath = path.join(tmpDir, 'projects', projectDir, `${sessionId}.jsonl`)
    const changedAt = new Date(Date.now() + 1000)
    await fs.utimes(filePath, changedAt, changedAt)

    expect((await service.getSessionUserAnchors(sessionId))[0]?.preview).toBe('other question')
  })

  it('does not splice cached entries into a larger full-file replacement', async () => {
    const sessionId = '22222222-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-replacement-project'
    await writeSessionFile(projectDir, sessionId, [makeUserEntry('old question', 'old-user')])
    expect((await service.getSessionUserAnchors(sessionId)).map((anchor) => anchor.preview)).toEqual([
      'old question',
    ])

    await writeSessionFile(projectDir, sessionId, [
      makeUserEntry('new first question', 'new-user-1'),
      makeAssistantEntry('new first answer'),
      makeUserEntry('new second question', 'new-user-2'),
    ])
    const filePath = path.join(tmpDir, 'projects', projectDir, `${sessionId}.jsonl`)
    const changedAt = new Date(Date.now() + 1000)
    await fs.utimes(filePath, changedAt, changedAt)

    expect((await service.getSessionUserAnchors(sessionId)).map((anchor) => anchor.preview)).toEqual([
      'new first question',
      'new second question',
    ])
  })

  it('deduplicates concurrent transcript snapshot reads', async () => {
    const sessionId = '33333333-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-snapshot-project', sessionId, [
      makeUserEntry('shared snapshot', 'snapshot-user'),
      makeAssistantEntry('shared answer'),
    ])
    const serviceInternals = service as unknown as {
      readJsonlFile: (filePath: string, maxBytes?: number) => Promise<unknown[]>
    }
    const originalRead = serviceInternals.readJsonlFile.bind(service)
    let readCount = 0
    serviceInternals.readJsonlFile = async (filePath: string, maxBytes?: number) => {
      readCount += 1
      return originalRead(filePath, maxBytes)
    }

    await Promise.all([
      service.getSessionUserAnchors(sessionId),
      service.getTranscriptMetadata(sessionId),
      service.getSessionWorkDir(sessionId),
    ])

    expect(readCount).toBe(1)
  })

  it('does not cache bytes appended after a snapshot read starts', async () => {
    const sessionId = '55555555-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-growing-snapshot-project'
    const filePath = path.join(tmpDir, 'projects', projectDir, `${sessionId}.jsonl`)
    await writeSessionFile(projectDir, sessionId, [
      makeUserEntry('first question', 'growing-user-1'),
    ])

    const serviceInternals = service as unknown as {
      readJsonlFile: (filePath: string, maxBytes?: number) => Promise<unknown[]>
    }
    const originalRead = serviceInternals.readJsonlFile.bind(service)
    let appended = false
    serviceInternals.readJsonlFile = async (targetPath: string, maxBytes?: number) => {
      if (!appended) {
        appended = true
        await fs.appendFile(
          filePath,
          `${JSON.stringify(makeUserEntry('second question', 'growing-user-2'))}\n`,
          'utf-8',
        )
      }
      return originalRead(targetPath, maxBytes)
    }

    expect((await service.getSessionUserAnchors(sessionId)).map((anchor) => anchor.preview)).toEqual([
      'first question',
    ])
    expect((await service.getSessionUserAnchors(sessionId)).map((anchor) => anchor.preview)).toEqual([
      'first question',
      'second question',
    ])
  })

  it('invalidates the anchor snapshot after trimming the transcript', async () => {
    const sessionId = '44444444-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-trim-project', sessionId, [
      makeUserEntry('keep question', 'keep-user'),
      makeAssistantEntry('keep answer'),
      makeUserEntry('remove question', 'remove-user'),
      makeAssistantEntry('remove answer'),
    ])
    expect(await service.getSessionUserAnchors(sessionId)).toHaveLength(2)

    await service.trimSessionMessagesFrom(sessionId, 'remove-user')

    expect((await service.getSessionUserAnchors(sessionId)).map((anchor) => anchor.messageId)).toEqual([
      'keep-user',
    ])
  })
})
