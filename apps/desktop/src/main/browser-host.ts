import type { WebContents, Session } from 'electron';
import type { BrowserAgentAction, BrowserUiCommand, BrowserWindowState } from '../../../../packages/shared/src/browser';
import { isUiBrowserUrl } from '../browser-policy';
import { BrowserHostError, BrowserSessionRegistry, type BrowserRecord } from './browser-session-registry';

export interface BrowserInvocation {
  windowId: number; conversationId: string; agentId: string; turnId: string; invocationId: string; signal?: AbortSignal;
}
interface Automation { call(method: string, args?: unknown[], frameId?: string, signal?: AbortSignal, onAction?: (action: BrowserAgentAction) => void): Promise<unknown>; dispose(): void }
interface WindowEntry {
  embedder: WebContents; conversationId: string | null; selected: Record<string, string>;
  viewport: {width: number; height: number}; focusRequest: BrowserWindowState['focusRequest']; nonce: number;
}
interface GuestEntry { guest: WebContents; windowId: number; tabId: string | null; dispose?: () => void; automation?: Automation }
/** Shared guest ownership, UI state and revocable invocation capabilities. */
export class BrowserHost {
  readonly registry = new BrowserSessionRegistry();
  private readonly windows = new Map<number, WindowEntry>();
  private readonly guests = new Map<number, GuestEntry>();
  private readonly tabSignals = new Map<string, AbortController>();
  private readonly navigationEpoch = new Map<string, number>();
  private readonly invocations = new Map<string, { context: BrowserInvocation; abort: AbortController }>();
  private readonly listeners = new Set<(windowId: number, state: BrowserWindowState) => void>();
  private readonly cursors = new Map<string, { invocationId: string; timer: ReturnType<typeof setTimeout> }>();
  private cursorSequence = 0;
  constructor(private readonly automationFactory: (guest: WebContents) => Automation, private readonly browserSession: Session) {}
  subscribe(listener: (windowId: number, state: BrowserWindowState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  registerWindow(windowId: number, embedder: WebContents): void {
    if (this.windows.has(windowId)) throw new BrowserHostError('duplicate-window', 'Window already registered');
    this.windows.set(windowId, { embedder, conversationId: null, selected: {}, viewport: {width: 1024,height: 768}, focusRequest: null, nonce: 0 });
    embedder.once('destroyed', () => this.closeWindow(windowId));
    embedder.on('render-process-gone', () => {
      for (const tab of this.registry.list(windowId)) this.closeTab(tab);
      for (const entry of this.invocations.values()) if (entry.context.windowId === windowId) entry.abort.abort();
    });
  }
  registerGuest(windowId: number, guest: WebContents): void {
    const win = this.window(windowId);
    if (guest.hostWebContents !== win.embedder || guest.session !== this.browserSession)
      throw new BrowserHostError('invalid-guest', 'Guest embedder or partition is invalid');
    if (this.guests.has(guest.id)) throw new BrowserHostError('duplicate-guest', 'Guest already registered');
    const entry: GuestEntry = { guest, windowId, tabId: null }; this.guests.set(guest.id, entry);
    guest.once('destroyed', () => {
      if (entry.tabId) {
        const tab = this.registry.list(windowId).find(t => t.id === entry.tabId);
        if (tab) this.closeTab(tab);
      }
      entry.dispose?.(); entry.automation?.dispose(); this.guests.delete(guest.id);
    });
  }
  state(windowId: number): BrowserWindowState {
    const win = this.window(windowId);
    return { tabs: this.registry.list(windowId).map(({windowId: _w, guestId: _g, generation: _n, ...tab}) => ({...tab})),
      selected: {...win.selected}, activeConversationId: win.conversationId, focusRequest: win.focusRequest,
      operating: [...new Set([...this.invocations.values()].filter(i => i.context.windowId === windowId).map(i => i.context.conversationId))] };
  }
  resolveWindow(conversationId: string): number {
    const current = [...this.windows].find(([,w]) => w.conversationId === conversationId);
    if (current) return current[0];
    const tab = [...this.windows.keys()].find(id => this.registry.list(id, conversationId).length > 0);
    if (tab !== undefined) return tab;
    if (this.windows.size === 1) return this.windows.keys().next().value!;
    throw new BrowserHostError('window-unavailable', 'No window is associated with this conversation');
  }
  async command(windowId: number, sender: WebContents, mainFrame: boolean, input: BrowserUiCommand): Promise<BrowserWindowState> {
    const win = this.window(windowId);
    if (sender !== win.embedder || !mainFrame) throw new BrowserHostError('invalid-sender', 'Browser IPC requires the local window main frame');
    if (!input || typeof input !== 'object' || typeof input.type !== 'string') throw new BrowserHostError('invalid-command', 'Invalid browser command');
    if (input.type === 'activate') {
      if (input.conversationId !== null && (typeof input.conversationId !== 'string' || !input.conversationId)) throw new BrowserHostError('invalid-conversation', 'Invalid conversation');
      win.conversationId = input.conversationId;
    } else if (input.type === 'open') {
      this.open(windowId, win.conversationId, input.url ?? 'about:blank', input.id);
    } else if (input.type !== 'state') {
      const owner = input.type === 'bind' || input.type === 'viewport' ? this.registry.list(windowId).find(t => t.id === input.tabId)?.conversationId ?? null : win.conversationId;
      const tab = this.registry.get(input.tabId, windowId, owner, true);
      if (input.type === 'bind') this.bind(tab, input.guestId);
      else if (input.type === 'viewport') {
        if (![input.width,input.height].every(v => Number.isFinite(v) && v > 0 && v <= 16384)) throw new BrowserHostError('invalid-viewport', 'Invalid viewport size');
        tab.width = Math.round(input.width); tab.height = Math.round(input.height);
        win.viewport = {width: tab.width,height: tab.height};
      } else if (input.type === 'select') win.selected[win.conversationId ?? ''] = tab.id;
      else if (input.type === 'close') this.closeTab(tab);
      else await this.navigation(tab, input.type, input.type === 'goto' ? input.url : undefined);
    }
    this.publish(windowId); return this.state(windowId);
  }
  beginInvocation(context: BrowserInvocation): (reason?: 'complete' | 'cancel') => void {
    this.window(context.windowId);
    if (this.invocations.has(context.invocationId)) throw new BrowserHostError('duplicate-invocation', 'Invocation already active');
    const entry = {context,abort: new AbortController()}; this.invocations.set(context.invocationId, entry);
    const revoke = (reason?: 'complete' | 'cancel') => {
      entry.abort.abort(); this.invocations.delete(context.invocationId);
      if (reason === 'cancel' || context.signal?.aborted) for (const tab of this.registry.list(context.windowId)) {
        if (this.cursors.get(tab.id)?.invocationId === context.invocationId) this.settleCursor(tab);
      }
      if (this.windows.has(context.windowId)) this.publish(context.windowId);
    };
    const abort = () => revoke('cancel');
    context.signal?.addEventListener('abort', abort, {once:true});
    if (context.signal?.aborted) revoke(); else this.publish(context.windowId);
    return reason => { context.signal?.removeEventListener('abort',abort); revoke(reason); };
  }
  async invoke(context: BrowserInvocation, method: string, tabId?: string, args: unknown[] = [], frameId?: string): Promise<unknown> {
    const entry = this.invocations.get(context.invocationId);
    if (!entry || entry.context !== context || entry.abort.signal.aborted) throw new BrowserHostError('invocation-ended', 'This browser invocation is no longer active');
    const win = this.window(context.windowId);
    const guard = () => { if (entry.abort.signal.aborted || !this.invocations.has(context.invocationId)) throw new BrowserHostError('invocation-ended', 'Browser invocation stopped'); };
    const execute = async () => {
      guard();
      if (method === 'tabs.list') return this.registry.list(context.windowId).filter(t => t.conversationId === context.conversationId || t.conversationId === null).map(t => ({id:t.id,url:t.url,title:t.title}));
      if (method === 'tabs.open') {
        const tab = this.open(context.windowId,context.conversationId,String(args[0] ?? 'about:blank'));
        this.focus(context,tab); return {id:tab.id};
      }
      if (method === 'tabs.selected') {
        const id = win.selected[context.conversationId] ?? win.selected[''];
        if (!id) return null;
        const selected = this.registry.get(id,context.windowId,context.conversationId,true);
        win.selected[context.conversationId]=selected.id;
        this.publish(context.windowId);
        return {id:selected.id};
      }
      const tab = this.registry.get(tabId ?? String(args[0] ?? ''),context.windowId,context.conversationId,true);
      if (method === 'tabs.get') { this.publish(context.windowId); return {id:tab.id}; }
      if (method === 'tabs.select') { win.selected[context.conversationId] = tab.id; this.focus(context,tab); return {id:tab.id}; }
      if (method === 'tabs.close') { this.closeTab(tab); return; }
      if (method === 'url') return tab.url;
      if (method === 'title') return tab.title;
      const guest = await this.waitGuest(tab,entry.abort.signal);
      guard(); const generation = tab.generation;
      if (['goto','back','forward','reload'].includes(method)) return this.navigation(tab,method, args[0] as string);
      if (!['snapshot','click','fill','type','press','selectOption','scroll','screenshot','evaluate','console','network','query','frame'].includes(method)) throw new BrowserHostError('unsupported-method', 'Unsupported Browser Client method');
      guest.automation ??= this.automationFactory(guest.guest);
      const closeSignal = this.tabSignals.get(tab.id)!.signal;
      let result: unknown;
      try {
        result = await this.cancellable(guest.automation.call(method,args,frameId,entry.abort.signal, action => {
          // Adapter callbacks are scoped to this capability and page generation.
          if (entry.abort.signal.aborted || closeSignal.aborted || generation !== tab.generation) return;
          if (!['click','fill','type','press','selectOption','scroll'].includes(method)) return;
          this.showCursor(tab, context.invocationId, action);
        }),closeSignal,'tab-closed');
      } catch (error) {
        if (this.cursors.get(tab.id)?.invocationId === context.invocationId) { this.settleCursor(tab); this.publish(tab.windowId); }
        if (['CDP_DETACHED','CDP_INIT_FAILED','CDP_ALREADY_ATTACHED','RENDERER_CRASHED'].includes((error as {code?:string})?.code ?? '')) {
          guest.automation?.dispose(); guest.automation=undefined; tab.generation++;
        }
        throw error;
      }
      guard();
      if (this.registry.list(context.windowId).find(t=>t.id===tab.id) !== tab || guest.guest.isDestroyed()) throw new BrowserHostError('tab-closed','Page was closed during the operation');
      if (generation !== tab.generation && !['click','press','snapshot'].includes(method)) throw new BrowserHostError('page-changed','Page navigated during the operation');
      return result;
    };
    return this.cancellable(execute(),entry.abort.signal);
  }
  closeWindow(windowId: number): void {
    for (const entry of this.invocations.values()) if (entry.context.windowId===windowId) { entry.abort.abort(); this.invocations.delete(entry.context.invocationId); }
    for (const tab of this.registry.list(windowId)) this.closeTab(tab);
    for (const [id,g] of this.guests) if(g.windowId===windowId) {g.dispose?.();g.automation?.dispose();this.guests.delete(id);}
    this.windows.delete(windowId);
  }
  dispose(): void { for(const id of [...this.windows.keys()]) this.closeWindow(id); this.listeners.clear(); }
  private window(id: number): WindowEntry { const w=this.windows.get(id); if(!w) throw new BrowserHostError('window-closed','Browser window closed'); return w; }
  private publish(id: number): void { if(this.windows.has(id)) for(const listener of this.listeners) listener(id,this.state(id)); }
  private clearCursor(tab: BrowserRecord): void {
    clearTimeout(this.cursors.get(tab.id)?.timer); this.cursors.delete(tab.id); tab.agentCursor = null;
  }
  private settleCursor(tab: BrowserRecord): void {
    clearTimeout(this.cursors.get(tab.id)?.timer); this.cursors.delete(tab.id);
    if (tab.agentCursor) tab.agentCursor = { ...tab.agentCursor, active: false };
  }
  private showCursor(tab: BrowserRecord, invocationId: string, action: BrowserAgentAction): void {
    if (![action.x,action.y,action.viewportWidth,action.viewportHeight].every(Number.isFinite) || action.viewportWidth <= 0 || action.viewportHeight <= 0) return;
    if (!['click','type','press','select','scroll'].includes(action.kind)) return;
    this.clearCursor(tab);
    tab.agentCursor = { ...action, sequence: ++this.cursorSequence, active: true };
    // Only the activity hint expires. The same pointer remains available for the next move.
    const timer = setTimeout(() => { this.settleCursor(tab); this.publish(tab.windowId); }, 1200);
    timer.unref(); this.cursors.set(tab.id, { invocationId, timer }); this.publish(tab.windowId);
  }
  private open(windowId: number, conversationId: string|null,url: string,id?:string): BrowserRecord {
    if(typeof url!=='string'||!isUiBrowserUrl(url)) throw new BrowserHostError('invalid-address','Only HTTP(S) URLs are accepted');
    const win=this.window(windowId); const tab=this.registry.create(windowId,conversationId,id,url,win.viewport);
    tab.agentCursor = { x: 24, y: 24, viewportWidth: tab.width, viewportHeight: tab.height, kind: 'click', sequence: 0, active: false };
    this.tabSignals.set(tab.id,new AbortController());
    win.selected[conversationId??'']=tab.id; this.publish(windowId); return tab;
  }
  private focus(context: BrowserInvocation,tab: BrowserRecord):void {
    const win=this.window(context.windowId);
    if(win.conversationId===context.conversationId) win.focusRequest={tabId:tab.id,nonce:++win.nonce};
    this.publish(context.windowId);
  }
  private bind(tab: BrowserRecord, guestId: number): void {
    const entry=this.guests.get(guestId);
    if(!entry||entry.windowId!==tab.windowId||entry.guest.isDestroyed()) throw new BrowserHostError('invalid-guest','Guest is not registered to this window');
    if(tab.guestId!==null||entry.tabId!==null) {
      if(tab.guestId===guestId&&entry.tabId===tab.id) return;
      throw new BrowserHostError('duplicate-binding','Page is already bound');
    }
    entry.tabId=tab.id; tab.guestId=guestId;
    const guest=entry.guest;
    const sync=()=>{
      if(guest.isDestroyed())return;
      tab.url=guest.getURL()||tab.url;tab.title=guest.getTitle();tab.loading=guest.isLoading();
      tab.canGoBack=guest.navigationHistory.canGoBack();tab.canGoForward=guest.navigationHistory.canGoForward();
      this.publish(tab.windowId);
    };
    const navigate=()=>{tab.generation++;tab.error=null;this.settleCursor(tab);sync();};
    const ready=()=>{tab.ready=true;sync();};
    const failed=(_event:unknown,code:number,description:string,_url:string,isMainFrame:boolean)=>{if(isMainFrame&&code!==-3){tab.error={code:'load-failed',detail:description};sync();}};
    const gone=()=>{tab.generation++;tab.ready=false;tab.error={code:'renderer-gone'};this.settleCursor(tab);entry.automation?.dispose();entry.automation=undefined;this.publish(tab.windowId);};
    const listeners: [string,(...args:any[])=>void][]=[['dom-ready',ready],['did-start-loading',sync],['did-stop-loading',sync],['did-navigate',navigate],['did-navigate-in-page',sync],['page-title-updated',sync],['did-fail-load',failed],['render-process-gone',gone]];
    for(const [event,fn] of listeners)guest.on(event as any,fn);
    entry.dispose=()=>{for(const [event,fn] of listeners)guest.removeListener(event as any,fn);};
    tab.ready=true;
    const pendingUrl=tab.url;sync();
    if(pendingUrl!=='about:blank'&&guest.getURL()!==pendingUrl)void this.navigation(tab,'goto',pendingUrl).catch(()=>undefined);
  }
  private async navigation(tab: BrowserRecord,method:string,url?:string):Promise<void>{
    if(method==='goto'&&(typeof url!=='string'||!isUiBrowserUrl(url)))throw new BrowserHostError('invalid-address','Only HTTP(S) URLs are accepted');
    const entry=tab.guestId===null?null:this.guests.get(tab.guestId);
    if(!entry){if(method==='goto'){tab.url=url!;this.publish(tab.windowId);return;}throw new BrowserHostError('page-not-ready','Page not yet attached');}
    const guest=entry.guest;if(guest.isDestroyed())throw new BrowserHostError('tab-closed','Page closed');
    const epoch = (this.navigationEpoch.get(tab.id) ?? 0) + 1;
    this.settleCursor(tab); this.publish(tab.windowId);
    this.navigationEpoch.set(tab.id,epoch);
    tab.error=null;
    try{
      if(method==='goto')await guest.loadURL(url!);
      else if(method==='back')guest.navigationHistory.goBack();
      else if(method==='forward')guest.navigationHistory.goForward();
      else if(method==='reload')guest.reload();
      else if(method==='stop')guest.stop();
      else throw new BrowserHostError('invalid-command','Unsupported navigation command');
    }catch(error){
      if(this.navigationEpoch.get(tab.id)!==epoch || (error as {code?:string})?.code==='ERR_ABORTED') return;
      if(!this.registry.list(tab.windowId).includes(tab)) throw new BrowserHostError('tab-closed','Browser tab closed');
      tab.error={code:'load-failed',detail:String(error)};this.publish(tab.windowId);throw error;
    }
  }
  private closeTab(tab:BrowserRecord):void{
    this.clearCursor(tab);
    tab.generation++;this.tabSignals.get(tab.id)?.abort();this.tabSignals.delete(tab.id);this.navigationEpoch.delete(tab.id);this.registry.remove(tab.id);
    const guest=tab.guestId===null?null:this.guests.get(tab.guestId);
    guest?.dispose?.();guest?.automation?.dispose();
    if(guest){guest.tabId=null;this.guests.delete(guest.guest.id);if(!guest.guest.isDestroyed())guest.guest.close();}
    const win=this.windows.get(tab.windowId);if(win){for(const [key,id]of Object.entries(win.selected))if(id===tab.id)delete win.selected[key];this.publish(tab.windowId);}
  }
  private async waitGuest(tab:BrowserRecord,signal:AbortSignal):Promise<GuestEntry>{
    const start=Date.now();
    while(Date.now()-start<15000){
      if(signal.aborted)throw new BrowserHostError('invocation-ended','Invocation stopped');
      if(!this.registry.list(tab.windowId).includes(tab))throw new BrowserHostError('tab-closed','Tab closed');
      const guest=tab.guestId===null?null:this.guests.get(tab.guestId);if(guest&&tab.ready)return guest;
      await this.cancellable(new Promise(resolve=>setTimeout(resolve,25)),signal);
    }throw new BrowserHostError('page-not-ready','Browser Panel did not attach the page in time');
  }
  private cancellable<T>(promise:Promise<T>,signal:AbortSignal,code='invocation-ended'):Promise<T>{
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(new BrowserHostError(code,code==='tab-closed'?'Browser tab closed':'Browser invocation stopped'));
      if(signal.aborted){abort();return;}
      signal.addEventListener('abort',abort,{once:true});
      promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
  }
}
