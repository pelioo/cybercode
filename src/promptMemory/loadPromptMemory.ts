import { readFile } from 'fs/promises'
import { getSessionId } from '../bootstrap/state.js'
import type { PromptPolicyContribution } from '../constants/promptPolicy.js'
import { logForDebugging } from '../utils/debug.js'
import { isFsInaccessible } from '../utils/errors.js'
import {
  SOUL_CHAR_LIMIT,
  boundPromptMemorySet,
  boundPromptMemoryText,
} from './budget.js'
import { readPromptMemoryConfig } from './config.js'
import {
  getBriefPath,
  getProjectExperiencePath,
  getSoulPath,
  getUserPromptMemoryPath,
} from './paths.js'
import { parsePromptMemoryInsight } from './insights.js'
import { ensurePromptMemorySeed } from './seed.js'
import {
  formatPromptMemoryEntries,
  parsePromptMemoryEntries,
} from './store.js'

type PromptMemorySnapshot = {
  sessionId: string
  pending: Promise<PromptMemorySnapshotData>
}

type PromptMemorySnapshotData = {
  value: string | null
  policyContribution: PromptPolicyContribution | null
}

let cachedSnapshot: PromptMemorySnapshot | null = null

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch (error) {
    if (!isFsInaccessible(error)) {
      logForDebugging(`[prompt-memory] failed to read ${filePath}: ${error}`, {
        level: 'debug',
      })
    }
    return ''
  }
}

function splitUserPromptMemory(content: string): {
  context: string
  policyContribution: PromptPolicyContribution | null
} {
  const contextEntries: string[] = []
  const communicationInstructions: string[] = []
  const executionInstructions: string[] = []

  for (const entry of parsePromptMemoryEntries(content).entries) {
    const insight = parsePromptMemoryInsight(entry, 'user')
    switch (insight.category) {
      case 'communication':
        communicationInstructions.push(insight.content)
        break
      case 'collaboration':
      case 'workflow':
      case 'quality':
      case 'boundaries':
        executionInstructions.push(insight.content)
        break
      default:
        contextEntries.push(entry)
    }
  }

  const policyContribution =
    communicationInstructions.length > 0 || executionInstructions.length > 0
      ? {
          source: 'user-memory' as const,
          label: 'User memory',
          ...(communicationInstructions.length > 0
            ? {
                communication: {
                  instructions: communicationInstructions,
                },
              }
            : {}),
          ...(executionInstructions.length > 0
            ? { execution: { instructions: executionInstructions } }
            : {}),
        }
      : null

  return {
    context: formatPromptMemoryEntries(contextEntries).trim(),
    policyContribution,
  }
}

async function buildPromptMemorySnapshotData(): Promise<PromptMemorySnapshotData> {
  try {
    await ensurePromptMemorySeed()
  } catch (error) {
    logForDebugging(`[prompt-memory] failed to seed prompt memory: ${error}`, {
      level: 'debug',
    })
  }

  const [config, soulRaw, briefRaw, projectRaw, userRaw] = await Promise.all([
    readPromptMemoryConfig(),
    readOptionalText(getSoulPath()),
    readOptionalText(getBriefPath()),
    readOptionalText(getProjectExperiencePath()),
    readOptionalText(getUserPromptMemoryPath()),
  ])

  const soul = boundPromptMemoryText('SOUL.md', soulRaw, SOUL_CHAR_LIMIT)
  const { brief, project, user } = boundPromptMemorySet({
    brief: briefRaw,
    project: projectRaw,
    user: userRaw,
  })
  const userMemory = splitUserPromptMemory(user.content)

  const sections: string[] = []

  if (soul.content) {
    sections.push(`# CyberCode Soul\n\n${soul.content}`)
  }

  const promptMemoryBlocks: string[] = []
  if (config.injectEvolutionMemory && brief.content) {
    promptMemoryBlocks.push(`## Global Methods\n\n${brief.content}`)
  }
  if (config.injectEvolutionMemory && project.content) {
    promptMemoryBlocks.push(
      `## Current Project Experience\n\n${project.content}`,
    )
  }
  if (config.injectEvolutionMemory && userMemory.context) {
    promptMemoryBlocks.push(`## User\n\n${userMemory.context}`)
  }

  if (promptMemoryBlocks.length > 0) {
    sections.push(
      [
        '# Evolution Memory',
        '',
        'This is a read-only snapshot loaded at conversation start. Use it as background for the current task. Persistence and consolidation are handled asynchronously after completed turns.',
        '',
        ...promptMemoryBlocks,
      ].join('\n'),
    )
  }

  return {
    value: sections.length > 0 ? sections.join('\n\n') : null,
    policyContribution: config.injectEvolutionMemory
      ? userMemory.policyContribution
      : null,
  }
}

export async function buildPromptMemorySnapshot(): Promise<string | null> {
  return (await buildPromptMemorySnapshotData()).value
}

function loadPromptMemorySnapshotData(): Promise<PromptMemorySnapshotData> {
  const sessionId = getSessionId()
  if (cachedSnapshot?.sessionId === sessionId) {
    return cachedSnapshot.pending
  }

  const pending = buildPromptMemorySnapshotData()
  cachedSnapshot = { sessionId, pending }
  void pending.catch(() => {
    if (cachedSnapshot?.pending === pending) cachedSnapshot = null
  })
  return pending
}

export async function loadPromptMemory(): Promise<string | null> {
  return (await loadPromptMemorySnapshotData()).value
}

export async function loadPromptMemoryPolicyContribution(): Promise<
  PromptPolicyContribution | null
> {
  return (await loadPromptMemorySnapshotData()).policyContribution
}

export function clearPromptMemorySnapshotForTesting(): void {
  cachedSnapshot = null
}
