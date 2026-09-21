import { fingerprint, type BrowserAction, type BrowserObservation, type BrowserTaskDriver } from './loop.js'

// beforeDispatch runs inside the normal tool runner, after permission and pre-tool hooks.
export type BrowserInvoke = (name: string, args: Record<string, unknown>, beforeDispatch?: () => Promise<void>) => Promise<string>
export function createBrowserDriver(invoke: BrowserInvoke, active: () => boolean): BrowserTaskDriver {
  const call = (name: string, args: Record<string, unknown> = {}, guard?: () => Promise<void>) => {
    if (!active()) throw new Error('DISABLED_OR_CANCELLED')
    return invoke(name, { ...args, timeoutMs: 5000 }, guard)
  }
  const observe = async (): Promise<BrowserObservation> => {
    const url = await call('agent_browser_get_url')
    const snapshot = await call('agent_browser_snapshot', { interactive: false, compact: true })
    const text = await call('agent_browser_get_text', { selector: 'body' })
    return { url, snapshot, text }
  }
  return {
    observe,
    async act(action: BrowserAction, expected: BrowserObservation) {
      await call(action.tool, action.args, async () => {
        if (!active()) throw new Error('DISABLED_OR_CANCELLED')
        if (fingerprint(await observe()) !== fingerprint(expected)) throw new Error('PAGE_CHANGED')
        if (!active()) throw new Error('DISABLED_OR_CANCELLED')
      })
    },
  }
}
