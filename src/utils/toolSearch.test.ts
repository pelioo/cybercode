import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { resetStateForTests } from '../bootstrap/state.js'
import { query } from '../query.js'
import type { QueryDeps } from '../query/deps.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import {
  buildTool,
  type ToolDef,
  type Tools,
  type ToolUseContext,
} from '../Tool.js'
import { ToolSearchTool } from '../tools/ToolSearchTool/ToolSearchTool.js'
import type { Message, UserMessage } from '../types/message.js'
import { toolToAPISchema } from './api.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import { stripToolReferenceBlocksFromUserMessage } from './messages.js'
import { createAssistantMessage, createUserMessage } from './messages.js'
import { asSystemPrompt } from './systemPromptType.js'
import {
  extractDiscoveredToolNames,
  extractToolSearchDiscoveryState,
  filterToolsForToolSearchProtocol,
  formatLocalToolSearchResult,
  getDeferredToolsDelta,
  getDeferredToolNamesForProtocol,
  getToolSearchTransport,
  isNativeToolSearchEnabledOptimistic,
  isLightweightConversationTurn,
  isToolSearchEnabled,
  isToolSearchEnabledOptimistic,
  resolveToolSearchProtocol,
} from './toolSearch.js'

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ENABLE_TOOL_SEARCH',
  'CYBERCODE_ENABLE_TOOL_REFERENCE',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

const originalEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

function restoreEnvironment(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function resetProviderEnvironment(): void {
  delete process.env.CYBERCODE_ENABLE_TOOL_REFERENCE
  delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
}

function useCustomAnthropicGateway(): void {
  resetProviderEnvironment()
  process.env.ENABLE_TOOL_SEARCH = 'true'
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/anthropic'
}

function useFirstPartyAnthropic(): void {
  resetProviderEnvironment()
  process.env.ENABLE_TOOL_SEARCH = 'true'
  delete process.env.ANTHROPIC_BASE_URL
}

const toolSearchOnly = [{ name: 'ToolSearch' }] as unknown as Tools
const getToolPermissionContext = async () =>
  ({}) as Awaited<ReturnType<Parameters<typeof isToolSearchEnabled>[2]>>

function localDiscoveryMessages(toolNames: string[]): Message[] {
  return [
    {
      type: 'assistant',
      uuid: 'assistant-tool-search',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-search-use',
            name: 'ToolSearch',
            input: { query: 'search' },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'local-tool-result',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-search-use',
            content: formatLocalToolSearchResult(toolNames),
          },
        ],
      },
    },
  ] as unknown as Message[]
}

afterEach(restoreEnvironment)

