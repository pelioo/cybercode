import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'fs/promises'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import type { QuerySource } from '../constants/querySource.js'
import { isAutoMemoryEnabled } from '../memdir/paths.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { Tool } from '../Tool.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import {
  createCacheSafeParams,
  runForkedAgent,
} from '../utils/forkedAgent.js'
import type { REPLHookContext } from '../utils/hooks/postSamplingHooks.js'
import { createSystemMessage, createUserMessage } from '../utils/messages.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { getSettingsWithSources } from '../utils/settings/settings.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { PromptMemoryTool } from '../tools/PromptMemoryTool/PromptMemoryTool.js'
import { PROMPT_MEMORY_TOOL_NAME } from '../tools/PromptMemoryTool/constants.js'
import {
  getBriefPath,
  getProjectExperiencePath,
  getPromptMemoryDir,
  getUserPromptMemoryPath,
} from './paths.js'
import {
  collectProjectExperienceCorpus,
  type ProjectExperienceCorpus,
} from './projectCorpus.js'
import {
  readPromptMemoryFile,
  type PromptMemoryAction,
  type PromptMemoryEntryTarget,
} from './store.js'

const DEFAULT_REVIEW_INTERVAL_TURNS = 6
const DEFAULT_GLOBAL_REVIEW_INTERVAL = 5
const MIN_GLOBAL_REVIEW_PROJECTS = 1
const MIN_GLOBAL_REVIEW_ENTRIES = 3
const LOG_FILENAME = 'AUTO_REVIEW_LOG.jsonl'
const STATE_FILENAME = 'AUTO_REVIEW_STATE.json'
export const PROMPT_MEMORY_AUTO_REVIEW_TOOL_USE_ID =
  'prompt_memory_auto_review'

const EXPLICIT_MEMORY_SIGNAL =
  /(?:\bremember\b|\bforget\b|\bpreference\b|\bprefer\b|\bmy name is\b|\bcall me\b|\bcall you\b|\brespond in\b|\breply in\b|记住|记得|记忆|忘记|忘掉|以后|以后默认|默认|偏好|我喜欢|我不喜欢|我希望|每次|下次|不要再|别再|取名|新名字|名字叫|叫做|我叫|你叫|我的名字|你的名字|称呼|叫你|叫我|用中文|中文回复|中文回答|英文回复|英文回答|用英文|说中文|说英文|習慣|覚えて|忘れて|기억|잊어|선호)/i

const WORKING_STYLE_SIGNAL =
  /(?:\b(?:always|never|first discuss|plan first|before you|make sure|from now on|workflow|quality bar)\b|先讨论|先计划|先.+再|每次都|总是|不要|不能|应该|必须|起码|按这个方法|做事方式|验收标准|品質基準|まず相談|必ず|しないで|먼저 논의|항상|반드시|하지 마)/i

type ScheduledReviewTrigger = 'explicit' | 'interval'
type ReviewTrigger = ScheduledReviewTrigger | 'meta'

const MEMORY_LANGUAGE_ALIASES: Array<[RegExp, string]> = [
  [/^(?:zh|zh-cn|zh-hans|chinese|中文|简体中文)$/i, 'Simplified Chinese'],
  [/^(?:ja|jp|japanese|日本語|日文)$/i, 'Japanese'],
  [/^(?:ko|kr|korean|한국어|韩文|韓文)$/i, 'Korean'],
  [/^(?:en|en-us|english|英文)$/i, 'English'],
]

export type PromptMemoryAutoReviewLogEntry = {
  id: string
  timestamp: string
  sessionId: string
  trigger: ReviewTrigger
  target: PromptMemoryEntryTarget
  action: PromptMemoryAction
  changed: boolean
  content?: string
  oldText?: string
  message: string
}

type PendingReview = {
  context: REPLHookContext
  trigger: ScheduledReviewTrigger
}

export type PromptMemoryAutoReviewState = {
  version: 2
  periodicReviewsSinceGlobal: number
  lastReviewAt?: string
  lastGlobalReviewAt?: string
  lastGlobalCorpusFingerprint?: string
}

const DEFAULT_AUTO_REVIEW_STATE: PromptMemoryAutoReviewState = {
  version: 2,
  periodicReviewsSinceGlobal: 0,
}

