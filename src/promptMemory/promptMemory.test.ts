import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionId,
  regenerateSessionId,
  switchSession,
} from '../bootstrap/state.js'
import type { SessionId } from '../types/ids.js'
import {
  _resetConfigHomeDirForTesting,
  _setConfigHomeDirHomeForTesting,
} from '../utils/envUtils.js'
import {
  BRIEF_CHAR_LIMIT,
  PROJECT_EXPERIENCE_CHAR_LIMIT,
  SOUL_CHAR_LIMIT,
  USER_PROMPT_MEMORY_CHAR_LIMIT,
} from './budget.js'
import {
  DEFAULT_PROMPT_MEMORY_CONFIG,
  readPromptMemoryConfig,
  updatePromptMemoryConfig,
} from './config.js'
import {
  clearPromptMemorySnapshotForTesting,
  loadPromptMemory,
  loadPromptMemoryPolicyContribution,
} from './loadPromptMemory.js'
import {
  appendPromptMemoryAutoReviewLogs,
  buildGlobalPromptMemoryReviewPrompt,
  buildPromptMemoryAutoReviewPrompt,
  extractPromptMemoryAutoReviewLogs,
  formatPromptMemoryAutoReviewNotice,
  getConfiguredPromptMemoryLanguage,
  hasExplicitPromptMemorySignal,
  normalizePromptMemoryLanguage,
  planPromptMemoryReview,
  promptMemoryAutoReviewPathsForTesting,
  readPromptMemoryAutoReviewLogs,
  readPromptMemoryAutoReviewState,
  resetPromptMemoryAutoReviewForTesting,
  shouldRunPromptMemoryAutoReview,
  writePromptMemoryAutoReviewState,
  type PromptMemoryAutoReviewLogEntry,
} from './autoReview.js'
import {
  getBriefPath,
  getProjectExperiencePath,
  getPromptMemoryConfigPath,
  getPromptMemoryDir,
  getSoulPath,
  getUserPromptMemoryPath,
} from './paths.js'
import { collectProjectExperienceCorpus } from './projectCorpus.js'
import {
  buildPromptMemoryInsights,
  parsePromptMemoryInsight,
} from './insights.js'
import {
  PROMPT_MEMORY_ENTRY_DELIMITER,
  PromptMemoryError,
  addPromptMemoryEntry,
  formatPromptMemoryEntries,
  readPromptMemoryFile,
  removePromptMemoryEntry,
  replacePromptMemoryEntry,
  writePromptMemoryFile,
} from './store.js'
import { PromptMemoryTool } from '../tools/PromptMemoryTool/PromptMemoryTool.js'
import { PROMPT as PROMPT_MEMORY_TOOL_PROMPT } from '../tools/PromptMemoryTool/prompt.js'
import { fetchSystemPromptParts } from '../utils/queryContext.js'
import { buildReadOnlyMemoryPrompt } from '../memdir/memdir.js'
import { getAutoMemPath } from '../memdir/paths.js'
import { getAllBaseTools } from '../tools.js'
import { buildExtractAssistantDailyLogPrompt } from '../services/extractMemories/prompts.js'

const LEGACY_STATIC_POLICY_CHARACTER_COUNT = 11_899

