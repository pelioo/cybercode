export type PromptPolicySource =
  | 'model'
  | 'user-memory'
  | 'optimization'
  | 'output-style'

export type CommunicationVerbosity =
  | 'adaptive'
  | 'concise'
  | 'compressed'

export type ImplementationDiscipline = 'standard' | 'strict'

export type PromptPolicyContribution = {
  source: PromptPolicySource
  label: string
  communication?: {
    verbosity?: CommunicationVerbosity
    maxUpdateWords?: number
    maxFinalWords?: number
    instructions?: string[]
  }
  execution?: {
    discipline?: ImplementationDiscipline
    instructions?: string[]
  }
}

export type ModelPolicyPatch = {
  id: string
  topic: 'communication' | 'execution'
  appliesTo: string
  reason: string
  expiresWhen: string
  contribution: PromptPolicyContribution
}

type ResolvedInstruction = {
  source: PromptPolicySource
  label: string
  text: string
}

export type ResolvedPromptPolicy = {
  communication: {
    verbosity: CommunicationVerbosity
    maxUpdateWords?: number
    maxFinalWords?: number
    instructions: ResolvedInstruction[]
  }
  execution: {
    discipline: ImplementationDiscipline
    instructions: ResolvedInstruction[]
  }
}

const SOURCE_PRIORITY: Record<PromptPolicySource, number> = {
  model: 10,
  'user-memory': 20,
  optimization: 30,
  'output-style': 40,
}

export const ANT_NUMERIC_LENGTH_PATCH: ModelPolicyPatch = {
  id: 'ant-numeric-length-anchors',
  topic: 'communication',
  appliesTo: 'USER_TYPE=ant',
  reason:
    'Numeric anchors reduce unnecessary output while retaining explicit exceptions for tasks that need detail.',
  expiresWhen:
    'Remove when cross-model communication evaluations show no benefit over the adaptive base policy.',
  contribution: {
    source: 'model',
    label: 'Ant model profile',
    communication: {
      verbosity: 'concise',
      maxUpdateWords: 25,
      maxFinalWords: 100,
    },
  },
}

export function getModelPolicyContributions(
  userType: string | undefined,
): PromptPolicyContribution[] {
  return userType === 'ant' ? [ANT_NUMERIC_LENGTH_PATCH.contribution] : []
}

function rankedContributions(
  contributions: readonly (PromptPolicyContribution | null | undefined)[],
): PromptPolicyContribution[] {
  return contributions
    .filter(
      (contribution): contribution is PromptPolicyContribution =>
        contribution !== null && contribution !== undefined,
    )
    .map((contribution, index) => ({ contribution, index }))
    .sort(
      (left, right) =>
        SOURCE_PRIORITY[right.contribution.source] -
          SOURCE_PRIORITY[left.contribution.source] ||
        left.index - right.index,
    )
    .map(({ contribution }) => contribution)
}

function collectInstructions(
  contributions: readonly PromptPolicyContribution[],
  topic: 'communication' | 'execution',
): ResolvedInstruction[] {
  const seen = new Set<string>()
  const instructions: ResolvedInstruction[] = []

  for (const contribution of contributions) {
    const values = contribution[topic]?.instructions ?? []
    for (const value of values) {
      const text = value.trim()
      const key = text.replace(/\s+/g, ' ').toLowerCase()
      if (!text || seen.has(key)) continue
      seen.add(key)
      instructions.push({
        source: contribution.source,
        label: contribution.label,
        text,
      })
    }
  }

  return instructions
}

export function resolvePromptPolicy(
  values: readonly (PromptPolicyContribution | null | undefined)[],
): ResolvedPromptPolicy {
  const contributions = rankedContributions(values)
  let verbosity: CommunicationVerbosity = 'adaptive'
  let discipline: ImplementationDiscipline = 'standard'
  let maxUpdateWords: number | undefined
  let maxFinalWords: number | undefined
  let hasVerbosity = false
  let hasDiscipline = false

  for (const contribution of contributions) {
    const communication = contribution.communication
    if (communication) {
      if (!hasVerbosity && communication.verbosity) {
        verbosity = communication.verbosity
        hasVerbosity = true
      }
      if (
        maxUpdateWords === undefined &&
        communication.maxUpdateWords !== undefined
      ) {
        maxUpdateWords = communication.maxUpdateWords
      }
      if (
        maxFinalWords === undefined &&
        communication.maxFinalWords !== undefined
      ) {
        maxFinalWords = communication.maxFinalWords
      }
    }

    const execution = contribution.execution
    if (!hasDiscipline && execution?.discipline) {
      discipline = execution.discipline
      hasDiscipline = true
    }
  }

  return {
    communication: {
      verbosity,
      ...(maxUpdateWords !== undefined ? { maxUpdateWords } : {}),
      ...(maxFinalWords !== undefined ? { maxFinalWords } : {}),
      instructions: collectInstructions(contributions, 'communication'),
    },
    execution: {
      discipline,
      instructions: collectInstructions(contributions, 'execution'),
    },
  }
}