let lastReviewedMessageUuid: string | undefined
let lastSeenMessageUuid: string | undefined
let turnsSinceLastReview = 0
let inProgress = false
let pendingReview: PendingReview | undefined
const inFlightReviews = new Set<Promise<void>>()

function getReviewIntervalTurns(): number {
  const raw = process.env.CYBER_PROMPT_MEMORY_REVIEW_INTERVAL
  if (!raw) return DEFAULT_REVIEW_INTERVAL_TURNS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REVIEW_INTERVAL_TURNS
}

function getMetaReviewInterval(): number {
  const raw = process.env.CYBER_PROMPT_MEMORY_META_REVIEW_INTERVAL
  if (!raw) return DEFAULT_GLOBAL_REVIEW_INTERVAL
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GLOBAL_REVIEW_INTERVAL
}

export function normalizePromptMemoryLanguage(
  language: string | undefined,
): string {
  const normalized = language?.trim()
  if (!normalized) return 'the language used by the user in the recent messages'
  return MEMORY_LANGUAGE_ALIASES.find(([pattern]) => pattern.test(normalized))?.[1]
    ?? normalized.slice(0, 80)
}

export function getConfiguredPromptMemoryLanguage(): string {
  try {
    const settings = getSettingsWithSources().effective
    return normalizePromptMemoryLanguage(
      settings.promptMemoryLanguage ?? settings.language,
    )
  } catch (error) {
    logForDebugging(
      `[prompt-memory-review] failed to load language setting: ${errorMessage(error)}`,
      { level: 'debug' },
    )
    return normalizePromptMemoryLanguage(undefined)
  }
}

function getAutoReviewLogPath(): string {
  return join(getPromptMemoryDir(), LOG_FILENAME).normalize('NFC')
}

function getAutoReviewStatePath(): string {
  return join(getPromptMemoryDir(), STATE_FILENAME).normalize('NFC')
}

function normalizeAutoReviewState(value: unknown): PromptMemoryAutoReviewState {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_AUTO_REVIEW_STATE }
  }
  const candidate = value as Partial<PromptMemoryAutoReviewState> & {
    periodicReviewsSinceMeta?: number
    projectUpdatesSinceGlobal?: number
    lastMetaReviewAt?: string
  }
  const rawReviewCount =
    candidate.periodicReviewsSinceGlobal ??
    candidate.projectUpdatesSinceGlobal ??
    candidate.periodicReviewsSinceMeta
  const periodicReviewsSinceGlobal = Number.isFinite(rawReviewCount)
    ? Math.max(0, Math.floor(rawReviewCount ?? 0))
    : 0
  return {
    version: 2,
    periodicReviewsSinceGlobal,
    ...(typeof candidate.lastReviewAt === 'string'
      ? { lastReviewAt: candidate.lastReviewAt }
      : {}),
    ...(typeof (candidate.lastGlobalReviewAt ?? candidate.lastMetaReviewAt) ===
    'string'
      ? {
          lastGlobalReviewAt:
            candidate.lastGlobalReviewAt ?? candidate.lastMetaReviewAt,
        }
      : {}),
    ...(typeof candidate.lastGlobalCorpusFingerprint === 'string'
      ? {
          lastGlobalCorpusFingerprint:
            candidate.lastGlobalCorpusFingerprint,
        }
      : {}),
  }
}

export async function readPromptMemoryAutoReviewState(
): Promise<PromptMemoryAutoReviewState> {
  try {
    return normalizeAutoReviewState(
      JSON.parse(await readFile(getAutoReviewStatePath(), 'utf-8')),
    )
  } catch {
    return { ...DEFAULT_AUTO_REVIEW_STATE }
  }
}

