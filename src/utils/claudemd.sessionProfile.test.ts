import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getInstructionSessionProfile,
  instructionMemoryAppliesToCurrentContext,
  processMemoryFile,
} from './claudemd.js'

const originalProfile = process.env.CYBERCODE_INSTRUCTION_PROFILE
const originalRemote = process.env.CLAUDE_CODE_REMOTE
const temporaryRoots: string[] = []

afterEach(async () => {
  if (originalProfile === undefined) {
    delete process.env.CYBERCODE_INSTRUCTION_PROFILE
  } else {
    process.env.CYBERCODE_INSTRUCTION_PROFILE = originalProfile
  }
  if (originalRemote === undefined) delete process.env.CLAUDE_CODE_REMOTE
  else process.env.CLAUDE_CODE_REMOTE = originalRemote

  await Promise.all(
    temporaryRoots.splice(0).map(path =>
      rm(path, { recursive: true, force: true }),
    ),
  )
})

describe('instruction memory session profiles', () => {
  test('defaults to coding and detects remote sessions', () => {
    delete process.env.CYBERCODE_INSTRUCTION_PROFILE
    delete process.env.CLAUDE_CODE_REMOTE
    expect(getInstructionSessionProfile()).toBe('coding')

    process.env.CLAUDE_CODE_REMOTE = 'true'
    expect(getInstructionSessionProfile()).toBe('remote')

    process.env.CYBERCODE_INSTRUCTION_PROFILE = ' OpenClaw '
    expect(getInstructionSessionProfile()).toBe('openclaw')
  })

  test('keeps non-matching session instructions out of the loaded context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cyber-instruction-profile-'))
    temporaryRoots.push(root)
    const file = join(root, 'openclaw.md')
    await writeFile(
      file,
      ['---', 'sessions: [openclaw]', '---', 'Run heartbeat rules.'].join(
        '\n',
      ),
    )

    process.env.CYBERCODE_INSTRUCTION_PROFILE = 'coding'
    expect(await processMemoryFile(file, 'User', new Set(), true)).toEqual([])

    process.env.CYBERCODE_INSTRUCTION_PROFILE = 'openclaw'
    const loaded = await processMemoryFile(file, 'User', new Set(), true)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({
      sessions: ['openclaw'],
      content: 'Run heartbeat rules.',
    })
  })

  test('matches project selectors without guessing instruction content', () => {
    const rule = { sessions: ['coding'], projects: ['**/cybercode'] }

    expect(
      instructionMemoryAppliesToCurrentContext(rule, {
        profile: 'coding',
        projectPath: '/workspace/products/cybercode',
      }),
    ).toBe(true)
    expect(
      instructionMemoryAppliesToCurrentContext(rule, {
        profile: 'openclaw',
        projectPath: '/workspace/products/cybercode',
      }),
    ).toBe(false)
    expect(
      instructionMemoryAppliesToCurrentContext(rule, {
        profile: 'coding',
        projectPath: '/workspace/products/another-app',
      }),
    ).toBe(false)
  })
})
