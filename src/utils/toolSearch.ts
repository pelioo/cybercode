/**
 * Tool Search utilities for dynamically discovering deferred tools.
 *
 * Native Anthropic requests use defer_loading/tool_reference. Other providers
 * use CyberCode's local discovery marker and ordinary tool calls, so deferred
 * schemas never leak provider-specific content blocks onto the wire.
 */

import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { Tool } from '../Tool.js'
import {
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  isLocallyDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../tools/ToolSearchTool/prompt.js'
import type { Message } from '../types/message.js'
import { stripProjectMemoryContext } from '../sessionSearch/projectMemoryContext.js'
import {
  countToolDefinitionTokens,
  TOOL_TOKEN_COUNT_OVERHEAD,
} from './analyzeContext.js'
import { count } from './array.js'
import { getMergedBetas } from './betas.js'
import { getContextWindowForModel } from './context.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from './model/providers.js'
import { jsonStringify } from './slowOperations.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

/**
 * Default percentage of context window at which to auto-enable tool search.
 * When MCP tool descriptions exceed this percentage (in tokens), tool search is enabled.
 * Can be overridden via ENABLE_TOOL_SEARCH=auto:N where N is 0-100.
 */
const DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10 // 10%

/**
 * Parse auto:N syntax from ENABLE_TOOL_SEARCH env var.
 * Returns the percentage clamped to 0-100, or null if not auto:N format or not a number.
 */
function parseAutoPercentage(value: string): number | null {
  if (!value.startsWith('auto:')) return null

  const percentStr = value.slice(5)
  const percent = parseInt(percentStr, 10)

  if (isNaN(percent)) {
    logForDebugging(
      `Invalid ENABLE_TOOL_SEARCH value "${value}": expected auto:N where N is a number.`,
    )
    return null
  }

  // Clamp to valid range
  return Math.max(0, Math.min(100, percent))
}

/**
 * Check if ENABLE_TOOL_SEARCH is set to auto mode (auto or auto:N).
 */
function isAutoToolSearchMode(value: string | undefined): boolean {
  if (!value) return false
  return value === 'auto' || value.startsWith('auto:')
}

/**
 * Get the auto-enable percentage from env var or default.
 */
function getAutoToolSearchPercentage(): number {
  const value = process.env.ENABLE_TOOL_SEARCH
  if (!value) return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE

  if (value === 'auto') return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE

  const parsed = parseAutoPercentage(value)
  if (parsed !== null) return parsed

  return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE
}

/**
 * Approximate chars per token for MCP tool definitions (name + description + input schema).
 * Used as fallback when the token counting API is unavailable.
 */
const CHARS_PER_TOKEN = 2.5

/**
 * Get the token threshold for auto-enabling tool search for a given model.
 */
function getAutoToolSearchTokenThreshold(model: string): number {
  const betas = getMergedBetas(model)
  const contextWindow = getContextWindowForModel(model, betas)
  const percentage = getAutoToolSearchPercentage() / 100
  return Math.floor(contextWindow * percentage)
}

/**
 * Get the character threshold for auto-enabling tool search for a given model.
 * Used as fallback when the token counting API is unavailable.
 */
export function getAutoToolSearchCharThreshold(model: string): number {
  return Math.floor(getAutoToolSearchTokenThreshold(model) * CHARS_PER_TOKEN)
}

/**
 * Get the total token count for all deferred tools using the token counting API.
 * Memoized by deferred tool names — cache is invalidated when MCP servers connect/disconnect.
 * Returns null if the API is unavailable (caller should fall back to char heuristic).
 */
const getDeferredToolTokenCount = memoize(
  async (
    tools: Tools,
    getToolPermissionContext: () => Promise<ToolPermissionContext>,
    agents: AgentDefinition[],
    model: string,
    protocol: ActiveToolSearchProtocol,
  ): Promise<number | null> => {
    const deferredTools = tools.filter(t =>
      isToolDeferredForProtocol(t, protocol),
    )
    if (deferredTools.length === 0) return 0

    try {
      const total = await countToolDefinitionTokens(
        deferredTools,
        getToolPermissionContext,
        { activeAgents: agents, allAgents: agents },
        model,
      )
      if (total === 0) return null // API unavailable
      return Math.max(0, total - TOOL_TOKEN_COUNT_OVERHEAD)
    } catch {
      return null // Fall back to char heuristic
    }
  },
  (tools: Tools, _permissionContext, _agents, model, protocol) =>
    `${model}:${protocol}:` +
    tools
      .filter(t => isToolDeferredForProtocol(t, protocol))
      .map(t => t.name)
      .join(','),
)

/**
 * Tool search mode. Determines whether the active protocol's deferrable tools
 * are surfaced dynamically:
 *   - 'tst': Tool Search Tool — deferred tools discovered via ToolSearchTool (always enabled)
 *   - 'tst-auto': auto — tools deferred only when they exceed threshold
 *   - 'standard': tool search disabled — all tools exposed inline
 */
export type ToolSearchMode = 'tst' | 'tst-auto' | 'standard'

/** Wire protocol used for dynamic tool loading on a specific request. */
export type ToolSearchProtocol = 'native' | 'local' | 'full'
export type ActiveToolSearchProtocol = Exclude<ToolSearchProtocol, 'full'>

const LIGHTWEIGHT_CONVERSATION_PHRASES = new Set([
  '你好',
  '你好啊',
  '您好',
  '您好啊',
  '嗨',
  '哈喽',
  '哈啰',
  '在吗',
  '早',
  '早上好',
  '中午好',
  '下午好',
  '晚上好',
  '晚安',
  '谢谢',
  '多谢',
  '再见',
  '你是谁',
  '你叫什么',
  '你叫什么名字',
  'hello',
  'hello there',
  'hi',
  'hi there',
  'hey',
  'good morning',
  'good afternoon',
  'good evening',
  'thanks',
  'thank you',
  'who are you',
  'what is your name',
  'こんにちは',
  'おはよう',
  'こんばんは',
  'ありがとう',
  '안녕',
  '안녕하세요',
  '감사합니다',
])

function getUserMessageText(message: Message): string | null {
  if (message.type !== 'user' || message.isMeta) return null
  const content = message.message.content
  if (typeof content === 'string') return content
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function hasToolHistory(messages: Message[]): boolean {
  return messages.some(message => {
    if (message.type === 'assistant') {
      return message.message.content.some(block => block.type === 'tool_use')
    }
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return false
    }
    return message.message.content.some(block => block.type === 'tool_result')
  })
}

/**
 * Pure conversational turns do not need tens of thousands of tool-schema
 * tokens. Keep this deliberately exact-match and disable it once tools have
 * appeared in history, so an ordinary coding request always receives the full
 * dynamic tool-loading path on its next turn.
 */
export function isLightweightConversationTurn(messages: Message[]): boolean {
  if (hasToolHistory(messages)) return false

  for (let index = messages.length - 1; index >= 0; index--) {
    const text = getUserMessageText(messages[index]!)
    if (text === null) continue

    const normalized = stripProjectMemoryContext(text)
      .trim()
      .toLocaleLowerCase()
      .replace(/[!！?？。.，,~～]+$/g, '')
      .replace(/\s+/g, ' ')

    return LIGHTWEIGHT_CONVERSATION_PHRASES.has(normalized)
  }

  return false
}

/**
 * Determines the tool search mode from ENABLE_TOOL_SEARCH.
 *
 *   ENABLE_TOOL_SEARCH    Mode
 *   auto / auto:1-99      tst-auto
 *   true / auto:0         tst
 *   false / auto:100      standard
 *   (unset)               tst (default: always use dynamic loading)
 */
export function getToolSearchMode(): ToolSearchMode {
  const value = process.env.ENABLE_TOOL_SEARCH

  // Handle auto:N syntax - check edge cases first
  const autoPercent = value ? parseAutoPercentage(value) : null
  if (autoPercent === 0) return 'tst' // auto:0 = always enabled
  if (autoPercent === 100) return 'standard'
  if (isAutoToolSearchMode(value)) {
    return 'tst-auto' // auto or auto:1-99
  }

  if (isEnvTruthy(value)) return 'tst'
  if (isEnvDefinedFalsy(process.env.ENABLE_TOOL_SEARCH)) return 'standard'
  return 'tst' // default: always use the provider's safe loading protocol
}

/**
 * Default patterns for models that do NOT support tool_reference.
 * New models are assumed to support tool_reference unless explicitly listed here.
 */
const DEFAULT_UNSUPPORTED_MODEL_PATTERNS = ['haiku']

/**
 * Get the list of model patterns that do NOT support tool_reference.
 * Can be configured via GrowthBook for live updates without code changes.
 */
function getUnsupportedToolReferencePatterns(): string[] {
  try {
    // Try to get from GrowthBook for live configuration
    const patterns = getFeatureValue_CACHED_MAY_BE_STALE<string[] | null>(
      'tengu_tool_search_unsupported_models',
      null,
    )
    if (patterns && Array.isArray(patterns) && patterns.length > 0) {
      return patterns
    }
  } catch {
    // GrowthBook not ready, use defaults
  }
  return DEFAULT_UNSUPPORTED_MODEL_PATTERNS
}

/**
 * Check if a model supports tool_reference blocks (required for tool search).
 *
 * This uses a negative test: models are assumed to support tool_reference
 * UNLESS they match a pattern in the unsupported list. This ensures new
 * models work by default without code changes.
 *
 * Currently, Haiku models do NOT support tool_reference. This can be
 * updated via GrowthBook feature 'tengu_tool_search_unsupported_models'.
 *
 * @param model The model name to check
 * @returns true if the model supports tool_reference, false otherwise
 */
export function modelSupportsToolReference(model: string): boolean {
  const normalizedModel = model.toLowerCase()
  const unsupportedPatterns = getUnsupportedToolReferencePatterns()

  // Check if model matches any unsupported pattern
  for (const pattern of unsupportedPatterns) {
    if (normalizedModel.includes(pattern.toLowerCase())) {
      return false
    }
  }

  // New models are assumed to support tool_reference
  return true
}

/**
 * Whether the active API transport can accept Anthropic's tool_reference
 * content blocks. Custom Anthropic-compatible gateways default to the local
 * protocol unless the user explicitly opts into native forwarding.
 */
export function providerSupportsToolReference(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return false
  }
  if (getAPIProvider() !== 'firstParty') return true
  return (
    isFirstPartyAnthropicBaseUrl() ||
    isEnvTruthy(process.env.CYBERCODE_ENABLE_TOOL_REFERENCE)
  )
}