export async function writePromptMemoryAutoReviewState(
  state: PromptMemoryAutoReviewState,
): Promise<void> {
  const statePath = getAutoReviewStatePath()
  await mkdir(dirname(statePath), { recursive: true })
  const tmpPath = `${statePath}.tmp.${process.pid}.${randomUUID()}`
  await writeFile(
    tmpPath,
    `${jsonStringify(normalizeAutoReviewState(state), null, 2)}\n`,
    'utf-8',
  )
  try {
    await rename(tmpPath, statePath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
}

export function planPromptMemoryReview(params: {
  state: PromptMemoryAutoReviewState
  periodicReview: boolean
  projectCount: number
  projectEntryCount: number
  corpusFingerprint: string
  metaInterval?: number
  now?: string
}): {
  runGlobalReview: boolean
  nextState: PromptMemoryAutoReviewState
} {
  const state = normalizeAutoReviewState(params.state)
  const requestedMetaInterval =
    params.metaInterval ?? DEFAULT_GLOBAL_REVIEW_INTERVAL
  const metaInterval =
    Number.isFinite(requestedMetaInterval) && requestedMetaInterval > 0
      ? Math.floor(requestedMetaInterval)
      : DEFAULT_GLOBAL_REVIEW_INTERVAL
  const periodicReviewsSinceGlobal = Math.min(
    state.periodicReviewsSinceGlobal + (params.periodicReview ? 1 : 0),
    metaInterval,
  )
  const now = params.now ?? new Date().toISOString()
  const hasNewCorpus =
    params.corpusFingerprint.length > 0 &&
    params.corpusFingerprint !== state.lastGlobalCorpusFingerprint
  const runGlobalReview =
    periodicReviewsSinceGlobal >= metaInterval &&
    params.projectCount >= MIN_GLOBAL_REVIEW_PROJECTS &&
    params.projectEntryCount >= MIN_GLOBAL_REVIEW_ENTRIES &&
    hasNewCorpus

  return {
    runGlobalReview,
    nextState: {
      ...state,
      periodicReviewsSinceGlobal: runGlobalReview
        ? 0
        : periodicReviewsSinceGlobal,
      lastReviewAt: now,
      ...(runGlobalReview
        ? {
            lastGlobalReviewAt: now,
            lastGlobalCorpusFingerprint: params.corpusFingerprint,
          }
        : {}),
    },
  }
}

function isVisibleMessage(message: Message): boolean {
  return message.type === 'user' || message.type === 'assistant'
}

function getMessagesSince(
  messages: Message[],
  sinceUuid: string | undefined,
): Message[] {
  if (!sinceUuid) return messages
  const start = messages.findIndex(message => message.uuid === sinceUuid)
  if (start === -1) return messages
  return messages.slice(start + 1)
}

function countUserMessages(messages: Message[]): number {
  return messages.filter(message => message.type === 'user').length
}

function countVisibleMessages(messages: Message[]): number {
  return messages.filter(isVisibleMessage).length
}

function getUserText(message: Message): string {
  if (message.type !== 'user') return ''
  const content = (message as { message?: { content?: unknown } }).message
    ?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map(block => block.text)
    .join('\n')
}

export function hasExplicitPromptMemorySignal(messages: Message[]): boolean {
  return messages.some(message => {
    const text = getUserText(message)
    return EXPLICIT_MEMORY_SIGNAL.test(text) || WORKING_STYLE_SIGNAL.test(text)
  })
}

function getPromptMemoryToolInput(block: unknown):
  | {
      id: string
      input: Record<string, unknown>
    }
  | undefined {
  if (typeof block !== 'object' || block === null) return undefined
  const candidate = block as {
    type?: unknown
    name?: unknown
    id?: unknown
    input?: unknown
  }
  if (
    candidate.type !== 'tool_use' ||
    candidate.name !== PROMPT_MEMORY_TOOL_NAME ||
    typeof candidate.id !== 'string' ||
    typeof candidate.input !== 'object' ||
    candidate.input === null
  ) {
    return undefined
  }
  return {
    id: candidate.id,
    input: candidate.input as Record<string, unknown>,
  }
}

function hasPromptMemoryMutation(messages: Message[]): boolean {
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = (message as { message?: { content?: unknown } }).message
      ?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const toolUse = getPromptMemoryToolInput(block)
      if (!toolUse) continue
      const action = toolUse.input.action
      if (
        action === 'add' ||
        action === 'replace' ||
        action === 'remove' ||
        action === 'write'
      ) {
        return true
      }
    }
  }
  return false
}

