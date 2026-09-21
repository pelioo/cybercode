import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

export type ChoiceQuestion = {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}
export type ChoiceAnswer = {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}
export type JudgmentRequest = {
  state: unknown
  questions: Record<string, ChoiceQuestion>
}
export type JudgmentResult = {
  answers: Record<string, ChoiceAnswer> | null
  source: 'network' | 'cache' | 'fallback'
}
export type JudgmentBackend = 'reflex' | 'jev'
export type FastJudgmentConfig = {
  provider: JudgmentBackend
  enabled: boolean
  browserEnabled: boolean
  endpoint: string
  model: string
  apiKey: string
  timeoutMs: number
}
export type FastJudgmentStatus = Omit<FastJudgmentConfig, 'apiKey'> & {
  hasApiKey: boolean
  stats: {
    requests: number
    cacheHits: number
    fallbacks: number
    lastLatencyMs: number | null
    lastError: string | null
  }
}

const DEFAULT_CONFIG: FastJudgmentConfig = {
  provider: 'reflex',
  enabled: false,
  browserEnabled: false,
  endpoint: 'http://127.0.0.1:8008/v1/systemone',
  model: 'Qwen/Qwen3.5-4B',
  apiKey: '',
  timeoutMs: 800,
}
const PROVIDER_DEFAULTS: Record<JudgmentBackend, FastJudgmentConfig> = {
  reflex: DEFAULT_CONFIG,
  jev: { ...DEFAULT_CONFIG, provider: 'jev', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
}
const CACHE_TTL_MS = 5 * 60_000
const MAX_CACHE_ENTRIES = 128

// The rest of CyberCode depends on this contract, not a chat-model SDK.
export interface JudgmentProvider {
  evaluate(config: FastJudgmentConfig, request: JudgmentRequest, signal: AbortSignal): Promise<unknown>
}

export class JevProvider implements JudgmentProvider {
  async evaluate(config: FastJudgmentConfig, request: JudgmentRequest, signal: AbortSignal) {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ ...request, model: config.model }),
      signal,
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`Judgment service HTTP ${response.status}`)
    return response.json()
  }
}

// Reflex implements the same typed, non-generative System One wire protocol.
export class ReflexProvider extends JevProvider {}

export class FastJudgmentService {
  private configSignature = ''
  private cache = new Map<string, { expiresAt: number; answers: Record<string, ChoiceAnswer> }>()
  private cooldownUntil = 0
  private failures = 0
  private stats: FastJudgmentStatus['stats'] = {
    requests: 0, cacheHits: 0, fallbacks: 0, lastLatencyMs: null, lastError: null,
  }

  private providers = { jev: new JevProvider(), reflex: new ReflexProvider() }

  constructor(private provider?: JudgmentProvider) {}

  getStatus(): FastJudgmentStatus {
    const { apiKey, ...config } = this.readConfig()
    return { ...config, hasApiKey: Boolean(apiKey), stats: { ...this.stats } }
  }

