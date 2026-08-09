export type OpenAIUsageLike = {
  input_tokens?: number
  prompt_tokens?: number
  output_tokens?: number
  completion_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  prompt_tokens_details?: { cached_tokens?: number }
}

export type AnthropicCompatibleUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0
}

export function mapOpenAIUsage(
  usage?: OpenAIUsageLike,
): AnthropicCompatibleUsage {
  const totalInputTokens = tokenCount(
    usage?.input_tokens ?? usage?.prompt_tokens,
  )
  const reportedCachedTokens = tokenCount(
    usage?.input_tokens_details?.cached_tokens ??
      usage?.prompt_tokens_details?.cached_tokens,
  )
  const cachedTokens = Math.min(totalInputTokens, reportedCachedTokens)

  return {
    // OpenAI includes cached tokens in input_tokens/prompt_tokens. Anthropic
    // reports them separately, and CyberCode sums both fields for context use.
    input_tokens: totalInputTokens - cachedTokens,
    output_tokens: tokenCount(
      usage?.output_tokens ?? usage?.completion_tokens,
    ),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cachedTokens,
  }
}