export function shouldRunPromptMemoryAutoReview(params: {
  messages: Message[]
  sinceUuid: string | undefined
  turnsSinceLastReview: number
  intervalTurns?: number
}): {
  shouldRun: boolean
  trigger: ScheduledReviewTrigger | null
  nextTurnCount: number
} {
  const messagesSince = getMessagesSince(params.messages, params.sinceUuid)
  const newUserMessages = countUserMessages(messagesSince)
  if (newUserMessages === 0) {
    return {
      shouldRun: false,
      trigger: null,
      nextTurnCount: params.turnsSinceLastReview,
    }
  }

  if (hasExplicitPromptMemorySignal(messagesSince)) {
    return {
      shouldRun: true,
      trigger: 'explicit',
      nextTurnCount: 0,
    }
  }

  const nextTurnCount = params.turnsSinceLastReview + newUserMessages
  if (nextTurnCount >= (params.intervalTurns ?? DEFAULT_REVIEW_INTERVAL_TURNS)) {
    return {
      shouldRun: true,
      trigger: 'interval',
      nextTurnCount: 0,
    }
  }

  return {
    shouldRun: false,
    trigger: null,
    nextTurnCount,
  }
}

function formatEntries(label: string, entries: string[]): string {
  if (entries.length === 0) return `${label}: empty`
  return [
    `${label}:`,
    ...entries.map((entry, index) => `${index + 1}. ${entry}`),
  ].join('\n')
}

export function buildPromptMemoryAutoReviewPrompt(params: {
  newMessageCount: number
  trigger: ScheduledReviewTrigger
  briefEntries: string[]
  projectEntries: string[]
  userEntries: string[]
  preferredLanguage?: string
}): string {
  const preferredLanguage = normalizePromptMemoryLanguage(params.preferredLanguage)
  return [
    'You are CyberCode\'s background memory reviewer.',
    '',
    `The user-facing agent has finished its response. Analyze only the most recent ~${params.newMessageCount} visible messages above and persist durable information without involving the main task.`,
    '',
    'Current evolution-memory entries:',
    '',
    formatEntries(
      'BRIEF.md (global methods, read-only in this review)',
      params.briefEntries,
    ),
    '',
    formatEntries('PROJECT_EXPERIENCE.md', params.projectEntries),
    '',
    formatEntries('USER.md', params.userEntries),
    '',
    'Write rules:',
    '- Use the PromptMemory tool only when there is a durable memory change.',
    '- Allowed actions: add, replace, remove.',
    '- Allowed targets: project, user.',
    '- Never write or modify SOUL.md or BRIEF.md from this review.',
    '- PROJECT_EXPERIENCE.md stores reusable lessons, constraints, decisions, environment facts, and working methods for the current project only.',
    '- USER.md stores user preferences, communication style, stable personal workflow preferences, and explicit remember/forget requests.',
    '- Prefix every added or replaced entry with exactly one semantic category tag.',
    `- Write the human-readable body of every added or replaced entry in ${preferredLanguage}. Keep the semantic category tag in English exactly as specified below. Preserve technical identifiers, paths, commands, and quoted text in their original language.`,
    '- USER.md tags: [identity], [communication], [collaboration], [workflow], [quality], [boundaries], [expertise].',
    '- PROJECT_EXPERIENCE.md tags: [project-method], [environment], [lesson], [decision].',
    '- Basic user relationship facts must go in USER.md, not project memory: the user\'s preferred language, communication style, the user\'s name/nickname, and any name/nickname the user gives CyberCode/the assistant/agent.',
    '- If the user names CyberCode/the assistant/agent or says how they want to call it, save that in USER.md so every project can answer identity/name questions consistently.',
    '- A project entry must remain useful in a later conversation about this same repository. Do not save task progress, temporary plans, or facts directly derivable from current code.',
    '- Never promote a lesson directly to BRIEF.md. Cross-project promotion is handled by a separate low-frequency reviewer.',
    '- Prefer replace/remove when an existing entry is stale, wrong, or duplicated.',
    '- Keep each new entry concise, declarative, and under 220 characters.',
    '- An explicit preference, correction, or remember request may be saved immediately. An implicit habit must be supported by at least two consistent examples in the reviewed messages; one isolated choice is not a durable preference.',
    '- Do not save a generic concise or direct preference merely because the user wrote a short message. Require an explicit request or repeated evidence that clearly applies to future conversations.',
    '- Treat a correction as evidence about future collaboration only when its wording or repetition clearly generalizes beyond the current task.',
    '- Do not infer personality, motives, emotions, medical state, politics, religion, sexuality, finances, or other sensitive/private traits. Never label the user negatively.',
    '- Do not store secrets, credentials, API keys, private tokens, one-off tasks, transient plans, temporary prices, or details that are only useful inside the current conversation.',
    '',
    params.trigger === 'explicit'
      ? 'The recent user text contained an explicit memory/preference signal. Prioritize it, but still reject unsafe or temporary content.'
      : 'This is a periodic review. Be conservative; no tool call is better than low-value memory.',
    '',
    'If no update is warranted, do not call any tool. Reply exactly: No prompt-memory changes.',
  ].join('\n')
}