/** Select the safe active transport without applying threshold/tool checks. */
export function getToolSearchTransport(
  model: string,
): ActiveToolSearchProtocol {
  const explicitlyEnabled = isEnvTruthy(
    process.env.CYBERCODE_ENABLE_TOOL_REFERENCE,
  )
  const normalizedModel = model.toLowerCase()
  const isAnthropicModel = ['claude', 'sonnet', 'opus'].some(pattern =>
    normalizedModel.includes(pattern),
  )
  return providerSupportsToolReference() &&
    modelSupportsToolReference(model) &&
    (isAnthropicModel || explicitlyEnabled)
    ? 'native'
    : 'local'
}

/** Apply the protocol's current deferral policy to one tool. */
export function isToolDeferredForProtocol(
  tool: Tool,
  protocol: ToolSearchProtocol,
): boolean {
  if (protocol === 'full') return false
  return protocol === 'local'
    ? isLocallyDeferredTool(tool)
    : isDeferredTool(tool)
}

export function getDeferredToolNamesForProtocol(
  tools: Tools,
  protocol: ToolSearchProtocol,
): Set<string> {
  return new Set(
    tools
      .filter(tool => isToolDeferredForProtocol(tool, protocol))
      .map(tool => tool.name),
  )
}

/**
 * Select the schemas sent on this request. Full mode removes ToolSearch and
 * sends every real tool; active modes add only previously discovered deferred
 * tools while keeping all non-deferred tools available.
 */