describe('prompt memory', () => {
  let tmpRoot: string
  let tmpHome: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined
  let originalCyberConfigDir: string | undefined
  let originalClaudeConfigDir: string | undefined
  let originalSessionId: SessionId

  beforeEach(async () => {
    tmpRoot = join(tmpdir(), `cyber-prompt-memory-${randomUUID()}`)
    tmpHome = join(tmpRoot, 'home')
    await mkdir(tmpHome, { recursive: true })

    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalCyberConfigDir = process.env.CYBER_CONFIG_DIR
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalSessionId = getSessionId()

    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    delete process.env.CYBER_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR

    _setConfigHomeDirHomeForTesting(tmpHome)
    getAutoMemPath.cache.clear()
    clearPromptMemorySnapshotForTesting()
    resetPromptMemoryAutoReviewForTesting()
    regenerateSessionId()
  })

  afterEach(async () => {
    clearPromptMemorySnapshotForTesting()
    resetPromptMemoryAutoReviewForTesting()
    switchSession(originalSessionId, null)

    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome

    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile

    if (originalCyberConfigDir === undefined) delete process.env.CYBER_CONFIG_DIR
    else process.env.CYBER_CONFIG_DIR = originalCyberConfigDir

    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir

    _setConfigHomeDirHomeForTesting(undefined)
    _resetConfigHomeDirForTesting()
    getAutoMemPath.cache.clear()
    await rm(tmpRoot, { recursive: true, force: true })
  })

  test('uses cyber prompt memory paths', () => {
    expect(getSoulPath()).toBe(join(tmpHome, '.cyber', 'SOUL.md'))
    expect(getPromptMemoryDir()).toBe(
      join(tmpHome, '.cyber', 'prompt-memory'),
    )
    expect(getBriefPath()).toBe(
      join(tmpHome, '.cyber', 'prompt-memory', 'BRIEF.md'),
    )
    expect(getProjectExperiencePath()).toStartWith(
      join(tmpHome, '.cyber', 'projects'),
    )
    expect(getProjectExperiencePath()).toEndWith(
      join('memory', 'PROJECT_EXPERIENCE.md'),
    )
    expect(getUserPromptMemoryPath()).toBe(
      join(tmpHome, '.cyber', 'prompt-memory', 'USER.md'),
    )
    expect(
      promptMemoryAutoReviewPathsForTesting.getAutoReviewStatePath(),
    ).toBe(
      join(tmpHome, '.cyber', 'prompt-memory', 'AUTO_REVIEW_STATE.json'),
    )
    expect(getPromptMemoryConfigPath()).toBe(
      join(tmpHome, '.cyber', 'prompt-memory', 'config.json'),
    )
  })

  test('enables evolution-memory injection by default and persists changes', async () => {
    expect(await readPromptMemoryConfig()).toEqual(
      DEFAULT_PROMPT_MEMORY_CONFIG,
    )

    const updated = await updatePromptMemoryConfig({
      injectEvolutionMemory: false,
    })
    expect(updated.injectEvolutionMemory).toBe(false)
    expect((await readPromptMemoryConfig()).injectEvolutionMemory).toBe(false)
  })

  test('classifies tagged and legacy memories into visible evolution dimensions', () => {
    expect(
      parsePromptMemoryInsight(
        '[communication] User prefers concise Chinese replies.',
        'user',
      ),
    ).toMatchObject({
      category: 'communication',
      content: 'User prefers concise Chinese replies.',
    })
    expect(
      parsePromptMemoryInsight(
        '用户给 CyberCode 取名为「零」。',
        'user',
      ).category,
    ).toBe('identity')
    expect(
      parsePromptMemoryInsight(
        'Keep the route selector state local to this repository.',
        'project',
      ).category,
    ).toBe('project-method')
    expect(
      parsePromptMemoryInsight(
        'Always run focused tests before the production build.',
        'brief',
      ).category,
    ).toBe('meta-method')
  })

  test('builds a profile overview with provenance and method statistics', () => {
    const overview = buildPromptMemoryInsights({
      files: {
        user: {
          entries: [
            '[communication] User prefers concise Chinese replies.',
            '[quality] User expects tests and a production build before delivery.',
          ],
        },
        project: {
          entries: [
            '[decision] Keep route selection in the desktop settings store.',
          ],
        },
        brief: {
          entries: [
            '[meta-method] Discuss ambiguous product behavior before implementation.',
          ],
        },
      },
      logs: [
        {
          timestamp: '2026-07-11T00:00:30.000Z',
          trigger: 'interval',
          target: 'project',
          changed: true,
          content: '[decision] Keep route selection in the desktop settings store.',
        },
        {
          timestamp: '2026-07-11T00:00:00.000Z',
          trigger: 'explicit',
          target: 'user',
          changed: true,
          content: '[communication] User prefers concise Chinese replies.',
        },
        {
          timestamp: '2026-07-11T00:01:00.000Z',
          trigger: 'interval',
          target: 'brief',
          changed: true,
          content: '[meta-method] Discuss ambiguous product behavior before implementation.',
        },
      ],
    })

    expect(overview.stats).toEqual({
      total: 4,
      user: 2,
      project: 1,
      globalMethods: 1,
      methods: 2,
      dimensions: 4,
      automaticUpdates: 3,
    })
    expect(overview.insights).toContainEqual(
      expect.objectContaining({
        category: 'decision',
        target: 'project',
        source: 'observed',
      }),
    )
    expect(overview.insights).toContainEqual(
      expect.objectContaining({
        category: 'communication',
        source: 'explicit',
      }),
    )
    expect(overview.insights).toContainEqual(
      expect.objectContaining({
        category: 'meta-method',
        source: 'observed',
      }),
    )
    expect(overview.insights).toContainEqual(
      expect.objectContaining({
        category: 'quality',
        source: 'manual',
      }),
    )
  })

  test('seeds default SOUL.md when prompt memory files are missing', async () => {
    const prompt = await loadPromptMemory()
    const soul = await readFile(getSoulPath(), 'utf-8')

    expect(prompt).toContain('# CyberCode Soul')
    expect(prompt).toContain("You are the user's AI programming partner")
    expect(soul).toContain("You are the user's AI programming partner")
    expect(soul).not.toContain('You are CyberCode')
    expect(soul).toContain('Speak with a natural, warm voice')
    expect(soul).not.toMatch(/\b(?:coding|programming) assistant\b/i)
  })

  test('preserves an existing custom SOUL.md', async () => {
    const customSoul = 'You are CyberCode with a user-defined identity.'
    await mkdir(getPromptMemoryDir(), { recursive: true })
    await writeFile(getSoulPath(), customSoul)

    const prompt = await loadPromptMemory()

    expect(prompt).toContain(customSoul)
    await expect(readFile(getSoulPath(), 'utf-8')).resolves.toBe(customSoul)
  })

  test('separates durable user context from communication and execution policy', async () => {
    await mkdir(getPromptMemoryDir(), { recursive: true })
    await mkdir(dirname(getProjectExperiencePath()), { recursive: true })
    await writeFile(getSoulPath(), 'You are CyberCode with a calm style.')
    await writeFile(getBriefPath(), '- Verify risky changes before delivery.')
    await writeFile(getProjectExperiencePath(), '- Use Bun for this project.')
    await writeFile(
      getUserPromptMemoryPath(),
      [
        '[identity] User calls CyberCode Zero.',
        '[communication] Reply in concise Chinese.',
        '[workflow] Run an end-to-end check before delivery.',
      ].join(PROMPT_MEMORY_ENTRY_DELIMITER),
    )

    const [prompt, policyContribution] = await Promise.all([
      loadPromptMemory(),
      loadPromptMemoryPolicyContribution(),
    ])

    expect(prompt).toContain('# CyberCode Soul')
    expect(prompt).toContain('You are CyberCode with a calm style.')
    expect(prompt).toContain('# Evolution Memory')
    expect(prompt).toContain('read-only snapshot')
    expect(prompt).toContain('## Global Methods')
    expect(prompt).toContain('- Verify risky changes before delivery.')
    expect(prompt).toContain('## Current Project Experience')
    expect(prompt).toContain('- Use Bun for this project.')
    expect(prompt).toContain('## User')
    expect(prompt).toContain('[identity] User calls CyberCode Zero.')
    expect(prompt).not.toContain('Reply in concise Chinese.')
    expect(prompt).not.toContain('Run an end-to-end check before delivery.')
    expect(policyContribution).toEqual({
      source: 'user-memory',
      label: 'User memory',
      communication: {
        instructions: ['Reply in concise Chinese.'],
      },
      execution: {
        instructions: ['Run an end-to-end check before delivery.'],
      },
    })
  })

  test('can pause all evolution-memory injection without disabling SOUL or deleting memory', async () => {
    await mkdir(getPromptMemoryDir(), { recursive: true })
    await mkdir(dirname(getProjectExperiencePath()), { recursive: true })
    await writeFile(getSoulPath(), 'You are CyberCode with a calm style.')
    await writeFile(getBriefPath(), '- Verify risky changes before delivery.')
    await writeFile(getProjectExperiencePath(), '- Use Bun for this project.')
    await writeFile(getUserPromptMemoryPath(), '- User prefers Chinese.')
    await updatePromptMemoryConfig({ injectEvolutionMemory: false })

    const [prompt, policyContribution] = await Promise.all([
      loadPromptMemory(),
      loadPromptMemoryPolicyContribution(),
    ])

    expect(prompt).toContain('# CyberCode Soul')
    expect(prompt).not.toContain('# Evolution Memory')
    expect(prompt).not.toContain('- Use Bun for this project.')
    expect(prompt).not.toContain('- Verify risky changes before delivery.')
    expect(prompt).not.toContain('- User prefers Chinese.')
    expect(policyContribution).toBeNull()
    await expect(readFile(getBriefPath(), 'utf-8')).resolves.toContain(
      'Verify risky changes',
    )
    await expect(readFile(getProjectExperiencePath(), 'utf-8')).resolves.toContain(
      'Use Bun',
    )
    await expect(readFile(getUserPromptMemoryPath(), 'utf-8')).resolves.toContain(
      'prefers Chinese',
    )
  })

  test('loads prompt memory even when a custom system prompt is set', async () => {
    await mkdir(getPromptMemoryDir(), { recursive: true })
    await writeFile(getSoulPath(), 'CyberCode is named 零.')
    await writeFile(getBriefPath(), 'Prefer Bun for local scripts.')
    await writeFile(getUserPromptMemoryPath(), 'User prefers Chinese replies.')

    const { defaultSystemPrompt } = await fetchSystemPromptParts({
      tools: [],
      mainLoopModel: 'claude-test',
      additionalWorkingDirectories: [],
      mcpClients: [],
      customSystemPrompt: 'Custom behavior prompt.',
    })
    const prompt = defaultSystemPrompt.join('\n\n')

    expect(prompt).toContain('# CyberCode Soul')
    expect(prompt).toContain('CyberCode is named 零.')
    expect(prompt).toContain('# Evolution Memory')
    expect(prompt).toContain('Prefer Bun for local scripts.')
    expect(prompt).toContain('User prefers Chinese replies.')
  })

  test('assembles one canonical engineering and communication rulebook', async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'prompt-assembly-test-key'
    try {
      await mkdir(getPromptMemoryDir(), { recursive: true })
      await writeFile(
        getUserPromptMemoryPath(),
        [
          '[communication] Reply in concise Chinese.',
          '[workflow] Run an end-to-end check before delivery.',
        ].join(PROMPT_MEMORY_ENTRY_DELIMITER),
      )
      const { defaultSystemPrompt } = await fetchSystemPromptParts({
        tools: [],
        mainLoopModel: 'claude-test',
        additionalWorkingDirectories: [],
        mcpClients: [],
      })
      const prompt = defaultSystemPrompt.join('\n\n')
      const dynamicBoundaryIndex = defaultSystemPrompt.indexOf(
        '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
      )
      const staticPolicy = defaultSystemPrompt
        .slice(2, dynamicBoundaryIndex)
        .join('\n\n')

      expect(dynamicBoundaryIndex).toBeGreaterThan(2)
      expect(staticPolicy.length).toBeLessThan(
        LEGACY_STATIC_POLICY_CHARACTER_COUNT,
      )
      expect(prompt.match(/^# Engineering Execution$/gm)).toHaveLength(1)
      expect(prompt.match(/^# Communication$/gm)).toHaveLength(1)
      expect(prompt.match(/^# Active Policy Overrides$/gm)).toHaveLength(1)
      expect(prompt.match(/Reply in concise Chinese\./g)).toHaveLength(1)
      expect(
        prompt.match(/Run an end-to-end check before delivery\./g),
      ).toHaveLength(1)
      expect(prompt).not.toContain('# Agent Work Rules')
      expect(prompt).not.toContain('# Tone and style')
      expect(prompt).not.toContain('# Output efficiency')
      expect(prompt).not.toContain('Length limits:')
      expect(prompt).not.toContain(
        'the original tool result may be cleared later',
      )
    } finally {
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = originalApiKey
    }
  })

  test('freezes prompt memory for the active session', async () => {
    await mkdir(getPromptMemoryDir(), { recursive: true })
    await writeFile(getBriefPath(), 'first snapshot')

    const first = await loadPromptMemory()
    await writeFile(getBriefPath(), 'second snapshot')
    const second = await loadPromptMemory()

    expect(second).toBe(first)
    expect(second).toContain('first snapshot')
    expect(second).not.toContain('second snapshot')

    regenerateSessionId()
    const nextSession = await loadPromptMemory()
    expect(nextSession).toContain('second snapshot')
  })

  test('bounds prompt memory file sizes', async () => {
    await mkdir(getPromptMemoryDir(), { recursive: true })
    await mkdir(dirname(getProjectExperiencePath()), { recursive: true })
    await writeFile(getSoulPath(), 's'.repeat(SOUL_CHAR_LIMIT + 100))
    await writeFile(getBriefPath(), 'b'.repeat(BRIEF_CHAR_LIMIT + 100))
    await writeFile(
      getProjectExperiencePath(),
      'p'.repeat(PROJECT_EXPERIENCE_CHAR_LIMIT + 100),
    )
    await writeFile(
      getUserPromptMemoryPath(),
      'u'.repeat(USER_PROMPT_MEMORY_CHAR_LIMIT + 100),
    )

    const prompt = await loadPromptMemory()

    expect(prompt).toContain('Truncated SOUL.md')
    expect(prompt).toContain('Truncated BRIEF.md')
    expect(prompt).toContain('Truncated PROJECT_EXPERIENCE.md')
    expect(prompt).toContain('Truncated USER.md')
    expect(prompt!.length).toBeLessThan(
      SOUL_CHAR_LIMIT +
        BRIEF_CHAR_LIMIT +
        PROJECT_EXPERIENCE_CHAR_LIMIT +
        USER_PROMPT_MEMORY_CHAR_LIMIT +
        1_000,
    )
  })

  test('adds, replaces, and removes USER.md entries', async () => {
    const first = await addPromptMemoryEntry('user', 'User prefers Chinese.')
    expect(first.changed).toBe(true)
    expect(first.entryCount).toBe(1)

    const duplicate = await addPromptMemoryEntry('user', 'User prefers Chinese.')
    expect(duplicate.changed).toBe(false)
    expect(duplicate.entryCount).toBe(1)

    const second = await addPromptMemoryEntry('user', 'User likes concise replies.')
    expect(second.entryCount).toBe(2)
    await expect(readFile(getUserPromptMemoryPath(), 'utf-8')).resolves.toContain(
      PROMPT_MEMORY_ENTRY_DELIMITER,
    )

    const replaced = await replacePromptMemoryEntry(
      'user',
      'concise',
      'User likes concise Chinese replies.',
    )
    expect(replaced.entries).toContain('User likes concise Chinese replies.')

    const removed = await removePromptMemoryEntry('user', 'prefers Chinese')
    expect(removed.entries).toEqual(['User likes concise Chinese replies.'])
  })

  test('stores current-project experience outside global prompt memory', async () => {
    const result = await addPromptMemoryEntry(
      'project',
      '[project-method] Keep provider state in the settings store.',
    )

    expect(result.changed).toBe(true)
    expect(result.path).toBe(getProjectExperiencePath())
    await expect(
      readFile(getProjectExperiencePath(), 'utf-8'),
    ).resolves.toContain('[project-method]')
    await expect(readFile(getBriefPath(), 'utf-8')).rejects.toThrow()
  })

  test('prefers an exact entry match over another entry that contains it', async () => {
    const exact = '[workflow] Run focused tests.'
    const containing = '[lesson] Before release: [workflow] Run focused tests.'
    await addPromptMemoryEntry('brief', exact)
    await addPromptMemoryEntry('brief', containing)

    const replaced = await replacePromptMemoryEntry(
      'brief',
      exact,
      '[workflow] Run focused tests and a production build.',
    )

    expect(replaced.entries).toEqual([
      '[workflow] Run focused tests and a production build.',
      containing,
    ])
    const removed = await removePromptMemoryEntry('brief', containing)
    expect(removed.entries).toEqual([
      '[workflow] Run focused tests and a production build.',
    ])
  })

  test('merges an edited entry instead of creating a duplicate', async () => {
    await addPromptMemoryEntry('user', '[workflow] Run tests before delivery.')
    await addPromptMemoryEntry('user', '[quality] Verify before delivery.')

    const result = await replacePromptMemoryEntry(
      'user',
      '[workflow] Run tests before delivery.',
      '[quality] Verify before delivery.',
    )

    expect(result.changed).toBe(true)
    expect(result.entries).toEqual(['[quality] Verify before delivery.'])
    expect(result.message).toContain('merged')
  })

  test('cleans exact duplicate entries during a targeted removal', async () => {
    const duplicate = '[communication] Reply concisely.'
    await mkdir(getPromptMemoryDir(), { recursive: true })
    await writeFile(
      getUserPromptMemoryPath(),
      formatPromptMemoryEntries([duplicate, duplicate]),
    )

    const result = await removePromptMemoryEntry('user', duplicate)

    expect(result.entries).toEqual([])
  })

  test('treats plain BRIEF.md text as one entry before normalizing mutations', async () => {
    await mkdir(getPromptMemoryDir(), { recursive: true })
    await writeFile(getBriefPath(), 'Plain existing note.')

    const before = await readPromptMemoryFile('brief')
    expect(before.format).toBe('plain')
    expect(before.entries).toEqual(['Plain existing note.'])

    await addPromptMemoryEntry('brief', 'Second note.')
    const raw = await readFile(getBriefPath(), 'utf-8')
    expect(raw).toContain(PROMPT_MEMORY_ENTRY_DELIMITER)
  })

  test('does not allow entry mutations for SOUL.md', async () => {
    await expect(
      addPromptMemoryEntry('soul', 'Change identity.'),
    ).rejects.toBeInstanceOf(PromptMemoryError)
  })

  test('writes SOUL.md explicitly with limit enforcement', async () => {
    const file = await writePromptMemoryFile(
      'soul',
      'You are CyberCode with a quiet engineering voice.',
    )
    expect(file.content).toBe('You are CyberCode with a quiet engineering voice.')

    await expect(
      writePromptMemoryFile('soul', 's'.repeat(SOUL_CHAR_LIMIT + 1)),
    ).rejects.toBeInstanceOf(PromptMemoryError)
  })

  test('detects explicit prompt-memory signals and interval review triggers', () => {
    const firstUserMessage = {
      type: 'user',
      uuid: 'u1',
      message: { content: '以后默认用中文回复我。' },
    } as any
    const secondUserMessage = {
      type: 'user',
      uuid: 'u2',
      message: { content: '普通问题' },
    } as any

    expect(hasExplicitPromptMemorySignal([firstUserMessage])).toBe(true)
    expect(
      hasExplicitPromptMemorySignal([
        {
          type: 'user',
          uuid: 'u-name',
          message: { content: '我现在给你取一个新名字，叫做零。' },
        } as any,
      ]),
    ).toBe(true)
    expect(
      hasExplicitPromptMemorySignal([
        {
          type: 'user',
          uuid: 'u-working-style',
          message: { content: '这种产品逻辑先讨论，不要直接修改。' },
        } as any,
      ]),
    ).toBe(true)
    expect(
      hasExplicitPromptMemorySignal([
        {
          type: 'user',
          uuid: 'u-user-name',
          message: { content: '我叫王小明。' },
        } as any,
      ]),
    ).toBe(true)
    expect(
      hasExplicitPromptMemorySignal([
        {
          type: 'user',
          uuid: 'u-agent-name',
          message: { content: '你叫零。' },
        } as any,
      ]),
    ).toBe(true)
    expect(
      hasExplicitPromptMemorySignal([
        {
          type: 'user',
          uuid: 'u-language',
          message: { content: '中文回答。' },
        } as any,
      ]),
    ).toBe(true)

    expect(
      shouldRunPromptMemoryAutoReview({
        messages: [secondUserMessage],
        sinceUuid: undefined,
        turnsSinceLastReview: 1,
        intervalTurns: 3,
      }),
    ).toEqual({
      shouldRun: false,
      trigger: null,
      nextTurnCount: 2,
    })

    expect(
      shouldRunPromptMemoryAutoReview({
        messages: [secondUserMessage],
        sinceUuid: undefined,
        turnsSinceLastReview: 2,
        intervalTurns: 3,
      }),
    ).toEqual({
      shouldRun: true,
      trigger: 'interval',
      nextTurnCount: 0,
    })

    expect(
      shouldRunPromptMemoryAutoReview({
        messages: [firstUserMessage, secondUserMessage],
        sinceUuid: 'u1',
        turnsSinceLastReview: 1,
        intervalTurns: 3,
      }),
    ).toEqual({
      shouldRun: false,
      trigger: null,
      nextTurnCount: 2,
    })
  })

  test('reviews ordinary prompt memory every six user messages by default', () => {
    const ordinaryUserMessage = {
      type: 'user',
      uuid: 'u-ordinary',
      message: { content: '帮我解释这个函数。' },
    } as any

    expect(
      shouldRunPromptMemoryAutoReview({
        messages: [ordinaryUserMessage],
        sinceUuid: undefined,
        turnsSinceLastReview: 4,
      }),
    ).toEqual({
      shouldRun: false,
      trigger: null,
      nextTurnCount: 5,
    })

    expect(
      shouldRunPromptMemoryAutoReview({
        messages: [ordinaryUserMessage],
        sinceUuid: undefined,
        turnsSinceLastReview: 5,
      }),
    ).toEqual({
      shouldRun: true,
      trigger: 'interval',
      nextTurnCount: 0,
    })
  })

  test('schedules global distillation every five periodic reviews with reusable project evidence', () => {
    let state = {
      version: 2 as const,
      periodicReviewsSinceGlobal: 0,
    }

    for (let review = 1; review <= 4; review++) {
      const plan = planPromptMemoryReview({
        state,
        periodicReview: true,
        projectCount: 1,
        projectEntryCount: 3,
        corpusFingerprint: 'corpus-v1',
        now: `2026-07-${String(review).padStart(2, '0')}T00:00:00.000Z`,
      })
      expect(plan.runGlobalReview).toBe(false)
      expect(plan.nextState.periodicReviewsSinceGlobal).toBe(review)
      state = plan.nextState
    }

    const globalPlan = planPromptMemoryReview({
      state,
      periodicReview: true,
      projectCount: 1,
      projectEntryCount: 3,
      corpusFingerprint: 'corpus-v1',
      now: '2026-07-05T00:00:00.000Z',
    })
    expect(globalPlan.runGlobalReview).toBe(true)
    expect(globalPlan.nextState.periodicReviewsSinceGlobal).toBe(0)
    expect(globalPlan.nextState.lastGlobalCorpusFingerprint).toBe('corpus-v1')
    expect(globalPlan.nextState.lastGlobalReviewAt).toBe(
      '2026-07-05T00:00:00.000Z',
    )

    const missingProjectEvidence = planPromptMemoryReview({
      state,
      periodicReview: true,
      projectCount: 0,
      projectEntryCount: 8,
      corpusFingerprint: 'corpus-v1',
      now: '2026-07-06T00:00:00.000Z',
    })
    expect(missingProjectEvidence.runGlobalReview).toBe(false)
    expect(missingProjectEvidence.nextState.periodicReviewsSinceGlobal).toBe(5)

    const explicitReview = planPromptMemoryReview({
      state: {
        version: 2,
        periodicReviewsSinceGlobal: 2,
      },
      periodicReview: false,
      projectCount: 4,
      projectEntryCount: 20,
      corpusFingerprint: 'corpus-v1',
    })
    expect(explicitReview.nextState.periodicReviewsSinceGlobal).toBe(2)

    const unchangedCorpus = planPromptMemoryReview({
      state: {
        version: 2,
        periodicReviewsSinceGlobal: 5,
        lastGlobalCorpusFingerprint: 'corpus-v1',
      },
      periodicReview: true,
      projectCount: 4,
      projectEntryCount: 20,
      corpusFingerprint: 'corpus-v1',
    })
    expect(unchangedCorpus.runGlobalReview).toBe(false)
    expect(unchangedCorpus.nextState.periodicReviewsSinceGlobal).toBe(5)
  })

  test('persists the global-review cadence and migrates the legacy state', async () => {
    await writePromptMemoryAutoReviewState({
      version: 2,
      periodicReviewsSinceGlobal: 4,
      lastReviewAt: '2026-07-04T00:00:00.000Z',
    })

    expect(await readPromptMemoryAutoReviewState()).toEqual({
      version: 2,
      periodicReviewsSinceGlobal: 4,
      lastReviewAt: '2026-07-04T00:00:00.000Z',
    })

    await writeFile(
      promptMemoryAutoReviewPathsForTesting.getAutoReviewStatePath(),
      JSON.stringify({
        version: 1,
        periodicReviewsSinceMeta: 3,
        lastMetaReviewAt: '2026-06-01T00:00:00.000Z',
      }),
    )
    expect(await readPromptMemoryAutoReviewState()).toEqual({
      version: 2,
      periodicReviewsSinceGlobal: 3,
      lastGlobalReviewAt: '2026-06-01T00:00:00.000Z',
    })
  })

  test('builds an ordinary background review prompt limited to project and user memory', () => {
    const prompt = buildPromptMemoryAutoReviewPrompt({
      newMessageCount: 2,
      trigger: 'explicit',
      briefEntries: ['[meta-method] Verify risky changes before delivery.'],
      projectEntries: ['[environment] Use Bun for local scripts.'],
      userEntries: ['User prefers Chinese.'],
      preferredLanguage: 'Chinese',
    })

    expect(prompt).toContain('PromptMemory tool')
    expect(prompt).toContain('Allowed targets: project, user.')
    expect(prompt).toContain('Never write or modify SOUL.md or BRIEF.md')
    expect(prompt).toContain('BRIEF.md (global methods, read-only')
    expect(prompt).toContain('PROJECT_EXPERIENCE.md')
    expect(prompt).toContain('Basic user relationship facts')
    expect(prompt).toContain('save that in USER.md')
    expect(prompt).toContain('[project-method]')
    expect(prompt).toContain('Never promote a lesson directly to BRIEF.md')
    expect(prompt).toContain('at least two consistent examples')
    expect(prompt).toContain('Do not infer personality')
    expect(prompt).toContain('User prefers Chinese.')
    expect(prompt).toContain('human-readable body')
    expect(prompt).toContain('Simplified Chinese')
    expect(prompt).toContain('semantic category tag in English')
    expect(prompt).toContain('generic concise or direct preference')
  })

  test('builds an isolated global prompt that accepts one project corpus', () => {
    const prompt = buildGlobalPromptMemoryReviewPrompt({
      corpus: {
        projects: [
          {
            projectKey: 'alpha',
            path: '/memory/alpha/PROJECT_EXPERIENCE.md',
            entries: [
              '[lesson] Run focused tests after shared-state changes.',
              '[decision] Verify the production build after UI changes.',
              '[project-method] Check shared-state behavior before release.',
            ],
            updatedAtMs: 2,
          },
        ],
        projectCount: 1,
        entryCount: 3,
        content: '## Project 1\n1. Run focused tests.\n2. Verify the build.\n3. Check shared-state behavior.',
        fingerprint: 'corpus-v1',
      },
      briefEntries: [
        '[meta-method] Preserve a focused verification loop.',
      ],
      preferredLanguage: 'Chinese',
    })

    expect(prompt).toContain('cross-project experience distiller')
    expect(prompt).toContain('only allowed target is brief')
    expect(prompt).toContain('A single project may support a [meta-method]')
    expect(prompt).toContain('stricter abstraction check')
    expect(prompt).toContain('Do not use recent conversation text')
    expect(prompt).toContain('[meta-method]')
    expect(prompt).toContain('## Project 1')
    expect(prompt).toContain('Project labels are anonymous')
  })

  test('collects bounded project experience from distinct repositories', async () => {
    const currentPath = getProjectExperiencePath()
    const otherPath = join(
      tmpHome,
      '.cyber',
      'projects',
      'other-repository',
      'memory',
      'PROJECT_EXPERIENCE.md',
    )
    await mkdir(dirname(currentPath), { recursive: true })
    await mkdir(dirname(otherPath), { recursive: true })
    await writeFile(
      currentPath,
      formatPromptMemoryEntries([
        '[lesson] Verify shared-state changes with a focused test.',
        '[decision] Keep provider state in one store.',
        '[environment] Local checkout lives at /private/project/path.',
      ]),
    )
    await writeFile(
      otherPath,
      formatPromptMemoryEntries([
        '[lesson] Verify shared-state changes with a focused test.',
      ]),
    )

    const corpus = await collectProjectExperienceCorpus()

    expect(corpus.projectCount).toBe(2)
    expect(corpus.entryCount).toBe(3)
    expect(corpus.fingerprint).toHaveLength(64)
    expect(corpus.content).toContain('## Project 1')
    expect(corpus.content).not.toContain('other-repository')
    expect(corpus.content).not.toContain('/private/project/path')
    expect(corpus.content).toContain('Verify shared-state changes')
  })

  test('keeps persistent-memory writes out of the main agent', () => {
    const prompt = buildReadOnlyMemoryPrompt({
      memoryDirs: ['/tmp/cyber-memory'],
    })

    expect(prompt).toContain('read-only, potentially stale task context')
    expect(prompt).toContain('asynchronous memory maintenance')
    expect(prompt.length).toBeLessThan(400)
    expect(prompt).not.toContain('How to save memories')
    expect(getAllBaseTools().map(tool => tool.name)).not.toContain(
      'PromptMemory',
    )
  })

  test('moves KAIROS daily-log write instructions into the background worker', () => {
    const prompt = buildExtractAssistantDailyLogPrompt(
      4,
      '',
      '/tmp/cyber-memory/logs/2026/08/2026-08-09.md',
    )

    expect(prompt).toContain('memory extraction subagent')
    expect(prompt).toContain('long-lived assistant session')
    expect(prompt).toContain('/tmp/cyber-memory/logs/2026/08/2026-08-09.md')
    expect(prompt).toContain('Do not edit MEMORY.md')
  })

  test('normalizes supported UI languages for automatic memory writing', () => {
    expect(normalizePromptMemoryLanguage('English')).toBe('English')
    expect(normalizePromptMemoryLanguage('Chinese')).toBe('Simplified Chinese')
    expect(normalizePromptMemoryLanguage('Japanese')).toBe('Japanese')
    expect(normalizePromptMemoryLanguage('Korean')).toBe('Korean')
    expect(normalizePromptMemoryLanguage(undefined)).toContain('recent messages')
  })

  test('reads the automatic memory language from the current settings file', async () => {
    const configDir = join(tmpHome, '.cyber')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({
        language: 'English',
        promptMemoryLanguage: 'Chinese',
      }),
      'utf-8',
    )

    expect(getConfiguredPromptMemoryLanguage()).toBe('Simplified Chinese')
  })

  test('PromptMemory tool guides the assistant to acknowledge naturally', async () => {
    expect(PROMPT_MEMORY_TOOL_PROMPT).toContain(
      'respond to the user like a person',
    )
    expect(PROMPT_MEMORY_TOOL_PROMPT).toContain(
      'Do not say "I wrote it to memory"',
    )
    expect(PROMPT_MEMORY_TOOL_PROMPT).toContain('[meta-method]')
    expect(PROMPT_MEMORY_TOOL_PROMPT).toContain('PROJECT_EXPERIENCE.md')
    expect(PROMPT_MEMORY_TOOL_PROMPT).toContain('One project may provide enough evidence')
    expect(PROMPT_MEMORY_TOOL_PROMPT).toContain('implicit preferences need repeated')

    const result = await PromptMemoryTool.call({
      action: 'add',
      target: 'user',
      content: '用户给 CyberCode 取名为「零」。',
    } as any)

    expect(result.data.message).toBe('Saved.')
    expect(result.data.assistantGuidance).toContain('acknowledge naturally')
    expect(result.data.assistantGuidance).toContain('Do not mention PromptMemory')
    expect(result.data.assistantGuidance).toContain('好，我叫零')
  })

  test('extracts changed PromptMemory tool results into auto-review logs', () => {
    const assistantMessage = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'PromptMemory',
            input: {
              action: 'add',
              target: 'user',
              content: 'User prefers concise Chinese replies.',
            },
          },
        ],
      },
    } as any
    const toolResultMessage = {
      type: 'user',
      uuid: 'u1',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: JSON.stringify({
              success: true,
              changed: true,
              message: 'Entry added. It will affect future conversations.',
            }),
          },
        ],
      },
    } as any

    const logs = extractPromptMemoryAutoReviewLogs({
      messages: [assistantMessage, toolResultMessage],
      sessionId: 'session-1',
      trigger: 'explicit',
    })

    expect(logs).toHaveLength(1)
    expect(logs[0]!.target).toBe('user')
    expect(logs[0]!.action).toBe('add')
    expect(logs[0]!.content).toBe('User prefers concise Chinese replies.')
  })

  test('writes and reads auto-review logs newest first', async () => {
    const entries: PromptMemoryAutoReviewLogEntry[] = [
      {
        id: 'one',
        timestamp: '2026-06-10T00:00:00.000Z',
        sessionId: 's1',
        trigger: 'explicit',
        target: 'user',
        action: 'add',
        changed: true,
        content: 'User prefers Chinese.',
        message: 'Entry added.',
      },
      {
        id: 'two',
        timestamp: '2026-06-10T00:01:00.000Z',
        sessionId: 's1',
        trigger: 'interval',
        target: 'project',
        action: 'add',
        changed: true,
        content: 'Use Bun for local scripts.',
        message: 'Entry added.',
      },
      {
        id: 'three',
        timestamp: '2026-06-10T00:02:00.000Z',
        sessionId: 's1',
        trigger: 'meta',
        target: 'brief',
        action: 'add',
        changed: true,
        content: 'Verify risky changes before delivery.',
        message: 'Entry added.',
      },
    ]

    await appendPromptMemoryAutoReviewLogs(entries)

    const logs = await readPromptMemoryAutoReviewLogs(1)
    expect(logs).toHaveLength(1)
    expect(logs[0]!.id).toBe('three')
  })

  test('formats a compact auto-review notice for changed prompt memory', () => {
    const notice = formatPromptMemoryAutoReviewNotice([
      {
        id: 'one',
        timestamp: '2026-06-10T00:00:00.000Z',
        sessionId: 's1',
        trigger: 'explicit',
        target: 'user',
        action: 'add',
        changed: true,
        content: 'User prefers Chinese.',
        message: 'Entry added.',
      },
      {
        id: 'two',
        timestamp: '2026-06-10T00:01:00.000Z',
        sessionId: 's1',
        trigger: 'interval',
        target: 'project',
        action: 'add',
        changed: true,
        content: 'Use Bun for local scripts.',
        message: 'Entry added.',
      },
      {
        id: 'three',
        timestamp: '2026-06-10T00:02:00.000Z',
        sessionId: 's1',
        trigger: 'meta',
        target: 'brief',
        action: 'add',
        changed: true,
        content: 'Verify risky changes before delivery.',
        message: 'Entry added.',
      },
    ])

    expect(notice).toBe(
      '自进化记忆已更新：对你的了解 / 项目经验 / 全局方法，将在新会话生效。可在「记忆」中查看和修改。',
    )
    expect(formatPromptMemoryAutoReviewNotice([])).toBeNull()
  })
})