describe('provider-neutral tool search protocol', () => {
  test('uses local loading for common third-party gateway models', async () => {
    useCustomAnthropicGateway()

    for (const model of ['kimi-k2.6', 'glm-5.2', 'deepseek-v3', 'gpt-5']) {
      expect(getToolSearchTransport(model)).toBe('local')
      expect(
        await resolveToolSearchProtocol(
          model,
          toolSearchOnly,
          getToolPermissionContext,
          [],
        ),
      ).toBe('local')
    }

    expect(isToolSearchEnabledOptimistic()).toBe(true)
    expect(isNativeToolSearchEnabledOptimistic()).toBe(false)
  })

  test('keeps native loading on supported Anthropic requests', async () => {
    useFirstPartyAnthropic()

    expect(getToolSearchTransport('claude-sonnet-4-5')).toBe('native')
    expect(
      await resolveToolSearchProtocol(
        'claude-sonnet-4-5',
        toolSearchOnly,
        getToolPermissionContext,
        [],
      ),
    ).toBe('native')
    expect(isNativeToolSearchEnabledOptimistic()).toBe(true)
  })

  test('uses local loading when a model cannot accept tool_reference', async () => {
    useFirstPartyAnthropic()

    expect(getToolSearchTransport('claude-3-5-haiku')).toBe('local')
    expect(
      await isToolSearchEnabled(
        'claude-3-5-haiku',
        toolSearchOnly,
        getToolPermissionContext,
        [],
      ),
    ).toBe(true)
  })

  test('does not assume non-Claude Bedrock models support native references', () => {
    useFirstPartyAnthropic()
    process.env.CLAUDE_CODE_USE_BEDROCK = 'true'

    expect(getToolSearchTransport('deepseek-r1')).toBe('local')
    expect(getToolSearchTransport('anthropic.claude-sonnet-4-5')).toBe(
      'native',
    )
  })

  test('allows explicit native opt-in for a compatible proxy', async () => {
    useCustomAnthropicGateway()
    process.env.CYBERCODE_ENABLE_TOOL_REFERENCE = 'true'

    expect(getToolSearchTransport('claude-sonnet-4-5')).toBe('native')
  })

  test('uses local loading when experimental beta content is disabled', async () => {
    useFirstPartyAnthropic()
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = 'true'

    expect(getToolSearchTransport('claude-sonnet-4-5')).toBe('local')
    expect(
      await resolveToolSearchProtocol(
        'claude-sonnet-4-5',
        toolSearchOnly,
        getToolPermissionContext,
        [],
      ),
    ).toBe('local')
    expect(isNativeToolSearchEnabledOptimistic()).toBe(false)
  })

  test('falls back to full schemas after a ToolSearch execution error', async () => {
    useCustomAnthropicGateway()
    const failedSearch = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'failed-tool-search',
              name: 'ToolSearch',
              input: { query: 'github' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'failed-tool-search',
              content: 'Tool search failed',
              is_error: true,
            },
          ],
        },
      },
    ] as unknown as Message[]

    expect(
      await resolveToolSearchProtocol(
        'glm-5.2',
        toolSearchOnly,
        getToolPermissionContext,
        [],
        'test',
        failedSearch,
      ),
    ).toBe('full')
  })

  test('falls back to full schemas when disabled or ToolSearch is unavailable', async () => {
    useCustomAnthropicGateway()
    process.env.ENABLE_TOOL_SEARCH = 'false'

    expect(
      await resolveToolSearchProtocol(
        'glm-5.2',
        toolSearchOnly,
        getToolPermissionContext,
        [],
      ),
    ).toBe('full')

    process.env.ENABLE_TOOL_SEARCH = 'true'
    expect(
      await resolveToolSearchProtocol(
        'glm-5.2',
        [] as unknown as Tools,
        getToolPermissionContext,
        [],
      ),
    ).toBe('full')
  })
})