export function buildGlobalPromptMemoryReviewPrompt(params: {
  corpus: ProjectExperienceCorpus
  briefEntries: string[]
  preferredLanguage?: string
}): string {
  const preferredLanguage = normalizePromptMemoryLanguage(params.preferredLanguage)
  return [
    'You are CyberCode\'s cross-project experience distiller.',
    '',
    'Derive global working principles only from the project experience corpus below. Do not use recent conversation text or user preferences as evidence. Experience from one project may be sufficient when it supports a genuinely general principle.',
    '',
    formatEntries('Current BRIEF.md global methods', params.briefEntries),
    '',
    'Project experience corpus:',
    '(Project labels are anonymous and indicate distinct sources.)',
    '',
    params.corpus.content || 'empty',
    '',
    'Write rules:',
    '- Use the PromptMemory tool only when the global layer should change.',
    '- Allowed actions: add, replace, remove.',
    '- The only allowed target is brief.',
    '- Every added or replaced entry must start with [meta-method].',
    `- Write the human-readable body in ${preferredLanguage}; preserve technical identifiers and quoted text in their original language.`,
    '- A single project may support a [meta-method]. Require support from multiple durable experience entries, and prefer corroboration across projects when it is available.',
    '- For single-project evidence, apply a stricter abstraction check: the principle must still be actionable after every project-specific noun and implementation detail is removed.',
    '- The result must remain useful after project names, frameworks, paths, vendors, and product details are removed.',
    '- State when the principle applies, the preferred decision or action, and how to verify it when useful.',
    '- Do not promote environment facts, commands, repository conventions, incidents, or project-specific recipes.',
    '- Prefer one concise principle over several overlapping entries. Replace or remove stale global entries only when the project corpus provides clear evidence.',
    '- Keep each entry declarative and under 220 characters.',
    '- No tool call is better than a forced abstraction.',
    '',
    'If no update is warranted, do not call any tool. Reply exactly: No global memory changes.',
  ].join('\n')
}

function denyPromptMemoryReviewTool(tool: Tool, reason: string) {
  logForDebugging(`[prompt-memory-review] denied ${tool.name}: ${reason}`)
  return {
    behavior: 'deny' as const,
    message: reason,
    decisionReason: { type: 'other' as const, reason },
  }
}

function createPromptMemoryReviewCanUseTool(
  allowedTargets: ReadonlySet<PromptMemoryEntryTarget>,
): CanUseToolFn {
  return async (tool, input) => {
    if (tool.name !== PROMPT_MEMORY_TOOL_NAME) {
      return denyPromptMemoryReviewTool(
        tool,
        'Automatic prompt-memory review can only use the PromptMemory tool.',
      )
    }

    const action = input.action
    const target = input.target
    if (
      action === 'status' ||
      (action === 'read' &&
        typeof target === 'string' &&
        allowedTargets.has(target as PromptMemoryEntryTarget))
    ) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    if (
      (action === 'add' || action === 'replace' || action === 'remove') &&
      typeof target === 'string' &&
      allowedTargets.has(target as PromptMemoryEntryTarget)
    ) {
      return { behavior: 'allow' as const, updatedInput: input }
    }

    return denyPromptMemoryReviewTool(
      tool,
      `Automatic prompt-memory review may only modify: ${[...allowedTargets].join(', ')}.`,
    )
  }
}