export function renderCommunicationPolicySection(): string {
  return [
    '# Communication',
    '',
    '- Lead with the answer, action, or decision. Keep simple answers short; add detail when complexity, ambiguity, safety, or the user requires it.',
    '- Write for a person rather than a console. Use complete, direct sentences without filler, repeated conclusions, unexplained shorthand, or unnecessary process narration.',
    '- Before the first tool call, briefly state what you are about to do. During longer work, update the user only at meaningful milestones, discoveries, direction changes, or blockers.',
    '- Prefer flowing prose for explanations. Use lists or tables only when they make short facts, choices, or results easier to scan.',
    '- Do not use emojis unless the user asks for them.',
    '- Reference code as file_path:line_number and GitHub work as owner/repo#123 when those formats are applicable.',
    '- Do not introduce a tool call with a colon; tool calls may be hidden from the user.',
  ].join('\n')
}

function renderInstructionGroup(
  title: string,
  instructions: readonly ResolvedInstruction[],
): string[] {
  if (instructions.length === 0) return []
  return [
    `### ${title}`,
    ...instructions.map(instruction =>
      instruction.text.includes('\n')
        ? `${instruction.label}:\n${instruction.text}`
        : `- ${instruction.label}: ${instruction.text}`,
    ),
  ]
}

export function renderActivePolicyOverrides(
  contributions: readonly (PromptPolicyContribution | null | undefined)[],
): string | null {
  const resolved = resolvePromptPolicy(contributions)
  const communicationLines: string[] = []
  const executionLines: string[] = []

  if (resolved.communication.verbosity === 'compressed') {
    communicationLines.push(
      '- Compression mode is active: omit filler, hedging, restatement, and repeated conclusions while preserving exact technical data and normal artifact formats. Expand for ambiguity, requested detail, safety, irreversible actions, or ordered procedures.',
    )
  } else if (
    resolved.communication.verbosity === 'concise' &&
    resolved.communication.maxUpdateWords === undefined &&
    resolved.communication.maxFinalWords === undefined
  ) {
    communicationLines.push(
      '- Concise mode is active: prefer the shortest response that remains clear and complete.',
    )
  }

  if (
    resolved.communication.maxUpdateWords !== undefined ||
    resolved.communication.maxFinalWords !== undefined
  ) {
    const limits = [
      resolved.communication.maxUpdateWords !== undefined
        ? `text between tool calls to at most ${resolved.communication.maxUpdateWords} words`
        : null,
      resolved.communication.maxFinalWords !== undefined
        ? `final responses to at most ${resolved.communication.maxFinalWords} words`
        : null,
    ].filter((value): value is string => value !== null)
    communicationLines.push(
      `- As a default length anchor, keep ${limits.join(' and ')}. Higher-priority user or output-style requests, correctness, and necessary detail override these anchors.`,
    )
  }

  if (resolved.execution.discipline === 'strict') {
    executionLines.push(
      '- Strict implementation discipline is active: reuse existing helpers, platform features, standard libraries, and installed dependencies before adding code; avoid speculative scope, scaffolding, and unrelated refactors; preserve validation, security, accessibility, and data-loss safeguards; add the smallest useful regression check.',
    )
  }

  const communicationInstructions = renderInstructionGroup(
    'Communication Deltas',
    resolved.communication.instructions,
  )
  const executionInstructions = renderInstructionGroup(
    'Execution Deltas',
    resolved.execution.instructions,
  )
  const hasCommunication =
    communicationLines.length > 0 || communicationInstructions.length > 0
  const hasExecution =
    executionLines.length > 0 || executionInstructions.length > 0

  if (!hasCommunication && !hasExecution) return null

  return [
    '# Active Policy Overrides',
    '',
    'These are deltas to the canonical rules, not a second rulebook. Resolve conflicts in this order: the current user request, the selected output style, active optimization modes, durable user preferences, model-specific patches, then defaults. No override may weaken safety, correctness, or truthful verification.',
    ...(hasCommunication
      ? [
          '',
          '## Communication',
          ...communicationLines,
          ...communicationInstructions,
        ]
      : []),
    ...(hasExecution
      ? ['', '## Engineering Execution', ...executionLines, ...executionInstructions]
      : []),
  ].join('\n')
}