export function filterToolsForToolSearchProtocol(
  tools: Tools,
  protocol: ToolSearchProtocol,
  discoveredToolNames: ReadonlySet<string>,
): Tools {
  if (protocol === 'full') {
    return tools.filter(tool =>
      !toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME),
    )
  }

  return tools.filter(tool => {
    if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true
    if (!isToolDeferredForProtocol(tool, protocol)) return true
    return discoveredToolNames.has(tool.name)
  })
}

/**
 * Check if tool search *might* be enabled (optimistic check).
 *
 * Returns true if tool search could potentially be enabled, without checking
 * dynamic factors like model support or threshold. Use this for:
 * - Including ToolSearchTool in base tools (so it's available if needed)
 * - Checking if ToolSearchTool should report itself as enabled
 *
 * Returns false only when tool search is definitively disabled (standard mode).
 *
 * For the definitive check that includes model support and threshold,
 * use isToolSearchEnabled().
 */
let loggedOptimistic = false

export function isToolSearchEnabledOptimistic(): boolean {
  const mode = getToolSearchMode()
  if (mode === 'standard') {
    if (!loggedOptimistic) {
      loggedOptimistic = true
      logForDebugging(
        `[ToolSearch:optimistic] mode=${mode}, ENABLE_TOOL_SEARCH=${process.env.ENABLE_TOOL_SEARCH}, result=false`,
      )
    }
    return false
  }

  if (!loggedOptimistic) {
    loggedOptimistic = true
    logForDebugging(
      `[ToolSearch:optimistic] mode=${mode}, ENABLE_TOOL_SEARCH=${process.env.ENABLE_TOOL_SEARCH}, result=true`,
    )
  }
  return true
}