  updateConfig(patch: Record<string, unknown>): FastJudgmentStatus {
    const current = this.readConfig()
    const provider = patch.provider ?? current.provider
    if (provider !== 'reflex' && provider !== 'jev') throw new Error('Invalid judgment provider')
    const profiles = this.readProfiles()
    profiles[current.provider] = current
    const switching = provider !== current.provider
    const base = switching ? (profiles[provider] ?? PROVIDER_DEFAULTS[provider]) : current
    // Switching services is saved immediately, but enablement is always explicit.
    const next = validateConfig({ ...base, ...(switching ? { enabled: false } : {}), ...patch })
    // Never forward an existing credential to a newly selected host.
    if (new URL(next.endpoint).origin !== new URL(base.endpoint).origin && patch.apiKey === undefined) next.apiKey = ''
    const configPath = this.getConfigPath()
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${configPath}.tmp.${randomUUID()}`
    try {
      profiles[next.provider] = next
      fs.writeFileSync(temporaryPath, JSON.stringify({ ...next, profiles }, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(temporaryPath, configPath)
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
    }
    return this.getStatus()
  }

  async decide(request: JudgmentRequest, signal?: AbortSignal, probe = false): Promise<JudgmentResult> {
    const config = this.readConfig()
    const fallback = (): JudgmentResult => {
      this.stats.fallbacks++
      return { answers: null, source: 'fallback' }
    }
    if (signal?.aborted || (!config.enabled && !probe)) return { answers: null, source: 'fallback' }
    if (!config.apiKey && new URL(config.endpoint).hostname === 'api.typesafe.ai') {
      this.stats.lastError = 'API_KEY_REQUIRED'
      return fallback()
    }
    const body = JSON.stringify(request)
    if (body.length > 80_000 || Object.keys(request.questions).length === 0 || Object.keys(request.questions).length > 16) {
      this.stats.lastError = 'REQUEST_TOO_LARGE'
      return fallback()
    }
    const key = createHash('sha256').update(this.configSignature).update(body).digest('hex')
    const cached = this.cache.get(key)
    if (!probe && cached && cached.expiresAt > Date.now()) {
      this.stats.cacheHits++
      return { answers: cached.answers, source: 'cache' }
    }
    if (!probe && Date.now() < this.cooldownUntil) return fallback()

    const started = performance.now()
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, config.timeoutMs)
    const signature = this.configSignature
    this.stats.requests++
    try {
      // Race as well as abort: even a provider that ignores AbortSignal cannot
      // hold the main model request past this deadline.
      const response = await Promise.race([
        (this.provider ?? this.providers[config.provider]).evaluate(config, request, controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('JUDGMENT_ABORTED')), { once: true })
          if (controller.signal.aborted) reject(new Error('JUDGMENT_ABORTED'))
        }),
      ])
      const answers = validateAnswers(response, request.questions)
      this.readConfig()
      if (signature !== this.configSignature || signal?.aborted) return fallback()
      this.failures = 0
      this.cooldownUntil = 0
      this.stats.lastError = null
      if (!probe) {
        this.cache.delete(key)
        if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(key, { answers, expiresAt: Date.now() + CACHE_TTL_MS })
      }
      return { answers, source: 'network' }
    } catch {
      if (!signal?.aborted && signature === this.configSignature) {
        this.stats.lastError = controller.signal.aborted ? 'TIMEOUT' : 'INVALID_RESPONSE_OR_UNAVAILABLE'
        if (++this.failures >= 3) this.cooldownUntil = Date.now() + 30_000
      }
      return fallback()
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      this.stats.lastLatencyMs = Math.round(performance.now() - started)
    }
  }

  async testConnection() {
    const result = await this.decide({
      state: 'The build completed successfully.',
      questions: {
        result: { type: 'choice', instructions: 'What is the build outcome?', criteria: { success: 'Completed successfully', failure: 'Failed' } },
      },
    }, undefined, true)
    return { ok: result.answers !== null, ...this.getStatus() }
  }

  private getConfigPath() {
    return path.join(getClaudeConfigHomeDir(), 'cybercode', 'fast-judgment.json')
  }

  private readProfiles(): Partial<Record<JudgmentBackend, FastJudgmentConfig>> {
    const result: Partial<Record<JudgmentBackend, FastJudgmentConfig>> = {}
    try {
      const saved = JSON.parse(fs.readFileSync(this.getConfigPath(), 'utf8'))
      for (const provider of ['reflex', 'jev'] as const) {
        try {
          const profile = validateConfig({ browserEnabled: false, ...saved.profiles?.[provider] })
          if (profile.provider === provider) result[provider] = profile
        } catch { /* Ignore invalid inactive profiles. */ }
      }
    } catch { /* No saved profiles yet. */ }
    return result
  }

  private readConfig(): FastJudgmentConfig {
    let config = { ...DEFAULT_CONFIG }
    try {
      const { profiles: _profiles, ...saved } = JSON.parse(fs.readFileSync(this.getConfigPath(), 'utf8'))
      // Existing installations explicitly saved a Jev configuration before providers existed.
      config = validateConfig({ provider: 'jev', browserEnabled: false, ...saved })
    } catch {
      // A missing or invalid configuration must never block normal inference.
    }
    const signature = createHash('sha256').update(this.getConfigPath()).update(JSON.stringify(config)).digest('hex')
    if (signature !== this.configSignature) {
      this.configSignature = signature
      this.cache.clear()
      this.failures = 0
      this.cooldownUntil = 0
      this.stats.lastError = null
    }
    return config
  }
}

function validateConfig(value: unknown): FastJudgmentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid judgment settings')
  const config = value as Record<string, unknown>
  const allowed = Object.keys(DEFAULT_CONFIG)
  if (Object.keys(config).some(key => !allowed.includes(key))) throw new Error('Unknown judgment setting')
  if (config.provider !== 'reflex' && config.provider !== 'jev') throw new Error('Invalid judgment provider')
  if (typeof config.browserEnabled !== 'boolean') throw new Error('Invalid browser enabled setting')
  if (typeof config.enabled !== 'boolean') throw new Error('Invalid enabled setting')
  if (typeof config.endpoint !== 'string' || config.endpoint.length > 2048) throw new Error('Invalid endpoint')
  let endpoint: URL
  try { endpoint = new URL(config.endpoint) } catch { throw new Error('Invalid endpoint') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))) {
    throw new Error('Use HTTPS, or HTTP on localhost, without credentials or query parameters')
  }
  if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 200) throw new Error('Invalid model')
  if (typeof config.apiKey !== 'string' || config.apiKey.length > 4096 || /[\r\n]/.test(config.apiKey)) throw new Error('Invalid API key')
  if (typeof config.timeoutMs !== 'number' || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 3000) {
    throw new Error('Timeout must be between 100 and 3000 ms')
  }
  if (config.provider === 'reflex' && !loopback) throw new Error('Reflex local endpoint must use localhost')
  return { provider: config.provider, enabled: config.enabled, browserEnabled: config.browserEnabled, endpoint: endpoint.toString(), model: config.model.trim(), apiKey: config.apiKey.trim(), timeoutMs: config.timeoutMs }
}

function validateAnswers(value: unknown, questions: Record<string, ChoiceQuestion>): Record<string, ChoiceAnswer> {
  if (!value || typeof value !== 'object') throw new Error('Invalid response')
  const answers = (value as { answers?: Record<string, ChoiceAnswer> }).answers
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Missing answers')
  const result: Record<string, ChoiceAnswer> = {}
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id]
    const options = Object.keys(question.criteria)
    if (!answer || answer.type !== 'choice' || !options.includes(answer.choice) || !isProbability(answer.confidence)) throw new Error('Invalid choice')
    if (!answer.probabilities || Object.keys(answer.probabilities).length !== options.length) throw new Error('Invalid distribution')
    const probabilities = options.map(option => answer.probabilities[option])
    if (!probabilities.every(isProbability) || Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - 1) > 0.001) throw new Error('Invalid distribution')
    if (answer.probabilities[answer.choice]! < Math.max(...probabilities)) throw new Error('Choice does not match distribution')
    result[id] = { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: { ...answer.probabilities } }
  }
  return result
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export const fastJudgmentService = new FastJudgmentService()