function createPromptMemoryWorkerOptions(context: REPLHookContext) {
  return {
    ...context.toolUseContext.options,
    commands: [],
    tools: [PromptMemoryTool],
    mcpClients: [],
    mcpResources: {},
    refreshTools: undefined,
  }
}

function toolResultContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function safeParseToolResult(content: unknown): Record<string, unknown> | null {
  const text = toolResultContentToText(content).trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function coerceMutationAction(value: unknown): PromptMemoryAction | null {
  return value === 'add' || value === 'replace' || value === 'remove'
    ? value
    : null
}

function coerceEntryTarget(value: unknown): PromptMemoryEntryTarget | null {
  return value === 'brief' || value === 'project' || value === 'user'
    ? value
    : null
}

function truncateLogText(text: string | undefined): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed
}

export function extractPromptMemoryAutoReviewLogs(params: {
  messages: Message[]
  sessionId: string
  trigger: ReviewTrigger
}): PromptMemoryAutoReviewLogEntry[] {
  const toolInputs = new Map<string, Record<string, unknown>>()
  const entries: PromptMemoryAutoReviewLogEntry[] = []

  for (const message of params.messages) {
    if (message.type === 'assistant') {
      const content = (message as { message?: { content?: unknown } }).message
        ?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const toolUse = getPromptMemoryToolInput(block)
        if (toolUse) toolInputs.set(toolUse.id, toolUse.input)
      }
      continue
    }

    if (message.type !== 'user') continue
    const content = (message as { message?: { content?: unknown } }).message
      ?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        typeof block !== 'object' ||
        block === null ||
        (block as { type?: unknown }).type !== 'tool_result'
      ) {
        continue
      }
      const toolUseId = (block as { tool_use_id?: unknown }).tool_use_id
      if (typeof toolUseId !== 'string') continue
      const input = toolInputs.get(toolUseId)
      if (!input) continue

      const action = coerceMutationAction(input.action)
      const target = coerceEntryTarget(input.target)
      if (!action || !target) continue

      const output = safeParseToolResult((block as { content?: unknown }).content)
      if (!output || output.changed !== true) continue

      entries.push({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: params.sessionId,
        trigger: params.trigger,
        target,
        action,
        changed: true,
        content: truncateLogText(
          typeof input.content === 'string' ? input.content : undefined,
        ),
        oldText: truncateLogText(
          typeof input.oldText === 'string' ? input.oldText : undefined,
        ),
        message:
          typeof output.message === 'string'
            ? output.message
            : 'Prompt memory updated.',
      })
    }
  }

  return entries
}

export async function appendPromptMemoryAutoReviewLogs(
  entries: PromptMemoryAutoReviewLogEntry[],
): Promise<void> {
  if (entries.length === 0) return
  const logPath = getAutoReviewLogPath()
  await mkdir(dirname(logPath), { recursive: true })
  await appendFile(
    logPath,
    entries.map(entry => jsonStringify(entry)).join('\n') + '\n',
    'utf-8',
  )
}

export async function readPromptMemoryAutoReviewLogs(
  limit = 50,
): Promise<PromptMemoryAutoReviewLogEntry[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 200))
  try {
    const raw = await readFile(getAutoReviewLogPath(), 'utf-8')
    return raw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line) as PromptMemoryAutoReviewLogEntry
        } catch {
          return null
        }
      })
      .filter((entry): entry is PromptMemoryAutoReviewLogEntry => entry !== null)
      .reverse()
      .slice(0, boundedLimit)
  } catch {
    return []
  }
}

function summarizeLogEntries(entries: PromptMemoryAutoReviewLogEntry[]): string {
  if (entries.length === 0) return 'no prompt-memory changes'
  return entries
    .map(entry => `${entry.action} ${entry.target}`)
    .join(', ')
}