/**
 * Sync guard for generic message normalization, which has no model argument.
 * Request-time normalization performs the final model-aware native/local check.
 */
export function isNativeToolSearchEnabledOptimistic(): boolean {
  return (
    getToolSearchMode() !== 'standard' && providerSupportsToolReference()
  )
}

/**
 * Check if ToolSearchTool is available in the provided tools list.
 * If ToolSearchTool is not available (e.g., disallowed via disallowedTools),
 * tool search cannot function and should be disabled.
 *
 * @param tools Array of tools with a 'name' property
 * @returns true if ToolSearchTool is in the tools list, false otherwise
 */
export function isToolSearchToolAvailable(
  tools: readonly { name: string }[],
): boolean {
  return tools.some(tool => toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME))
}

/**
 * Calculate total deferred tool description size in characters.
 * Includes name, description text, and input schema to match what's actually sent to the API.
 */
async function calculateDeferredToolDescriptionChars(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  protocol: ActiveToolSearchProtocol,
): Promise<number> {
  const deferredTools = tools.filter(t =>
    isToolDeferredForProtocol(t, protocol),
  )
  if (deferredTools.length === 0) return 0

  const sizes = await Promise.all(
    deferredTools.map(async tool => {
      const description = await tool.prompt({
        getToolPermissionContext,
        tools,
        agents,
      })
      const inputSchema = tool.inputJSONSchema
        ? jsonStringify(tool.inputJSONSchema)
        : tool.inputSchema
          ? jsonStringify(zodToJsonSchema(tool.inputSchema))
          : ''
      return tool.name.length + description.length + inputSchema.length
    }),
  )

  return sizes.reduce((total, size) => total + size, 0)
}

