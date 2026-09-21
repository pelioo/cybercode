import { api } from './client'

export type FastJudgmentStatus = {
  provider: 'reflex' | 'jev'
  enabled: boolean
  browserEnabled: boolean
  endpoint: string
  model: string
  timeoutMs: number
  hasApiKey: boolean
  stats: {
    requests: number
    cacheHits: number
    fallbacks: number
    lastLatencyMs: number | null
    lastError: string | null
  }
}

export const fastJudgmentApi = {
  status: () => api.get<FastJudgmentStatus>('/api/token-optimization/judgment'),
  save: (config: Partial<Pick<FastJudgmentStatus, 'provider' | 'enabled' | 'browserEnabled' | 'endpoint' | 'model' | 'timeoutMs'>> & { apiKey?: string }) =>
    api.post<FastJudgmentStatus>('/api/token-optimization/judgment', config),
  test: () => api.post<FastJudgmentStatus & { ok: boolean }>('/api/token-optimization/judgment/test', {}),
}
