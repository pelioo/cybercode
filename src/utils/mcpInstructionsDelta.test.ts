import { afterEach, describe, expect, test } from 'bun:test'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { Message } from '../types/message.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
} from './mcpInstructionsDelta.js'

const originalOverride = process.env.CLAUDE_CODE_MCP_INSTR_DELTA

afterEach(() => {
  if (originalOverride === undefined) {
    delete process.env.CLAUDE_CODE_MCP_INSTR_DELTA
  } else {
    process.env.CLAUDE_CODE_MCP_INSTR_DELTA = originalOverride
  }
})

describe('MCP instruction delta', () => {
  test('uses provider-neutral delta delivery by default with an explicit fallback', () => {
    delete process.env.CLAUDE_CODE_MCP_INSTR_DELTA
    expect(isMcpInstructionsDeltaEnabled()).toBe(true)

    process.env.CLAUDE_CODE_MCP_INSTR_DELTA = 'false'
    expect(isMcpInstructionsDeltaEnabled()).toBe(false)

    process.env.CLAUDE_CODE_MCP_INSTR_DELTA = 'true'
    expect(isMcpInstructionsDeltaEnabled()).toBe(true)
  })

  test('announces connected instructions once and retracts them on disconnect', () => {
    const clients = [
      {
        type: 'connected',
        name: 'calendar',
        instructions: 'Use ISO dates.',
      },
      {
        type: 'connected',
        name: 'silent-server',
      },
    ] as MCPServerConnection[]

    const first = getMcpInstructionsDelta(clients, [], [])
    expect(first).toEqual({
      addedNames: ['calendar'],
      addedBlocks: ['## calendar\nUse ISO dates.'],
      removedNames: [],
    })

    const history = [
      {
        type: 'attachment',
        attachment: { type: 'mcp_instructions_delta', ...first! },
      },
    ] as Message[]
    expect(getMcpInstructionsDelta(clients, history, [])).toBeNull()
    expect(getMcpInstructionsDelta([], history, [])).toEqual({
      addedNames: [],
      addedBlocks: [],
      removedNames: ['calendar'],
    })
  })
})