describe('local schema selection', () => {
  const tools = [
    { name: 'ToolSearch' },
    { name: 'Read' },
    { name: 'Task', shouldDefer: true },
    { name: 'mcp__github__search', isMcp: true },
    { name: 'mcp__always__status', isMcp: true, alwaysLoad: true },
  ] as unknown as Tools

  test('local mode defers MCP and low-frequency built-in tools', () => {
    expect([...getDeferredToolNamesForProtocol(tools, 'local')]).toEqual([
      'Task',
      'mcp__github__search',
    ])
    expect(
      filterToolsForToolSearchProtocol(tools, 'local', new Set()).map(
        tool => tool.name,
      ),
    ).toEqual(['ToolSearch', 'Read', 'mcp__always__status'])
    expect([...getDeferredToolNamesForProtocol(tools, 'native')]).toEqual([
      'Task',
      'mcp__github__search',
    ])
  })

  test('adds discovered built-in and MCP schemas on the next request', () => {
    const selected = filterToolsForToolSearchProtocol(
      tools,
      'local',
      new Set(['Task', 'mcp__github__search']),
    )
    expect(selected.map(tool => tool.name)).toContain('Task')
    expect(selected.map(tool => tool.name)).toContain('mcp__github__search')
  })

  test('ToolSearch execution records the local protocol for a gateway model', async () => {
    useCustomAnthropicGateway()
    const result = await ToolSearchTool.call(
      { query: 'select:mcp__github__search', max_results: 5 },
      {
        options: { tools, mainLoopModel: 'glm-5.2' },
        getAppState: () => ({ mcp: { clients: [] } }),
      } as never,
      (() => undefined) as never,
      {} as never,
    )

    expect(result.data.loading_protocol).toBe('local')
    expect(result.data.matches).toEqual(['mcp__github__search'])
  })

  test('full mode removes ToolSearch and exposes all real tools', () => {
    expect(
      filterToolsForToolSearchProtocol(tools, 'full', new Set()).map(
        tool => tool.name,
      ),
    ).toEqual([
      'Read',
      'Task',
      'mcp__github__search',
      'mcp__always__status',
    ])
  })

  test('does not resurrect a discovered tool after its MCP server disconnects', () => {
    const connectedTools = tools.filter(
      tool => tool.name !== 'mcp__github__search',
    ) as Tools
    expect(
      filterToolsForToolSearchProtocol(
        connectedTools,
        'local',
        new Set(['mcp__github__search']),
      ).map(tool => tool.name),
    ).not.toContain('mcp__github__search')
  })

  test('announces only the tools deferred by the active protocol', () => {
    expect(getDeferredToolsDelta(tools, [], undefined, 'local')?.addedNames).toEqual([
      'Task',
      'mcp__github__search',
    ])
    expect(getDeferredToolsDelta(tools, [], undefined, 'native')?.addedNames).toEqual([
      'Task',
      'mcp__github__search',
    ])
  })

  test('completes a large-catalog local discovery and tool execution lifecycle', async () => {
    useCustomAnthropicGateway()

    let invocationCount = 0
    const mcpTools = Array.from({ length: 58 }, (_, index) => {
      const name = `mcp__simulation__tool_${index}`
      return {
        name,
        isMcp: true,
        inputJSONSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: `Simulated input for ${name}. ${'x'.repeat(420)}`,
            },
          },
          required: ['query'],
        },
        async prompt() {
          return `Simulated MCP capability for ${name}. ${'y'.repeat(420)}`
        },
        async call(input: { query: string }) {
          invocationCount += 1
          return { data: { echoed: input.query, tool: name } }
        },
      }
    }) as unknown as Tools
    const lifecycleTools = [ToolSearchTool, ...mcpTools] as Tools
    const targetName = 'mcp__simulation__tool_17'

    const protocol = await resolveToolSearchProtocol(
      'glm-5.2',
      lifecycleTools,
      getToolPermissionContext,
      [],
    )
    expect(protocol).toBe('local')

    const initialTools = filterToolsForToolSearchProtocol(
      lifecycleTools,
      protocol,
      new Set(),
    )
    expect(initialTools.map(tool => tool.name)).toEqual(['ToolSearch'])

    const search = await ToolSearchTool.call(
      { query: `select:${targetName}`, max_results: 5 },
      {
        options: { tools: lifecycleTools, mainLoopModel: 'glm-5.2' },
        getAppState: () => ({ mcp: { clients: [] } }),
      } as never,
      (() => undefined) as never,
      {} as never,
    )
    const resultBlock = ToolSearchTool.mapToolResultToToolResultBlockParam(
      search.data,
      'tool-search-use',
    )
    expect(typeof resultBlock.content).toBe('string')
    expect(JSON.stringify(resultBlock)).not.toContain('tool_reference')

    const messages = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-search-use',
              name: 'ToolSearch',
              input: { query: `select:${targetName}` },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [resultBlock],
        },
      },
    ] as unknown as Message[]
    const discovered = extractDiscoveredToolNames(messages)
    expect(discovered).toEqual(new Set([targetName]))

    const nextTools = filterToolsForToolSearchProtocol(
      lifecycleTools,
      protocol,
      discovered,
    )
    expect(nextTools.map(tool => tool.name)).toEqual(['ToolSearch', targetName])

    const schemaBytes = async (selectedTools: Tools) =>
      JSON.stringify(
        await Promise.all(
          selectedTools.map(tool =>
            toolToAPISchema(tool, {
              getToolPermissionContext,
              tools: lifecycleTools,
              agents: [],
              model: 'glm-5.2',
            }),
          ),
        ),
      ).length
    const initialSchemaBytes = await schemaBytes(initialTools)
    const nextSchemaBytes = await schemaBytes(nextTools)
    const fullSchemaBytes = await schemaBytes(
      filterToolsForToolSearchProtocol(
        lifecycleTools,
        'full',
        new Set(),
      ),
    )
    expect(initialSchemaBytes).toBeLessThan(nextSchemaBytes)
    expect(nextSchemaBytes).toBeLessThan(fullSchemaBytes)
    expect(fullSchemaBytes).toBeGreaterThan(50_000)

    const selectedTool = nextTools.find(tool => tool.name === targetName)
    expect(selectedTool).toBeDefined()
    const execution = await selectedTool!.call(
      { query: 'round-trip-ok' },
      {} as never,
      (() => undefined) as never,
      {} as never,
    )
    expect(execution).toEqual({
      data: { echoed: 'round-trip-ok', tool: targetName },
    })
    expect(invocationCount).toBe(1)
  })
})

