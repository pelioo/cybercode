import { createHash } from 'node:crypto'

export const CLAUDE_CODE_SESSION_HEADER = 'x-claude-code-session-id'

export function resolvePromptCacheSessionId(
  request: Request,
  explicitSessionId?: string,
): string | undefined {
  const value = explicitSessionId ?? request.headers.get(CLAUDE_CODE_SESSION_HEADER)
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

export function buildOpenAIPromptCacheKey(
  sessionId: string | undefined,
): string | undefined {
  if (!sessionId) return undefined

  const digest = createHash('sha256')
    .update('cybercode-prompt-cache-v1\0')
    .update(sessionId)
    .digest('base64url')

  return `cybercode_${digest}`
}

export function supportsOpenAIPromptCacheKey(
  baseUrl: string,
  oauthProviderId?: string,
): boolean {
  if (oauthProviderId === 'codex') return true

  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}
