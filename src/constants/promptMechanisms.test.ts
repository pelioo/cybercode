import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { CODEGRAPH_TOOL_NAME } from '../tools/CodeGraphTool/constants.js'
import { getCodeGraphGuidanceSection } from './prompts.js'

const root = await mkdtemp(join(tmpdir(), 'cyber-prompt-mechanisms-'))

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('conditional mechanism guidance', () => {
  test('only injects CodeGraph guidance when the current project is indexed', async () => {
    const tools = new Set([CODEGRAPH_TOOL_NAME])
    expect(getCodeGraphGuidanceSection(tools, root)).toBeNull()

    const graphDir = join(root, '.codegraph')
    await mkdir(graphDir, { recursive: true })
    await writeFile(join(graphDir, 'codegraph.db'), '')

    expect(getCodeGraphGuidanceSection(tools, root)).toContain(
      'Use CodeGraph before broad scans',
    )
    expect(getCodeGraphGuidanceSection(new Set(), root)).toBeNull()
  })
})