describe('lightweight conversation turns', () => {
  test('recognizes an exact greeting even after project memory is appended', () => {
    expect(
      isLightweightConversationTurn([
        createUserMessage({
          content:
            '你好\n\n<cybercode_project_memory_context>irrelevant history</cybercode_project_memory_context>',
        }),
      ]),
    ).toBe(true)
  })

  test('does not classify a coding request or a turn with tool history as lightweight', () => {
    expect(
      isLightweightConversationTurn([
        createUserMessage({ content: '你好，帮我修复这个 TypeScript 报错' }),
      ]),
    ).toBe(false)

    expect(
      isLightweightConversationTurn([
        createAssistantMessage({
          content: [
            {
              type: 'tool_use',
              id: 'read-1',
              name: 'Read',
              input: { file_path: '/tmp/example.ts' },
            },
          ] as never,
        }),
        createUserMessage({ content: '谢谢' }),
      ]),
    ).toBe(false)
  })
})

describe('local discovery persistence', () => {
  test('keeps tool_reference output for the native protocol', () => {
    const result = ToolSearchTool.mapToolResultToToolResultBlockParam(
      {
        matches: ['mcp__github__search'],
        query: 'github search',
        total_deferred_tools: 1,
        loading_protocol: 'native',
      },
      'tool-search-use',
    )

    expect(result.content).toEqual([
      { type: 'tool_reference', tool_name: 'mcp__github__search' },
    ])
  })

  test('maps local results to ordinary text without tool_reference', () => {
    const result = ToolSearchTool.mapToolResultToToolResultBlockParam(
      {
        matches: ['mcp__github__search'],
        query: 'github search',
        total_deferred_tools: 1,
        loading_protocol: 'local',
      },
      'tool-search-use',
    )

    expect(typeof result.content).toBe('string')
    expect(JSON.stringify(result)).not.toContain('tool_reference')
    const messages = localDiscoveryMessages(['mcp__github__search'])
    expect(extractDiscoveredToolNames(messages)).toEqual(
      new Set(['mcp__github__search']),
    )
    expect(extractToolSearchDiscoveryState(messages).requiresEagerSchema).toEqual(
      new Set(['mcp__github__search']),
    )
  })

  test('does not load a tool when search returns no results', () => {
    const result = ToolSearchTool.mapToolResultToToolResultBlockParam(
      {
        matches: [],
        query: 'missing',
        total_deferred_tools: 1,
        loading_protocol: 'local',
      },
      'tool-search-use',
    )
    expect(JSON.stringify(result)).not.toContain('cybercode-local-tool-search')
  })

  test('ignores marker-shaped output from a different tool', () => {
    const messages = localDiscoveryMessages(['mcp__github__search'])
    const user = messages[1] as UserMessage
    const content = user.message.content
    if (Array.isArray(content) && content[0]?.type === 'tool_result') {
      content[0].tool_use_id = 'unrelated-tool-use'
    }
    expect(extractDiscoveredToolNames(messages)).toEqual(new Set())
  })

  test('restores local loading state from a compact boundary', () => {
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: {
        preCompactDiscoveredTools: ['mcp__github__search'],
      },
    } as unknown as Message
    expect(extractDiscoveredToolNames([boundary])).toEqual(
      new Set(['mcp__github__search']),
    )
    expect(
      extractToolSearchDiscoveryState([boundary]).requiresEagerSchema,
    ).toEqual(new Set(['mcp__github__search']))
  })

  test('keeps native discoveries available when switching to local mode', () => {
    const messages = [
      {
        type: 'user',
        uuid: 'native-result',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'native-search',
              content: [
                {
                  type: 'tool_reference',
                  tool_name: 'mcp__github__search',
                },
              ],
            },
          ],
        },
      },
    ] as unknown as Message[]
    expect(extractDiscoveredToolNames(messages)).toEqual(
      new Set(['mcp__github__search']),
    )
    expect(
      extractToolSearchDiscoveryState(messages).requiresEagerSchema,
    ).toEqual(new Set())
  })

  test('converts saved native-only results into ordinary text', () => {
    const message = {
      type: 'user',
      uuid: 'tool-result-message',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-use-id',
            content: [{ type: 'tool_reference', tool_name: 'WebSearch' }],
          },
        ],
      },
    } as unknown as UserMessage

    const cleaned = stripToolReferenceBlocksFromUserMessage(message)
    const content = cleaned.message.content

    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) return
    const toolResult = content[0]
    expect(toolResult?.type).toBe('tool_result')
    if (toolResult?.type !== 'tool_result') return
    expect(toolResult.content).toEqual([
      {
        type: 'text',
        text: '[Tool references removed - tool search not enabled]',
      },
    ])
  })
})

