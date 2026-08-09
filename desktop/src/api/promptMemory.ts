import { api } from './client'

export type PromptMemoryTarget = 'soul' | 'brief' | 'project' | 'user'
export type PromptMemoryFormat = 'empty' | 'plain' | 'entries'

export type PromptMemoryFile = {
  target: PromptMemoryTarget
  filename: string
  path: string
  exists: boolean
  content: string
  entries: string[]
  format: PromptMemoryFormat
  charCount: number
  limit: number
  overLimit: boolean
}

export type PromptMemoryConfig = {
  version: 1
  injectEvolutionMemory: boolean
  updatedAt?: string
}

export type PromptMemoryStatus = {
  files: Record<PromptMemoryTarget, PromptMemoryFile>
  config: PromptMemoryConfig
}

export type PromptMemoryMutationResult = {
  target: Exclude<PromptMemoryTarget, 'soul'>
  path: string
  action: 'add' | 'replace' | 'remove'
  changed: boolean
  message: string
  entries: string[]
  entryCount: number
  charCount: number
  limit: number
  overLimit: boolean
}

type PromptMemoryStatusResponse = Omit<PromptMemoryStatus, 'config'> & {
  config?: PromptMemoryConfig
}

const DEFAULT_PROMPT_MEMORY_CONFIG: PromptMemoryConfig = {
  version: 1,
  injectEvolutionMemory: true,
}

export type PromptMemoryAutoReviewLogEntry = {
  id: string
  timestamp: string
  sessionId: string
  trigger: 'explicit' | 'interval' | 'meta'
  target: Exclude<PromptMemoryTarget, 'soul'>
  action: 'add' | 'replace' | 'remove'
  changed: boolean
  content?: string
  oldText?: string
  message: string
}

export type PromptMemoryInsightCategory =
  | 'identity'
  | 'communication'
  | 'collaboration'
  | 'workflow'
  | 'quality'
  | 'boundaries'
  | 'expertise'
  | 'project-method'
  | 'decision'
  | 'meta-method'
  | 'environment'
  | 'lesson'
  | 'other'

export type PromptMemoryInsight = {
  id: string
  target: 'user' | 'project' | 'brief'
  category: PromptMemoryInsightCategory
  content: string
  raw: string
  source: 'explicit' | 'observed' | 'manual'
  updatedAt?: string
}

export type PromptMemoryInsights = {
  insights: PromptMemoryInsight[]
  stats: {
    total: number
    user: number
    project: number
    globalMethods: number
    methods: number
    dimensions: number
    automaticUpdates: number
  }
}

export const promptMemoryApi = {
  status: async (): Promise<PromptMemoryStatus> => {
    const status = await api.get<PromptMemoryStatusResponse>('/api/prompt-memory')
    return {
      ...status,
      config: status.config ?? DEFAULT_PROMPT_MEMORY_CONFIG,
    }
  },

  logs: (limit = 20) =>
    api.get<PromptMemoryAutoReviewLogEntry[]>(`/api/prompt-memory/logs?limit=${limit}`),

  insights: () =>
    api.get<PromptMemoryInsights>('/api/prompt-memory/insights'),

  updateConfig: (injectEvolutionMemory: boolean) =>
    api.patch<PromptMemoryConfig>('/api/prompt-memory/config', {
      injectEvolutionMemory,
    }),

  read: (target: PromptMemoryTarget) =>
    api.get<PromptMemoryFile>(`/api/prompt-memory/${target}`),

  write: (target: PromptMemoryTarget, content: string) =>
    api.put<PromptMemoryFile>(`/api/prompt-memory/${target}`, { content }),

  addEntry: (target: Exclude<PromptMemoryTarget, 'soul'>, content: string) =>
    api.post<PromptMemoryMutationResult>(`/api/prompt-memory/${target}/entries`, {
      action: 'add',
      content,
    }),

  replaceEntry: (
    target: Exclude<PromptMemoryTarget, 'soul'>,
    oldText: string,
    content: string,
  ) =>
    api.post<PromptMemoryMutationResult>(`/api/prompt-memory/${target}/entries`, {
      action: 'replace',
      oldText,
      content,
    }),

  removeEntry: (target: Exclude<PromptMemoryTarget, 'soul'>, oldText: string) =>
    api.post<PromptMemoryMutationResult>(`/api/prompt-memory/${target}/entries`, {
      action: 'remove',
      oldText,
    }),
}