/**
 * Resolve the dynamic-loading protocol for a specific request.
 *
 * This is the definitive check that includes:
 * - MCP mode (Tst, TstAuto, McpCli, Standard)
 * - Native tool_reference compatibility, with local loading as fallback
 * - ToolSearchTool availability (must be in tools list)
 * - Threshold check for TstAuto mode
 *
 * Use this when making actual API calls where all context is available.
 *
 * @param model The active model
 * @param tools Array of available tools (including MCP tools)
 * @param getToolPermissionContext Function to get tool permission context
 * @param agents Array of agent definitions
 * @param source Optional identifier for the caller (for debugging)
 * @returns native, local, or full
 */
export async function resolveToolSearchProtocol(
  model: string,
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  source?: string,
  messages?: Message[],
): Promise<ToolSearchProtocol> {
  const mcpToolCount = count(tools, t => t.isMcp)

  // Helper to log the mode decision event
  function logModeDecision(
    protocol: ToolSearchProtocol,
    mode: ToolSearchMode,
    reason: string,
    extraProps?: Record<string, number>,
  ): void {
    logEvent('tengu_tool_search_mode_decision', {
      enabled: protocol !== 'full',
      mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      protocol:
        protocol as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      reason:
        reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // Log the actual model being checked, not the session's main model.
      // This is important for debugging subagent tool search decisions where
      // the subagent model (e.g., haiku) differs from the session model (e.g., opus).
      checkedModel:
        model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      mcpToolCount,
      userType: (process.env.USER_TYPE ??
        'external') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...extraProps,
    })
  }

  const mode = getToolSearchMode()
  if (mode === 'standard') {
    logModeDecision('full', mode, 'standard_mode')
    return 'full'
  }

  // Check if ToolSearchTool is available (respects disallowedTools)
  if (!isToolSearchToolAvailable(tools)) {
    logForDebugging(
      `Tool search disabled: ToolSearchTool is not available (may have been disallowed via disallowedTools).`,
    )
    logModeDecision('full', mode, 'mcp_search_unavailable')
    return 'full'
  }

  if (messages && hasToolSearchExecutionFailure(messages)) {
    logForDebugging(
      'Tool search disabled after an execution failure; falling back to full schemas.',
    )
    logModeDecision('full', mode, 'tool_search_execution_failed')
    return 'full'
  }

  const protocol = getToolSearchTransport(model)
  if (protocol === 'local') {
    logForDebugging(
      `Tool search using provider-neutral local loading for model '${model}'.`,
    )
  }

  switch (mode) {
    case 'tst':
      logModeDecision(protocol, mode, `${protocol}_enabled`)
      return protocol

    case 'tst-auto': {
      const { enabled, debugDescription, metrics } = await checkAutoThreshold(
        tools,
        getToolPermissionContext,
        agents,
        model,
        protocol,
      )

      if (enabled) {
        logForDebugging(
          `Auto tool search enabled: ${debugDescription}` +
            (source ? ` [source: ${source}]` : ''),
        )
        logModeDecision(protocol, mode, 'auto_above_threshold', metrics)
        return protocol
      }

      logForDebugging(
        `Auto tool search disabled: ${debugDescription}` +
          (source ? ` [source: ${source}]` : ''),
      )
      logModeDecision('full', mode, 'auto_below_threshold', metrics)
      return 'full'
    }
  }
}

/** Backwards-compatible boolean check for callers that only need enabled/full. */
export async function isToolSearchEnabled(
  model: string,
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  source?: string,
): Promise<boolean> {
  return (
    (await resolveToolSearchProtocol(
      model,
      tools,
      getToolPermissionContext,
      agents,
      source,
    )) !== 'full'
  )
}

/**
 * Check if an object is a tool_reference block.
 * tool_reference is a beta feature not in the SDK types, so we need runtime checks.
 */
export function isToolReferenceBlock(obj: unknown): boolean {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_reference'
  )
}

/**
 * Type guard for tool_reference block with tool_name.
 */
function isToolReferenceWithName(
  obj: unknown,
): obj is { type: 'tool_reference'; tool_name: string } {
  return (
    isToolReferenceBlock(obj) &&
    'tool_name' in (obj as object) &&
    typeof (obj as { tool_name: unknown }).tool_name === 'string'
  )
}

