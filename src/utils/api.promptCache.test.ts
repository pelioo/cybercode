import { afterEach, describe, expect, test } from 'bun:test'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../constants/prompts.js'
import { buildSystemPromptBlocks } from '../services/api/claude.js'
import { splitSysPromptPrefix } from './api.js'
import { asSystemPrompt } from './systemPromptType.js'

const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
] as const

const originalEnvironment = Object.fromEntries(
  PROVIDER_ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof PROVIDER_ENV_KEYS)[number], string | undefined>

function useGlobalCacheProvider(): void {
  for (const key of PROVIDER_ENV_KEYS) delete process.env[key]
  process.env.ANTHROPIC_API_KEY = 'prompt-cache-test-key'
}

afterEach(() => {
  for (const key of PROVIDER_ENV_KEYS) {
    const value = originalEnvironment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('system prompt cache boundaries', () => {
  test('caches stable session policy separately from the global prefix', () => {
    useGlobalCacheProvider()
    const prompt = asSystemPrompt([
      'Static engineering rules',
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      'Active policy overrides',
    ])

    expect(splitSysPromptPrefix(prompt)).toEqual([
      { text: 'Static engineering rules', cacheScope: 'global' },
      { text: 'Active policy overrides', cacheScope: 'org' },
    ])
  })

  test('keeps the global prefix stable when a policy switch changes', () => {
    useGlobalCacheProvider()
    const build = (policy: string) =>
      splitSysPromptPrefix(
        asSystemPrompt([
          'Static engineering rules',
          SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
          policy,
        ]),
      )

    const before = build('Caveman disabled')
    const repeated = build('Caveman disabled')
    const changed = build('Caveman enabled')

    expect(repeated).toEqual(before)
    expect(changed[0]).toEqual(before[0])
    expect(changed[1]).toEqual({
      text: 'Caveman enabled',
      cacheScope: 'org',
    })
  })

  test('does not create an empty session cache block', () => {
    useGlobalCacheProvider()

    expect(
      splitSysPromptPrefix(
        asSystemPrompt([
          'Static engineering rules',
          SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
        ]),
      ),
    ).toEqual([{ text: 'Static engineering rules', cacheScope: 'global' }])
  })

  test('emits two isolated API cache breakpoints for the system prompt', () => {
    useGlobalCacheProvider()
    const blocks = buildSystemPromptBlocks(
      asSystemPrompt([
        'Static engineering rules',
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
        'Active policy overrides',
      ]),
      true,
    )

    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.cache_control).toMatchObject({
      type: 'ephemeral',
      scope: 'global',
    })
    expect(blocks[1]?.cache_control).toMatchObject({ type: 'ephemeral' })
    expect(blocks[1]?.cache_control).not.toHaveProperty('scope')
  })
})
