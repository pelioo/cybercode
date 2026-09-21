import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { _resetConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { FastJudgmentService, JevProvider, type JudgmentProvider, type JudgmentRequest } from './service.js'
import { handleTokenOptimizationApi } from '../../server/api/token-optimization.js'

const oldConfig = process.env.CYBER_CONFIG_DIR
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyber-judgment-'))
  process.env.CYBER_CONFIG_DIR = root
  _resetConfigHomeDirForTesting()
})
afterEach(() => {
  if (oldConfig === undefined) delete process.env.CYBER_CONFIG_DIR
  else process.env.CYBER_CONFIG_DIR = oldConfig
  _resetConfigHomeDirForTesting()
  fs.rmSync(root, { recursive: true, force: true })
})
const request: JudgmentRequest = {
  state: 'some context',
  questions: { q: { type: 'choice', instructions: 'Keep?', criteria: { keep: 'Relevant', shorten: 'Unrelated' } } },
}
const valid = () => ({ answers: { q: { type: 'choice', choice: 'keep', confidence: 0.9, probabilities: { keep: 0.98, shorten: 0.02 } } } })
function setup(provider: JudgmentProvider) {
  const service = new FastJudgmentService(provider)
  service.updateConfig({ provider: 'jev', enabled: true, apiKey: 'test-secret', timeoutMs: 100 })
  return service
}

