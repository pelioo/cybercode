import { describe, expect, test } from 'bun:test'
import { buildBrowserDecision, runBrowserTask, type BrowserObservation, type BrowserTaskDriver } from './loop'
import { createBrowserDriver } from './driver'
import type { JudgmentRequest, JudgmentResult } from '../fastJudgment/service'
const page: BrowserObservation = { url: 'http://localhost/test', snapshot: '- textbox "Query" [ref=e1]\n- button "Search" [ref=e2]\n- button "Unavailable" [disabled, ref=e3]', text: 'Search catalog' }
function result(request: JudgmentRequest, operation: string, target = 'e2', confidence = 0.99): JudgmentResult {
  return { source: 'network', answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const keys = Object.keys(question.criteria)
    const choice = id === 'operation' ? operation : keys.includes(target) ? target : 'NONE'
    const probabilities = Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0]))
    return [id, { type: 'choice', choice, probabilities, confidence }]
  })) }
}
function fixture() {
  let current = page
  const actions: unknown[] = []
  const driver: BrowserTaskDriver = { observe: async () => current, act: async action => { actions.push(action); current = { ...page, text: 'Search results displayed' } } }
  return { driver, actions, change: (value: BrowserObservation) => { current = value } }
}
describe('browser acceleration', () => {
  test('batches operation and compatible targets, never invents field text or includes disabled controls', () => {
    const { request, groups } = buildBrowserDecision(page, { goal: 'Search for apple', fields: [{ label: 'Query', text: 'apple' }] }, [])
    expect(Object.keys(request.questions)).toEqual(['FILL_target', 'CLICK_target', 'operation'])
    expect(groups.FILL?.e1?.args).toEqual({ selector: '@e1', text: 'apple' })
    expect(groups.CLICK?.e3).toBeUndefined()
    expect(buildBrowserDecision(page, { goal: 'Search' }, []).groups.FILL).toBeUndefined()
  })
  test('executes a step then returns completion only for main-model verification', async () => {
    const f = fixture()
    let calls = 0
    const output = await runBrowserTask({ goal: 'Find results' }, f.driver, { decide: async request => result(request, calls++ ? 'DONE' : 'CLICK') }, { enabled: () => true })
    expect(output.status).toBe('verify')
    expect(output.steps).toHaveLength(1)
    expect(output.steps[0]?.state).toBe('completed')
    expect(f.actions).toEqual([{ tool: 'agent_browser_click', args: { selector: '@e2' }, label: 'Search' }])
    expect(output.page?.text).toBe('Search results displayed')
  })
  test('disabled and cancelled flows perform no browser or judgment calls', async () => {
    let calls = 0
    const driver = { observe: async () => { calls++; return page }, act: async () => { calls++ } }
    const judge = { decide: async (): Promise<JudgmentResult> => { calls++; return { answers: null, source: 'fallback' } } }
    await runBrowserTask({ goal: 'test' }, driver, judge, { enabled: () => false })
    await runBrowserTask({ goal: 'test' }, driver, judge, { enabled: () => true, signal: AbortSignal.abort() })
    expect(calls).toBe(0)
  })
  test('uncertain, invalid targets and network failures hand control back without clicks', async () => {
    for (const mode of ['uncertain', 'invalid', 'unavailable']) {
      const f = fixture()
      const output = await runBrowserTask({ goal: 'test' }, f.driver, { decide: async request => mode === 'unavailable' ? { answers: null, source: 'fallback' } : result(request, 'CLICK', mode === 'invalid' ? 'missing' : 'e2', mode === 'uncertain' ? 0.5 : 1) }, { enabled: () => true })
      expect(output.status).toBe('handoff')
      expect(f.actions).toHaveLength(0)
    }
  })
  test('disabling or cancellation during a judgment prevents execution', async () => {
    const f = fixture()
    let enabled = true
    await runBrowserTask({ goal: 'test' }, f.driver, { decide: async request => { enabled = false; return result(request, 'CLICK') } }, { enabled: () => enabled })
    expect(f.actions).toHaveLength(0)
  })
  test('ambiguous action failure records attempted state and never retries', async () => {
    const f = fixture()
    let calls = 0
    f.driver.act = async () => { calls++; throw new Error('Disconnected after click') }
    const output = await runBrowserTask({ goal: 'test' }, f.driver, { decide: async request => result(request, 'CLICK') }, { enabled: () => true })
    expect(calls).toBe(1)
    expect(output.steps[0]?.state).toBe('attempted')
    expect(output.status).toBe('handoff')
  })
  test('stops on no progress, action budget, and page changes after DONE', async () => {
    const f = fixture()
    f.driver.act = async () => {}
    const judge = { decide: async (request: JudgmentRequest) => result(request, 'CLICK') }
    expect((await runBrowserTask({ goal: 'test' }, f.driver, judge, { enabled: () => true })).reason).toBe('NO_PROGRESS')
    expect((await runBrowserTask({ goal: 'test', maxSteps: 1 }, f.driver, judge, { enabled: () => true })).reason).toBe('STEP_BUDGET')
    const output = await runBrowserTask({ goal: 'test' }, f.driver, { decide: async request => { f.change({ ...page, url: 'http://localhost/changed' }); return result(request, 'DONE') } }, { enabled: () => true })
    expect(output.reason).toBe('PAGE_CHANGED')
  })
  test('driver checks fresh state after permission wait and blocks stale refs', async () => {
    const calls: string[] = []
    let current = page
    const driver = createBrowserDriver(async (name, _args, guard) => {
      if (guard) { current = { ...page, text: 'Changed during permission' }; await guard() }
      calls.push(name)
      return name === 'agent_browser_get_url' ? current.url : name === 'agent_browser_snapshot' ? current.snapshot : current.text
    }, () => true)
    await expect(driver.act({ tool: 'agent_browser_click', args: { selector: '@e2' }, label: 'Search' }, page)).rejects.toThrow('PAGE_CHANGED')
    expect(calls).not.toContain('agent_browser_click')
  })
  test('does not send oversized pages or overlarge action spaces to the judge', async () => {
    const f = fixture()
    let calls = 0
    const judge = { decide: async (): Promise<JudgmentResult> => { calls++; return { answers: null, source: 'fallback' } } }
    f.change({ ...page, text: 'x'.repeat(25000) })
    expect((await runBrowserTask({ goal: 'test' }, f.driver, judge, { enabled: () => true })).reason).toBe('PAGE_TOO_LARGE')
    f.change({ ...page, snapshot: Array.from({ length: 25 }, (_, i) => `- button "Button ${i}" [ref=e${i}]`).join('\n') })
    expect((await runBrowserTask({ goal: 'test' }, f.driver, judge, { enabled: () => true })).reason).toBe('TOO_MANY_TARGETS')
    expect(calls).toBe(0)
  })
})