const LOCAL_TOOL_SEARCH_RESULT_TAG = 'cybercode-local-tool-search'

export function formatLocalToolSearchResult(
  toolNames: readonly string[],
): string {
  const names = [...new Set(toolNames)].sort()
  return (
    `Loaded deferred tools for the next request: ${names.join(', ')}. ` +
    `Call them normally once their schemas appear.\n` +
    `<${LOCAL_TOOL_SEARCH_RESULT_TAG}>${jsonStringify({ tools: names })}</${LOCAL_TOOL_SEARCH_RESULT_TAG}>`
  )
}

function extractLocalToolSearchNames(text: string): string[] {
  const pattern = new RegExp(
    `<${LOCAL_TOOL_SEARCH_RESULT_TAG}>([\\s\\S]*?)<\\/${LOCAL_TOOL_SEARCH_RESULT_TAG}>`,
    'g',
  )
  const names: string[] = []
  for (const match of text.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1]!) as { tools?: unknown }
      if (!Array.isArray(parsed.tools)) continue
      for (const name of parsed.tools) {
        if (typeof name === 'string' && name.length > 0) names.push(name)
      }
    } catch {
      // Ignore malformed markers; they cannot safely restore loading state.
    }
  }
  return names
}

type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
}

function isToolResultBlock(obj: unknown): obj is ToolResultBlock {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_result'
  )
}

/** A failed ToolSearch turn falls back to full schemas instead of retrying forever. */
export function hasToolSearchExecutionFailure(messages: Message[]): boolean {
  const toolSearchUseIds = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (
        block.type === 'tool_use' &&
        toolMatchesName({ name: block.name }, TOOL_SEARCH_TOOL_NAME)
      ) {
        toolSearchUseIds.add(block.id)
      }
    }
  }

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const msg = messages[messageIndex]!
    if (msg.type !== 'user' || !Array.isArray(msg.message?.content)) continue
    for (let blockIndex = msg.message.content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = msg.message.content[blockIndex]
      if (
        isToolResultBlock(block) &&
        typeof block.tool_use_id === 'string' &&
        toolSearchUseIds.has(block.tool_use_id)
      ) {
        return block.is_error === true
      }
    }
  }

  return false
}

export type ToolSearchDiscoveryState = {
  discoveredToolNames: Set<string>
  /** Tools whose native tool_reference is no longer present in history. */
  requiresEagerSchema: Set<string>
}

/**
 * Extract loaded-tool state from native references, local markers, and compact
 * boundaries in message history.
 *
 * When dynamic tool loading is enabled, MCP tools are not predeclared in the
 * tools array. Native Anthropic requests return tool_reference blocks; the
 * provider-neutral protocol returns an ordinary text marker. Both forms are
 * persisted in the transcript so model switches and session restores retain
 * the same loaded set.
 *
 * This approach:
 * - Eliminates the need to predeclare all MCP tools upfront
 * - Removes limits on total quantity of MCP tools
 *
 * Compaction replaces discovery messages with a summary, so it
 * snapshots the discovered set onto compactMetadata.preCompactDiscoveredTools
 * on the boundary marker; this scan reads it back.
 *
 * Local markers and compact boundaries require an ordinary schema when the
 * next request uses the native protocol: defer_loading cannot expand a tool
 * without a corresponding tool_reference in the API-visible history.
 */
