import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { _resetConfigHomeDirForTesting } from '../../utils/envUtils'
import { fastJudgmentService } from '../../services/fastJudgment/service'

let dispatches = 0
let permissions = 0
let pageChanged = false
let changeDuringPermission = false
let changeArgs = false
let hookFeedback = false
const originalConfig = process.env.CYBER_CONFIG_DIR
let configDir: string
let decide: ReturnType<typeof mock> | undefined
// Supply the surrounding orchestration shell without globally mocking a module.
// Exercise the production tool,
// permission forwarding, guarded dispatch, snapshot reader and decision loop.
async function* testRunner(block: any, message: any, canUseTool: any, context: any) {
    const tool = context.options.tools.find((t: any) => t.name === block.name)
    const permission = await canUseTool(tool, block.input, context, message, block.id)
    let text = 'permission denied'
    let error = permission.behavior !== 'allow'
    if (!error) {
      try {
        const input = changeArgs && block.name.endsWith('click') ? { ...block.input, selector: '@other' } : block.input
        text = (await tool.call(input)).data
      } catch (err) { text = String(err); error = true }
    }
    yield { message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: block.id, is_error: error, content: text }] } } }
    if (hookFeedback && block.name.endsWith('click')) yield { message: { type: 'attachment', attachment: { type: 'hook_additional_context', content: ['Review before continuing'] } } }
}
const { createBrowserTaskTool } = await import('./BrowserTaskTool')
const BrowserTaskTool = createBrowserTaskTool(testRunner as any)
let originalDecide = fastJudgmentService.decide
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'browser-tool-'))
  process.env.CYBER_CONFIG_DIR = configDir
  _resetConfigHomeDirForTesting()
  fastJudgmentService.updateConfig({ enabled: true, browserEnabled: true })
  dispatches = permissions = 0
  pageChanged = changeDuringPermission = changeArgs = hookFeedback = false
  originalDecide = fastJudgmentService.decide
  decide = mock(async (request: any) => ({ source: 'network' as const, answers: Object.fromEntries(Object.entries(request.questions).map(([id,q]: any) => {
    const keys = Object.keys(q.criteria)
    const choice = id === 'operation' ? 'CLICK' : 'e1'
    return [id, { type: 'choice' as const, choice, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k,k===choice?1:0])) }]
  })) }))
  fastJudgmentService.decide = decide
})
afterEach(() => {
  fastJudgmentService.decide = originalDecide
  if (originalConfig === undefined) delete process.env.CYBER_CONFIG_DIR
  else process.env.CYBER_CONFIG_DIR = originalConfig
  _resetConfigHomeDirForTesting()
  rmSync(configDir,{recursive:true,force:true})
})
function context(includeClick = true): any {
  const tools = ['get_url','snapshot','get_text', ...(includeClick ? ['click'] : [])].map(name => ({
    name: 'mcp__agent-browser__agent_browser_'+name,
    mcpInfo: { serverName: 'agent-browser', toolName: 'agent_browser_'+name },
    inputSchema: z.record(z.string(),z.unknown()),
    call: async () => {
      if(name==='click') { dispatches++; return {data:'Clicked'} }
      return { data: name==='get_url' ? 'http://localhost/test' : name==='snapshot' ? '- button "Search" [ref=e1]' : pageChanged ? 'New page' : 'Search page' }
    },
  }))
  return { options:{tools}, abortController:new AbortController() }
}
const parent: any = {message:{content:[]}}
const allow = async (tool: any, input: any) => {
  if(tool.name.endsWith('click')) { permissions++; if(changeDuringPermission) pageChanged=true }
  return {behavior:'allow',updatedInput:input}
}
describe('BrowserTask runtime dispatch', () => {
  test('executes via the normal runner and forwards each action permission', async () => {
    const result = await BrowserTaskTool.call({goal:'Search',maxSteps:1}, context(), allow as any, parent)
    expect(dispatches).toBe(1)
    expect(permissions).toBe(1)
    expect(result.data.steps[0]?.state).toBe('completed')
  })
  test('denied clicks never dispatch', async () => {
    const deny: any = async (tool: any, input: any) => tool.name.endsWith('click') ? {behavior:'deny',message:'Denied'} : allow(tool,input)
    const result = await BrowserTaskTool.call({goal:'Search'},context(),deny,parent)
    expect(dispatches).toBe(0)
    expect(result.data.status).toBe('handoff')
  })
  test('checks freshness after a permission wait, immediately before dispatch', async () => {
    changeDuringPermission = true
    const result = await BrowserTaskTool.call({goal:'Search'},context(),allow as any,parent)
    expect(permissions).toBe(1)
    expect(dispatches).toBe(0)
    expect(result.data.status).toBe('handoff')
  })
  test('changed hook arguments and unavailable tools cannot expand capabilities', async () => {
    changeArgs = true
    expect((await BrowserTaskTool.call({goal:'Search'},context(),allow as any,parent)).data.status).toBe('handoff')
    changeArgs = false
    expect((await BrowserTaskTool.call({goal:'Search'},context(false),allow as any,parent)).data.status).toBe('handoff')
    expect(dispatches).toBe(0)
  })
  test('returns hook feedback to the main model and does not continue the loop', async () => {
    hookFeedback = true
    const result = await BrowserTaskTool.call({goal:'Search'},context(),allow as any,parent)
    expect(dispatches).toBe(1)
    expect(result.data.status).toBe('handoff')
    expect(result.data.reason).toContain('Review before continuing')
  })
  test('disabled browser setting prevents even observation and model calls', async () => {
    fastJudgmentService.updateConfig({browserEnabled:false})
    expect(BrowserTaskTool.isEnabled()).toBe(false)
    await BrowserTaskTool.call({goal:'Search'},context(),allow as any,parent)
    expect(decide).not.toHaveBeenCalled()
    expect(dispatches).toBe(0)
  })
})