describe('fast judgment service', () => {
  test('disabled by default; never calls a provider without opt-in', async () => {
    let calls = 0
    const service = new FastJudgmentService({ evaluate: async () => { calls++; return valid() } })
    expect(service.getStatus()).toMatchObject({ enabled: false, browserEnabled: false, provider: 'reflex', model: 'Qwen/Qwen3.5-4B', endpoint: 'http://127.0.0.1:8008/v1/systemone', hasApiKey: false })
    expect((await service.decide(request)).source).toBe('fallback')
    expect(calls).toBe(0)
  })

  test('persists secrets privately but never returns them; partial updates preserve key', () => {
    const service = setup({ evaluate: async () => valid() })
    expect(JSON.stringify(service.getStatus())).not.toContain('test-secret')
    service.updateConfig({ model: 'jev-pinned' })
    const reader = new FastJudgmentService()
    expect(reader.getStatus()).toMatchObject({ enabled: true, hasApiKey: true, model: 'jev-pinned' })
    if (process.platform !== 'win32') expect(fs.statSync(path.join(root, 'cybercode', 'fast-judgment.json')).mode & 0o777).toBe(0o600)
    reader.updateConfig({ apiKey: '' })
    expect(service.getStatus().hasApiKey).toBe(false)
    expect(() => reader.updateConfig({ timeoutMs: 0 })).toThrow()
    expect(() => reader.updateConfig({ endpoint: 'http://example.com/api' })).toThrow()
    expect(() => reader.updateConfig({ endpoint: 'https://user:password@example.com/api' })).toThrow()
  })

  test('enabled without a key falls back without a network request', async () => {
    let calls = 0
    const service = new FastJudgmentService({ evaluate: async () => { calls++; return valid() } })
    service.updateConfig({ provider: 'jev', enabled: true })
    expect((await service.decide(request)).answers).toBeNull()
    expect(calls).toBe(0)
    expect(service.getStatus().stats.lastError).toBe('API_KEY_REQUIRED')
  })

  test('changing the endpoint host clears an old credential', () => {
    const service = setup({ evaluate: async () => valid() })
    service.updateConfig({ endpoint: 'http://localhost:9876/v1/systemone' })
    expect(service.getStatus().hasApiKey).toBe(false)
  })

  test('caches exact requests but invalidates when task or configuration changes', async () => {
    let calls = 0
    const service = setup({ evaluate: async () => { calls++; return valid() } })
    expect((await service.decide(request)).source).toBe('network')
    expect((await service.decide(request)).source).toBe('cache')
    await service.decide({ ...request, state: 'different task' })
    service.updateConfig({ model: 'different-model' })
    await service.decide(request)
    expect(calls).toBe(3)
    expect(service.getStatus().stats.cacheHits).toBe(1)
  })

  test('bounds latency even when a provider ignores abort; opens cooldown after three failures', async () => {
    let calls = 0
    const service = setup({ evaluate: async () => { calls++; return new Promise(() => {}) } })
    const start = performance.now()
    for (let i = 0; i < 4; i++) expect((await service.decide(request)).answers).toBeNull()
    expect(performance.now() - start).toBeLessThan(1000)
    expect(calls).toBe(3)
    expect(service.getStatus().stats.lastError).toBe('TIMEOUT')
  })

  test('caller cancellation returns promptly without poisoning provider health', async () => {
    const service = setup({ evaluate: async () => new Promise(() => {}) })
    const controller = new AbortController()
    const pending = service.decide(request, controller.signal)
    controller.abort()
    expect((await pending).answers).toBeNull()
    expect(service.getStatus().stats.lastError).toBeNull()
  })

  test('rejects incomplete, unnormalized and contradictory decisions', async () => {
    const malformed = [
      {}, { answers: {} },
      { answers: { q: { ...valid().answers.q, confidence: NaN } } },
      { answers: { q: { ...valid().answers.q, choice: 'unknown' } } },
      { answers: { q: { ...valid().answers.q, choice: 'shorten' } } },
      { answers: { q: { ...valid().answers.q, probabilities: { keep: 0.9, shorten: 0.9 } } } },
    ]
    for (const value of malformed) {
      const service = setup({ evaluate: async () => value })
      expect((await service.decide(request)).answers).toBeNull()
    }
  })

  test('disabling while a request is in flight discards its result', async () => {
    let resolve!: (value: unknown) => void
    const service = setup({ evaluate: async () => new Promise(r => { resolve = r }) })
    const pending = service.decide(request)
    service.updateConfig({ enabled: false })
    resolve(valid())
    expect((await pending).answers).toBeNull()
  })

  test('Jev transport sends the official protocol and bearer header', async () => {
    let body: unknown
    let authorization: string | null = null
    const server = Bun.serve({ port: 0, async fetch(req) {
      body = await req.json()
      authorization = req.headers.get('authorization')
      return Response.json(valid())
    } })
    try {
      const service = new FastJudgmentService(new JevProvider())
      service.updateConfig({ provider: 'jev', enabled: true, endpoint: `http://127.0.0.1:${server.port}/v1/systemone`, apiKey: 'local-test', timeoutMs: 1000 })
      expect((await service.decide(request)).answers?.q?.choice).toBe('keep')
      expect(body).toEqual({ ...request, model: 'jev-latest' })
      expect(authorization).toBe('Bearer local-test')
    } finally { server.stop(true) }
  })

  test('Reflex uses the local protocol without a key and never falls through to Jev', async () => {
    let body: unknown
    let authorization: string | null = null
    const server = Bun.serve({ port: 0, async fetch(req) {
      body = await req.json()
      authorization = req.headers.get('authorization')
      return Response.json(valid())
    } })
    const service = new FastJudgmentService()
    try {
      service.updateConfig({ enabled: true, endpoint: `http://127.0.0.1:${server.port}/v1/systemone`, timeoutMs: 1000 })
      expect((await service.decide(request)).answers?.q?.choice).toBe('keep')
      expect(body).toEqual({ ...request, model: 'Qwen/Qwen3.5-4B' })
      expect(authorization).toBeNull()
      expect(() => service.updateConfig({ endpoint: 'https://api.typesafe.ai/v1/systemone' })).toThrow()
    } finally { server.stop(true) }
    expect((await service.decide({ ...request, state: 'uncached' })).source).toBe('fallback')
    expect(service.getStatus().provider).toBe('reflex')
  })

  test('switches and restores independent profiles, disables, invalidates cache and redacts all keys', async () => {
    let calls = 0
    const service = setup({ evaluate: async () => { calls++; return valid() } })
    await service.decide(request)
    service.updateConfig({ provider: 'reflex' })
    expect(service.getStatus()).toMatchObject({ enabled: false, hasApiKey: false, model: 'Qwen/Qwen3.5-4B' })
    service.updateConfig({ endpoint: 'http://localhost:9008/v1/systemone', timeoutMs: 2000, apiKey: 'local-secret' })
    service.updateConfig({ provider: 'jev' })
    expect(service.getStatus()).toMatchObject({ enabled: false, hasApiKey: true, model: 'jev-latest', timeoutMs: 100 })
    expect(JSON.stringify(service.getStatus())).not.toMatch(/test-secret|local-secret|profiles/)
    service.updateConfig({ enabled: true })
    await service.decide(request)
    expect(calls).toBe(2)
    const restarted = new FastJudgmentService()
    restarted.updateConfig({ provider: 'reflex' })
    expect(restarted.getStatus()).toMatchObject({ endpoint: 'http://localhost:9008/v1/systemone', timeoutMs: 2000, hasApiKey: true })
    restarted.updateConfig({ apiKey: '' })
    restarted.updateConfig({ provider: 'jev' })
    restarted.updateConfig({ provider: 'reflex' })
    expect(restarted.getStatus().hasApiKey).toBe(false)
    expect(() => restarted.updateConfig({ provider: 'other' })).toThrow()
  })

  test('preserves legacy Jev settings when upgrading', () => {
    fs.mkdirSync(path.join(root, 'cybercode'), { recursive: true })
    fs.writeFileSync(path.join(root, 'cybercode', 'fast-judgment.json'), JSON.stringify({
      enabled: true, endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-pinned', apiKey: 'legacy-key', timeoutMs: 1200,
    }))
    const service = new FastJudgmentService()
    expect(service.getStatus()).toMatchObject({ provider: 'jev', enabled: true, browserEnabled: false, model: 'jev-pinned', hasApiKey: true })
    service.updateConfig({ provider: 'reflex' })
    expect(service.getStatus().hasApiKey).toBe(false)
    service.updateConfig({ provider: 'jev' })
    expect(service.getStatus()).toMatchObject({ model: 'jev-pinned', hasApiKey: true, timeoutMs: 1200 })
  })

  test('settings API validates input and redacts secrets on reads and writes', async () => {
    const url = new URL('http://localhost/api/token-optimization/judgment')
    const call = (method: string, body?: unknown) => handleTokenOptimizationApi(new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), url, ['api', 'token-optimization', 'judgment'])
    const saved = await call('POST', { apiKey: 'do-not-return-this' })
    expect(saved.status).toBe(200)
    expect(await saved.text()).not.toContain('do-not-return-this')
    expect(await (await call('GET')).json()).toMatchObject({ hasApiKey: true, enabled: false })
    expect((await call('POST', { timeoutMs: 50000 })).status).toBe(400)
  })
})
