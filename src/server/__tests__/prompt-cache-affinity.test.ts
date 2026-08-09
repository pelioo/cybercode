import { describe, expect, test } from 'bun:test'
import {
  buildOpenAIPromptCacheKey,
  CLAUDE_CODE_SESSION_HEADER,
  resolvePromptCacheSessionId,
  supportsOpenAIPromptCacheKey,
} from '../proxy/promptCache.js'
import { prepareCodexResponsesRequest } from '../proxy/codexResponses.js'
import { anthropicToOpenaiResponses } from '../proxy/transform/anthropicToOpenaiResponses.js'

describe('OpenAI prompt cache affinity', () => {
  test('creates a stable opaque key per CyberCode session', () => {
    const first = buildOpenAIPromptCacheKey('session-alpha')
    const repeated = buildOpenAIPromptCacheKey('session-alpha')
    const other = buildOpenAIPromptCacheKey('session-beta')

    expect(first).toBe(repeated)
    expect(first).not.toBe(other)
    expect(first).toStartWith('cybercode_')
    expect(first).not.toContain('session-alpha')
  })

  test('reads the existing Claude session header and prefers routed sessions', () => {
    const request = new Request('http://127.0.0.1/proxy/v1/messages', {
      headers: { [CLAUDE_CODE_SESSION_HEADER]: 'header-session' },
    })

    expect(resolvePromptCacheSessionId(request)).toBe('header-session')
    expect(resolvePromptCacheSessionId(request, 'route-session')).toBe('route-session')
  })

  test('only enables the extra field for official OpenAI and Codex', () => {
    expect(supportsOpenAIPromptCacheKey('https://api.openai.com')).toBe(true)
    expect(supportsOpenAIPromptCacheKey('https://api.openai.com/v1')).toBe(true)
    expect(supportsOpenAIPromptCacheKey('https://chatgpt.com/backend-api/codex', 'codex')).toBe(true)
    expect(supportsOpenAIPromptCacheKey('https://api.moonshot.cn/v1')).toBe(false)
    expect(supportsOpenAIPromptCacheKey('http://127.0.0.1:11434/v1')).toBe(false)
    expect(supportsOpenAIPromptCacheKey('not a url')).toBe(false)
  })

  test('preserves cache affinity through the Codex request normalizer', () => {
    const request = anthropicToOpenaiResponses({
      model: 'gpt-5-codex',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Inspect the project' }],
    }, {
      promptCacheKey: 'cybercode_cache_key',
    })

    expect(prepareCodexResponsesRequest(request).prompt_cache_key).toBe(
      'cybercode_cache_key',
    )
  })
})