export function extractToolSearchDiscoveryState(
  messages: Message[],
): ToolSearchDiscoveryState {
  const discoveredTools = new Set<string>()
  const requiresEagerSchema = new Set<string>()
  const localToolSearchUseIds = new Set<string>()
  let carriedFromBoundary = 0

  // Local markers are ordinary text, so bind them to an actual ToolSearch
  // tool_use ID instead of trusting marker-shaped text from arbitrary tools.
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (
        block.type === 'tool_use' &&
        toolMatchesName({ name: block.name }, TOOL_SEARCH_TOOL_NAME)
      ) {
        localToolSearchUseIds.add(block.id)
      }
    }
  }

  for (const msg of messages) {
    // Compact boundary carries the pre-compact discovered set. Inline type
    // check rather than isCompactBoundaryMessage — utils/messages.ts imports
    // from this file, so importing back would be circular.
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      const carried = msg.compactMetadata?.preCompactDiscoveredTools
      if (carried) {
        for (const name of carried) {
          discoveredTools.add(name)
          requiresEagerSchema.add(name)
        }
        carriedFromBoundary += carried.length
      }
      continue
    }

    // Only user messages contain tool_result blocks (responses to tool_use)
    if (msg.type !== 'user') continue

    const content = msg.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!isToolResultBlock(block)) continue

      if (Array.isArray(block.content)) {
        for (const item of block.content) {
          if (isToolReferenceWithName(item)) {
            discoveredTools.add(item.tool_name)
          }
        }
      }

      if (
        typeof block.tool_use_id !== 'string' ||
        !localToolSearchUseIds.has(block.tool_use_id)
      ) {
        continue
      }

      const textBlocks =
        typeof block.content === 'string'
          ? [block.content]
          : Array.isArray(block.content)
            ? block.content.flatMap(item =>
                typeof item === 'object' &&
                item !== null &&
                'type' in item &&
                item.type === 'text' &&
                'text' in item &&
                typeof item.text === 'string'
                  ? [item.text]
                  : [],
              )
            : []
      for (const text of textBlocks) {
        for (const name of extractLocalToolSearchNames(text)) {
          discoveredTools.add(name)
          requiresEagerSchema.add(name)
        }
      }
    }
  }

  if (discoveredTools.size > 0) {
    logForDebugging(
      `Dynamic tool loading: found ${discoveredTools.size} discovered tools in message history` +
        (carriedFromBoundary > 0
          ? ` (${carriedFromBoundary} carried from compact boundary)`
          : ''),
    )
  }

  return { discoveredToolNames: discoveredTools, requiresEagerSchema }
}

/** Return every tool loaded by either dynamic-loading protocol. */
export function extractDiscoveredToolNames(messages: Message[]): Set<string> {
  return extractToolSearchDiscoveryState(messages).discoveredToolNames
}

export type DeferredToolsDelta = {
  addedNames: string[]
  /** Rendered lines for addedNames; the scan reconstructs from names. */
  addedLines: string[]
  removedNames: string[]
}

/**
 * Call-site discriminator for the tengu_deferred_tools_pool_change event.
 * The scan runs from several sites with different expected-prior semantics
 * (inc-4747):
 *   - attachments_main: main-thread getAttachments → prior=0 is a BUG on fire-2+
 *   - attachments_subagent: subagent getAttachments → prior=0 is EXPECTED
 *     (fresh conversation, initialMessages has no DTD)
 *   - compact_full: compact.ts passes [] → prior=0 is EXPECTED
 *   - compact_partial: compact.ts passes messagesToKeep → depends on what survived
 *   - reactive_compact: reactiveCompact.ts passes preservedMessages → same
 * Without this the 96%-prior=0 stat is dominated by EXPECTED buckets and
 * the real main-thread cross-turn bug (if any) is invisible in BQ.
 */
export type DeferredToolsDeltaScanContext = {
  callSite:
    | 'attachments_main'
    | 'attachments_subagent'
    | 'compact_full'
    | 'compact_partial'
    | 'reactive_compact'
  querySource?: string
}

/**
 * True → announce deferred tools via persisted delta attachments.
 * False → claude.ts keeps its per-call <available-deferred-tools>
 * header prepend (the attachment does not fire).
 */
export function isDeferredToolsDeltaEnabled(): boolean {
  return (
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_glacier_2xr', false)
  )
}

/**
 * Diff the current deferred-tool pool against what's already been
 * announced in this conversation (reconstructed by scanning for prior
 * deferred_tools_delta attachments). Returns null if nothing changed.
 *
 * A name that was announced but has since stopped being deferred — yet
 * is still in the base pool — is NOT reported as removed. It's now
 * loaded directly, so telling the model "no longer available" would be
 * wrong.
 */
