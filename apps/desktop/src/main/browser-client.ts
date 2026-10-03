/** Packaged Browser Client and first-call skill; transport owns invocation identity. */
export const BROWSER_SKILL = `Browser Use operates the same pages as the right-hand Browser Panel.
Start with const browser = await agent.browsers.get("iab"); then await browser.tabs.list()
or await browser.tabs.open("http://localhost:3000"). Inspect await tab.snapshot() before
acting; use fresh references and verify the result with another snapshot or screenshot.
API (all remote operations are async):
browser.tabs.list/open(url)/get(id)/selected()/select(id)/close(id).
tab.url()/title()/goto(url)/back()/forward()/reload()/snapshot().
tab.query({ref}|{role,name}|{text}|{css}) returns a locator with
click()/fill(value)/type(text)/press(key)/selectOption(value).
tab.frame(frameId) returns the same DOM interface for that frame.
tab.press(key), scroll({x,y}), screenshot(), evaluate(expression,args?),
console({since?,limit?}), network({since?,limit?}).
nodeRepl.write(value) emits text; nodeRepl.emitImage(await tab.screenshot()) emits an image.
Variables and top-level await persist per conversation and agent. Await every browser
operation: callbacks left after an invocation cannot access the browser. Reset clears
only Node state. Node has local machine access and follows the tool's execution approval.
Only iab is supported; tabs belong to this conversation and share the Panel login state.`;

export interface BrowserRpc { method: string; tabId?: string; args?: unknown[]; frameId?: string }
export type BrowserTransport = (request: BrowserRpc) => Promise<unknown>;
export function createBrowserClient(invoke: BrowserTransport) {
  const page = (tabId: string, frameId?: string): Record<string, any> => {
    const call = (method: string, ...args: unknown[]) => invoke({ method, tabId, args, frameId });
    const result: Record<string, any> = { id: tabId, frame: (id: string) => page(tabId, id) };
    for (const method of ['url','title','goto','back','forward','reload','snapshot','press','scroll','screenshot','evaluate','console','network']) {
      result[method] = (...args: unknown[]) => call(method, ...args);
    }
    result.press = (key: string) => call("press", null, key);
    result.query = (selector: unknown) => Object.fromEntries(
      ['click','fill','type','press','selectOption'].map(method => [method,
        (...args: unknown[]) => call(method, selector, ...args)]));
    return result;
  };
  const tabResult = (value: unknown) => {
    if (value == null) return null;
    const id = typeof value === 'string' ? value : (value as { id?: string; tabId?: string }).id ?? (value as { tabId?: string }).tabId;
    if (!id) throw new Error('Browser Host returned a tab without an id');
    return page(id);
  };
  const tabs = {
    list: () => invoke({ method: 'tabs.list', args: [] }),
    open: async (url: string) => tabResult(await invoke({ method: 'tabs.open', args: [url] })),
    get: async (id: string) => tabResult(await invoke({ method: 'tabs.get', tabId: id, args: [] })),
    selected: async () => tabResult(await invoke({ method: 'tabs.selected', args: [] })),
    select: async (id: string) => tabResult(await invoke({ method: 'tabs.select', tabId: id, args: [] })),
    close: (id: string) => invoke({ method: 'tabs.close', tabId: id, args: [] }),
  };
  return { browsers: { get: async (name: string) => {
    if (name !== 'iab') throw new Error('Only the iab browser is supported');
    return { tabs };
  } } };
}

export interface BrowserReplError { name: string; message: string; code?: string }
/** Only clone-safe error metadata crosses the utility-process boundary. */
export function serializeBrowserError(value: unknown): BrowserReplError {
  const error = value as { name?: unknown; message?: unknown; code?: unknown } | null;
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: (typeof error?.message === 'string' ? error.message : String(value)).slice(0, 65536),
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
  };
}