export function formatPromptMemoryAutoReviewNotice(
  entries: PromptMemoryAutoReviewLogEntry[],
): string | null {
  if (entries.length === 0) return null

  const parts: string[] = []
  const userCount = entries.filter(entry => entry.target === 'user').length
  const projectCount = entries.filter(entry => entry.target === 'project').length
  const globalCount = entries.filter(entry => entry.target === 'brief').length
  if (userCount > 0) parts.push(`对你的了解${userCount > 1 ? `（${userCount} 条）` : ''}`)
  if (projectCount > 0) {
    parts.push(`项目经验${projectCount > 1 ? `（${projectCount} 条）` : ''}`)
  }
  if (globalCount > 0) {
    parts.push(`全局方法${globalCount > 1 ? `（${globalCount} 条）` : ''}`)
  }
  return `自进化记忆已更新：${parts.join(' / ')}，将在新会话生效。可在「记忆」中查看和修改。`
}

async function runPromptMemoryWorker(params: {
  context: REPLHookContext
  prompt: string
  allowedTargets: ReadonlySet<PromptMemoryEntryTarget>
  trigger: ReviewTrigger
  maxTurns: number
  isolated?: boolean
}): Promise<PromptMemoryAutoReviewLogEntry[]> {
  const baseCacheParams = createCacheSafeParams(params.context)
  const cacheSafeParams = params.isolated
    ? {
        ...baseCacheParams,
        systemPrompt: asSystemPrompt([
          'You are a background memory-maintenance worker. Follow the supplied maintenance prompt and use only the provided memory tool.',
        ]),
        userContext: {},
        systemContext: {},
        forkContextMessages: [],
      }
    : baseCacheParams

  const result = await runForkedAgent({
    promptMessages: [createUserMessage({ content: params.prompt })],
    cacheSafeParams,
    canUseTool: createPromptMemoryReviewCanUseTool(params.allowedTargets),
    querySource: 'prompt_memory_review' as QuerySource,
    forkLabel:
      params.trigger === 'meta'
        ? 'prompt_memory_global_review'
        : 'prompt_memory_review',
    overrides: {
      options: createPromptMemoryWorkerOptions(params.context),
      requireCanUseTool: true,
    },
    skipTranscript: true,
    skipCacheWrite: true,
    maxTurns: params.maxTurns,
  })

  return extractPromptMemoryAutoReviewLogs({
    messages: result.messages,
    sessionId: getSessionId(),
    trigger: params.trigger,
  })
}

