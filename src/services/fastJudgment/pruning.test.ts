import { describe, expect, test } from 'bun:test'
import { pruneWithFastJudgment } from '../smartPruningOptimization.js'
import type { JudgmentRequest, JudgmentResult } from './service.js'

type Message = { type: string; message: { content: unknown } }
function conversation(tool = 'Read', text = 'background '.repeat(300)): Message[] {
  return [
    { type: 'user', message: { content: 'Only adjust the sidebar indentation. Keep keyboard behavior unchanged.' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'old', name: tool, input: { file_path: '/src/old.ts' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'old', content: text }] } },
    ...Array.from({ length: 22 }, (_, index) => ({ type: 'assistant', message: { content: `Work step ${index}` } })),
    { type: 'user', message: { content: 'Continue.' } },
  ]
}
function judge(choice = 'shorten', confidence = 0.99, probability = 0.99) {
  const requests: JudgmentRequest[] = []
  return { requests, async decide(request: JudgmentRequest): Promise<JudgmentResult> {
    requests.push(request)
    return { source: 'network', answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, {
      type: 'choice' as const, choice, confidence,
      probabilities: { shorten: probability, keep: 1 - probability },
    }])) }
  } }
}
function output(messages: Message[]) {
  return (messages[2]!.message.content as Array<{ content: string }>)[0]!.content
}

describe('fast context decisions', () => {
  test('shortens only old eligible tool output, preserves pairing and original history', async () => {
    const original = conversation()
    const snapshot = structuredClone(original)
    const evaluator = judge()
    const result = await pruneWithFastJudgment(original, 'balanced', evaluator)
    expect(result.prunedToolResults).toBe(1)
    expect(result.savedCharacters).toBeGreaterThan(1000)
    expect(output(result.messages)).toContain('[Fast judgment:')
    expect(original).toEqual(snapshot)
    expect(result.messages.length).toBe(original.length)
    expect(result.messages[1]).toEqual(original[1])
    expect(result.messages[2]!.message.content).toMatchObject([{ tool_use_id: 'old' }])
    expect(evaluator.requests[0]?.state).toMatchObject({
      userRequests: ['Only adjust the sidebar indentation. Keep keyboard behavior unchanged.', 'Continue.'],
      candidates: [{ path: '/src/old.ts', text: output(original) }],
    })
  })

  test('preserves keep decisions, uncertainty and unavailable service', async () => {
    for (const evaluator of [judge('keep'), judge('shorten', 0.3), judge('shorten', 0.9, 0.8), { decide: async (): Promise<JudgmentResult> => ({ answers: null, source: 'fallback' }) }]) {
      const original = conversation()
      expect((await pruneWithFastJudgment(original, 'balanced', evaluator)).messages).toEqual(original)
    }
  })

  test('does not send recent results, errors, mutations, mixed media or oversized candidates', async () => {
    const error = conversation('Read', 'background '.repeat(300) + '\nError: still broken')
    const mutation = conversation('Edit')
    const oversized = conversation('Read', 'x'.repeat(13000))
    const recent = conversation().slice(0, 3)
    const flaggedError = conversation()
    ;(flaggedError[2]!.message.content as Array<Record<string, unknown>>)[0]!.is_error = true
    const mixed = conversation()
    ;(mixed[2]!.message.content as Array<Record<string, unknown>>)[0]!.content = [{ type: 'text', text: 'x'.repeat(3000) }, { type: 'image' }]
    for (const original of [error, mutation, oversized, recent, flaggedError, mixed]) {
      const evaluator = judge()
      expect((await pruneWithFastJudgment(original, 'balanced', evaluator)).messages).toEqual(original)
      expect(evaluator.requests.length).toBe(0)
    }
  })

  test('batches candidates in one call and preserves independent decisions within a message', async () => {
    const original = conversation('Grep', 'a'.repeat(3000))
    ;(original[1]!.message.content as unknown[]).push({ type: 'tool_use', id: 'second', name: 'Glob', input: {} })
    ;(original[2]!.message.content as unknown[]).push({ type: 'tool_result', tool_use_id: 'second', content: 'b'.repeat(3000) })
    const evaluator = judge()
    const result = await pruneWithFastJudgment(original, 'balanced', evaluator)
    expect(evaluator.requests.length).toBe(1)
    expect(Object.keys(evaluator.requests[0]!.questions)).toHaveLength(2)
    expect(result.prunedToolResults).toBe(2)
  })

  test('skips if task context exceeds budget instead of dropping earlier requirements', async () => {
    const original = conversation()
    original[0]!.message.content = 'constraint '.repeat(2000)
    const evaluator = judge()
    expect((await pruneWithFastJudgment(original, 'balanced', evaluator)).messages).toEqual(original)
    expect(evaluator.requests).toHaveLength(0)
  })

  test('honors cancellation before sending any context', async () => {
    const controller = new AbortController()
    controller.abort()
    const evaluator = judge()
    const original = conversation()
    expect((await pruneWithFastJudgment(original, 'balanced', evaluator, controller.signal)).messages).toEqual(original)
    expect(evaluator.requests).toHaveLength(0)
  })

  test('recent state excludes reasoning and media but changes invalidate the context version', async () => {
    const original = conversation()
    original[original.length - 2]!.message.content = [
      { type: 'thinking', thinking: 'private-reasoning', signature: 'private-signature' },
      { type: 'image', source: { data: 'private-image-bytes' } },
      { type: 'text', text: 'Inspect the new failure.' },
    ]
    const evaluator = judge()
    await pruneWithFastJudgment(original, 'balanced', evaluator)
    const first = JSON.stringify(evaluator.requests[0]!.state)
    expect(first).toContain('Inspect the new failure.')
    expect(first).not.toContain('private-reasoning')
    expect(first).not.toContain('private-signature')
    expect(first).not.toContain('private-image-bytes')
    original[original.length - 2]!.message.content = 'A different failure.'
    await pruneWithFastJudgment(original, 'balanced', evaluator)
    const states = evaluator.requests.map(request => request.state as { contextVersion: string })
    expect(states[0]!.contextVersion).not.toBe(states[1]!.contextVersion)
  })
})