describe('query tool execution integration', () => {
  test('executes an MCP tool after provider-neutral discovery', async () => {
    resetStateForTests()
    useCustomAnthropicGateway()

    const targetName = 'mcp__simulation__execute'
    const targetInputSchema = z.object({ query: z.string() })
    const targetOutputSchema = z.object({ echoed: z.string() })
    let invocationCount = 0
    const targetTool = buildTool({
      name: targetName,
      isMcp: true,
      maxResultSizeChars: 10_000,
      async description() {
        return 'Execute a simulated MCP operation.'
      },
      async prompt() {
        return 'Execute a simulated MCP operation.'
      },
      inputSchema: targetInputSchema,
      outputSchema: targetOutputSchema,
      isConcurrencySafe() {
        return true
      },
      isReadOnly() {
        return true
      },
      async call(input) {
        invocationCount += 1
        return { data: { echoed: input.query } }
      },
      renderToolUseMessage() {
        return null
      },
      mapToolResultToToolResultBlockParam(output, toolUseID) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseID,
          content: output.echoed,
        }
      },
    } satisfies ToolDef<typeof targetInputSchema, { echoed: string }>)

    const initialMessage = createUserMessage({
      content: 'Run the simulated MCP operation.',
    })
    const tools = [ToolSearchTool, targetTool] as Tools
    let appState = getDefaultAppState()
    let modelCallCount = 0
    const modelInputs: unknown[] = []
    const deps: QueryDeps = {
      uuid: () => `tool-search-query-${modelCallCount}`,
      microcompact: (async messages => ({ messages })) as QueryDeps['microcompact'],
      autocompact: (async () => ({
        wasCompacted: false,
      })) as QueryDeps['autocompact'],
      compactOnPromptTooLong: (async () =>
        null) as QueryDeps['compactOnPromptTooLong'],
      callModel: (async function* (input) {
        modelCallCount += 1
        modelInputs.push(input.messages)

        if (modelCallCount === 1) {
          yield createAssistantMessage({
            content: [
              {
                type: 'tool_use',
                id: 'search-use',
                name: 'ToolSearch',
                input: { query: `select:${targetName}` },
              },
            ] as never,
          })
          return
        }

        if (modelCallCount === 2) {
          yield createAssistantMessage({
            content: [
              {
                type: 'tool_use',
                id: 'target-use',
                name: targetName,
                input: { query: 'query-loop-ok' },
              },
            ] as never,
          })
          return
        }

        yield createAssistantMessage({ content: 'MCP execution completed.' })
      }) as QueryDeps['callModel'],
    }
    const toolUseContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'glm-5.2',
        tools,
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(10),
      getAppState: () => appState,
      setAppState: update => {
        appState = update(appState)
      },
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      messages: [initialMessage],
    } as ToolUseContext

    const generator = query({
      messages: [initialMessage],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool: (async (_tool, input) => ({
        behavior: 'allow',
        updatedInput: input,
      })) as never,
      toolUseContext,
      querySource: 'sdk',
      deps,
    })

    const yielded: unknown[] = []
    let terminal: unknown
    while (true) {
      const next = await generator.next()
      if (next.done) {
        terminal = next.value
        break
      }
      yielded.push(next.value)
    }

    expect(modelCallCount).toBe(3)
    expect(invocationCount).toBe(1)
    expect(JSON.stringify(modelInputs[1])).toContain(
      'cybercode-local-tool-search',
    )
    expect(JSON.stringify(modelInputs)).not.toContain('tool_reference')
    expect(JSON.stringify(yielded)).toContain('MCP execution completed.')
    expect(terminal).toEqual({ reason: 'completed' })
    resetStateForTests()
  })
})