async function runPromptMemoryAutoReview({
  context,
  trigger,
  isTrailingRun,
}: PendingReview & { isTrailingRun?: boolean }): Promise<void> {
  const messagesSince = getMessagesSince(context.messages, lastReviewedMessageUuid)
  const newVisibleMessages = countVisibleMessages(messagesSince)
  if (newVisibleMessages === 0) return

  if (hasPromptMemoryMutation(messagesSince)) {
    const lastMessage = context.messages.at(-1)
    if (lastMessage?.uuid) lastReviewedMessageUuid = lastMessage.uuid
    logForDebugging(
      '[prompt-memory-review] skipped because the main agent already mutated prompt memory',
    )
    return
  }

  inProgress = true
  try {
    const [brief, project, user, reviewState] = await Promise.all([
      readPromptMemoryFile('brief'),
      readPromptMemoryFile('project'),
      readPromptMemoryFile('user'),
      readPromptMemoryAutoReviewState(),
    ])

    const prompt = buildPromptMemoryAutoReviewPrompt({
      newMessageCount: newVisibleMessages,
      trigger,
      briefEntries: brief.entries,
      projectEntries: project.entries,
      userEntries: user.entries,
      preferredLanguage: getConfiguredPromptMemoryLanguage(),
    })

    const primaryLogs = await runPromptMemoryWorker({
      context,
      prompt,
      allowedTargets: new Set<PromptMemoryEntryTarget>(['project', 'user']),
      trigger,
      maxTurns: 4,
    })
    await appendPromptMemoryAutoReviewLogs(primaryLogs)

    const corpus = await collectProjectExperienceCorpus()
    const reviewPlan = planPromptMemoryReview({
      state: reviewState,
      periodicReview: trigger === 'interval',
      projectCount: corpus.projectCount,
      projectEntryCount: corpus.entryCount,
      corpusFingerprint: corpus.fingerprint,
      metaInterval: getMetaReviewInterval(),
    })

    const logEntries = [...primaryLogs]
    if (reviewPlan.runGlobalReview) {
      const globalPrompt = buildGlobalPromptMemoryReviewPrompt({
        corpus,
        briefEntries: brief.entries,
        preferredLanguage: getConfiguredPromptMemoryLanguage(),
      })
      const globalLogs = await runPromptMemoryWorker({
        context,
        prompt: globalPrompt,
        allowedTargets: new Set<PromptMemoryEntryTarget>(['brief']),
        trigger: 'meta',
        maxTurns: 8,
        isolated: true,
      })
      await appendPromptMemoryAutoReviewLogs(globalLogs)
      logEntries.push(...globalLogs)
    }

    try {
      await writePromptMemoryAutoReviewState(reviewPlan.nextState)
    } catch (stateError) {
      logForDebugging(
        `[prompt-memory-review] failed to persist global-review state: ${errorMessage(stateError)}`,
        { level: 'debug' },
      )
    }

    const notice = formatPromptMemoryAutoReviewNotice(logEntries)
    if (notice) {
      context.toolUseContext.appendSystemMessage?.(
        createSystemMessage(
          notice,
          'suggestion',
          PROMPT_MEMORY_AUTO_REVIEW_TOOL_USE_ID,
        ),
      )
    }

    const lastMessage = context.messages.at(-1)
    if (lastMessage?.uuid) lastReviewedMessageUuid = lastMessage.uuid

    logForDebugging(
      `[prompt-memory-review] finished (${trigger}${reviewPlan.runGlobalReview ? ', global' : ''}${isTrailingRun ? ', trailing' : ''}): ${summarizeLogEntries(logEntries)}`,
    )
  } catch (error) {
    logForDebugging(
      `[prompt-memory-review] error: ${errorMessage(error)}`,
      { level: 'debug' },
    )
  } finally {
    inProgress = false
    const trailing = pendingReview
    pendingReview = undefined
    if (trailing) {
      await runPromptMemoryAutoReview({ ...trailing, isTrailingRun: true })
    }
  }
}

async function executePromptMemoryAutoReviewImpl(
  context: REPLHookContext,
): Promise<void> {
  if (context.toolUseContext.agentId) return
  if (context.querySource === ('prompt_memory_review' as QuerySource)) return
  if (!isAutoMemoryEnabled()) return

  const decision = shouldRunPromptMemoryAutoReview({
    messages: context.messages,
    sinceUuid: lastSeenMessageUuid,
    turnsSinceLastReview,
    intervalTurns: getReviewIntervalTurns(),
  })

  const lastMessage = context.messages.at(-1)
  if (lastMessage?.uuid) {
    lastSeenMessageUuid = lastMessage.uuid
  }

  turnsSinceLastReview = decision.nextTurnCount
  if (!decision.shouldRun || !decision.trigger) return

  if (inProgress) {
    pendingReview = { context, trigger: decision.trigger }
    return
  }

  await runPromptMemoryAutoReview({
    context,
    trigger: decision.trigger,
  })
}

export async function executePromptMemoryAutoReview(
  context: REPLHookContext,
): Promise<void> {
  const review = executePromptMemoryAutoReviewImpl(context)
  inFlightReviews.add(review)
  try {
    await review
  } finally {
    inFlightReviews.delete(review)
  }
}

export async function drainPendingPromptMemoryAutoReview(
  timeoutMs = 60_000,
): Promise<void> {
  if (inFlightReviews.size === 0) return
  await Promise.race([
    Promise.all(inFlightReviews).catch(() => {}),
    // eslint-disable-next-line no-restricted-syntax -- sleep() has no .unref(); timer must not block exit
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs).unref()),
  ])
}

export function resetPromptMemoryAutoReviewForTesting(): void {
  lastReviewedMessageUuid = undefined
  lastSeenMessageUuid = undefined
  turnsSinceLastReview = 0
  inProgress = false
  pendingReview = undefined
  inFlightReviews.clear()
}

export const promptMemoryAutoReviewPathsForTesting = {
  getAutoReviewLogPath,
  getAutoReviewStatePath,
  getBriefPath,
  getProjectExperiencePath,
  getUserPromptMemoryPath,
}