export function getDeferredToolsDelta(
  tools: Tools,
  messages: Message[],
  scanContext?: DeferredToolsDeltaScanContext,
  protocol: ToolSearchProtocol = 'native',
): DeferredToolsDelta | null {
  const announced = new Set<string>()
  let attachmentCount = 0
  let dtdCount = 0
  const attachmentTypesSeen = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'attachment') continue
    attachmentCount++
    attachmentTypesSeen.add(msg.attachment.type)
    if (msg.attachment.type !== 'deferred_tools_delta') continue
    dtdCount++
    for (const n of msg.attachment.addedNames) announced.add(n)
    for (const n of msg.attachment.removedNames) announced.delete(n)
  }

  const deferred: Tool[] = tools.filter(tool =>
    isToolDeferredForProtocol(tool, protocol),
  )
  const deferredNames = new Set(deferred.map(t => t.name))
  const poolNames = new Set(tools.map(t => t.name))

  const added = deferred.filter(t => !announced.has(t.name))
  const removed: string[] = []
  for (const n of announced) {
    if (deferredNames.has(n)) continue
    if (!poolNames.has(n)) removed.push(n)
    // else: undeferred — silent
  }

  if (added.length === 0 && removed.length === 0) return null

  // Diagnostic for the inc-4747 scan-finds-nothing bug. Round-1 fields
  // (messagesLength/attachmentCount/dtdCount from #23167) showed 45.6% of
  // events have attachments-but-no-DTD, but those numbers are confounded:
  // subagent first-fires and compact-path scans have EXPECTED prior=0 and
  // dominate the stat. callSite/querySource/attachmentTypesSeen split the
  // buckets so the real main-thread cross-turn failure is isolable in BQ.
  logEvent('tengu_deferred_tools_pool_change', {
    addedCount: added.length,
    removedCount: removed.length,
    priorAnnouncedCount: announced.size,
    messagesLength: messages.length,
    attachmentCount,
    dtdCount,
    callSite: (scanContext?.callSite ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource: (scanContext?.querySource ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    attachmentTypesSeen: [...attachmentTypesSeen]
      .sort()
      .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return {
    addedNames: added.map(t => t.name).sort(),
    addedLines: added.map(formatDeferredToolLine).sort(),
    removedNames: removed.sort(),
  }
}

/**
 * Check whether deferred tools exceed the auto-threshold for enabling TST.
 * Tries exact token count first; falls back to character-based heuristic.
 */
async function checkAutoThreshold(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  model: string,
  protocol: ActiveToolSearchProtocol,
): Promise<{
  enabled: boolean
  debugDescription: string
  metrics: Record<string, number>
}> {
  // Try exact token count first (cached, one API call per toolset change)
  const deferredToolTokens = await getDeferredToolTokenCount(
    tools,
    getToolPermissionContext,
    agents,
    model,
    protocol,
  )

  if (deferredToolTokens !== null) {
    const threshold = getAutoToolSearchTokenThreshold(model)
    return {
      enabled: deferredToolTokens >= threshold,
      debugDescription:
        `${deferredToolTokens} tokens (threshold: ${threshold}, ` +
        `${getAutoToolSearchPercentage()}% of context)`,
      metrics: { deferredToolTokens, threshold },
    }
  }

  // Fallback: character-based heuristic when token API is unavailable
  const deferredToolDescriptionChars =
    await calculateDeferredToolDescriptionChars(
      tools,
      getToolPermissionContext,
      agents,
      protocol,
    )
  const charThreshold = getAutoToolSearchCharThreshold(model)
  return {
    enabled: deferredToolDescriptionChars >= charThreshold,
    debugDescription:
      `${deferredToolDescriptionChars} chars (threshold: ${charThreshold}, ` +
      `${getAutoToolSearchPercentage()}% of context) (char fallback)`,
    metrics: { deferredToolDescriptionChars, charThreshold },
  }
}
