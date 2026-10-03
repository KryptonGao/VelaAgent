import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { WebContents, Session } from 'electron';
import { BrowserHost } from '../src/main/browser-host.ts';
import { BrowserSessionRegistry } from '../src/main/browser-session-registry.ts';
import type { BrowserAgentAction } from '../../../packages/shared/src/browser.ts';
const asGuest = (v: unknown) => v as WebContents;
function fixture() {
  const session = {} as Session;
  const embedder = Object.assign(new EventEmitter(), {id:1});
  let closed = false, url='about:blank';
  const guest = Object.assign(new EventEmitter(), {id:2,hostWebContents:embedder,session,
    isDestroyed:()=>closed,getURL:()=>url,getTitle:()=>url==='about:blank'?'':'Fixture',isLoading:()=>false,
    navigationHistory:{canGoBack:()=>false,canGoForward:()=>false,goBack(){},goForward(){}},
    loadURL:async(value:string)=>{url=value;guest.emit('did-navigate');},close:()=>{closed=true;guest.emit('destroyed');},reload(){},stop(){}});
  const host = new BrowserHost(()=>({call:async()=>({result:true}),dispose(){}}),session);
  host.registerWindow(10,asGuest(embedder));host.registerGuest(10,asGuest(guest));
  const command = (input: any) => host.command(10,asGuest(embedder),true,input);
  const context = {windowId:10,conversationId:'one',agentId:'root',turnId:'turn',invocationId:'call'};
  return {host,guest,embedder,command,context};
}
test('registry validates window, conversation and first-reference binding',()=>{
  const registry=new BrowserSessionRegistry();registry.create(1,null,'tab');
  assert.throws(()=>registry.get('tab',2,'one',true),/another window/);
  assert.equal(registry.get('tab',1,'one',true).conversationId,'one');
  assert.throws(()=>registry.get('tab',1,'two',true),/another conversation/);
  assert.throws(()=>registry.create(1,'one','tab'),/already exists/);
});
test('manual and agent share the registered guest, logical IDs only',async()=>{
  const {host,guest,command,context}=fixture();await command({type:'activate',conversationId:'one'});
  await command({type:'open',id:'tab'});await command({type:'bind',tabId:'tab',guestId:2});
  const revoke=host.beginInvocation(context);await host.invoke(context,'goto','tab',['http://localhost:1234/']);
  assert.equal(guest.getURL(),'http://localhost:1234/');assert.equal((await command({type:'state'})).tabs[0].url,guest.getURL());
  assert.deepEqual(await host.invoke(context,'tabs.list'),[{id:'tab',url:guest.getURL(),title:'Fixture'}]);
  revoke();await assert.rejects(host.invoke(context,'title','tab'),/no longer active/);host.dispose();
});
test('rejects guest IPC, subframe IPC, forged guest and duplicate binding',async()=>{
  const {host,guest,embedder,command}=fixture();await command({type:'activate',conversationId:'one'});await command({type:'open',id:'tab'});
  await assert.rejects(host.command(10,asGuest(guest),true,{type:'state'}),/main frame/);
  await assert.rejects(host.command(10,asGuest(embedder),false,{type:'state'}),/main frame/);
  await assert.rejects(command({type:'bind',tabId:'tab',guestId:99}),/not registered/);
  assert.throws(()=>host.registerGuest(10,asGuest({...guest,id:3,session:{}})),/partition/);
  await command({type:'bind',tabId:'tab',guestId:2});await command({type:'open',id:'other'});
  await assert.rejects(command({type:'bind',tabId:'other',guestId:2}),/already bound/);host.dispose();
});
test('background open keeps foreground selection and focus, hidden guests can bind',async()=>{
  const {host,command,context}=fixture();await command({type:'activate',conversationId:'two'});
  const revoke=host.beginInvocation(context);const tab=await host.invoke(context,'tabs.open',undefined,['http://localhost:1/']) as {id:string};
  let state=await command({type:'state'});assert.equal(state.focusRequest,null);assert.equal(state.activeConversationId,'two');
  await command({type:'bind',tabId:tab.id,guestId:2});await command({type:'viewport',tabId:tab.id,width:900,height:600});
  await assert.rejects(command({type:'goto',tabId:tab.id,url:'https://example.com'}),/another conversation/);
  await command({type:'activate',conversationId:'one'});await host.invoke(context,'tabs.select',tab.id);
  state=await command({type:'state'});assert.equal(state.focusRequest?.tabId,tab.id);revoke();host.dispose();
});
test('cross conversation invocation and invocation forgery are denied',async()=>{
  const {host,command,context}=fixture();await command({type:'activate',conversationId:'two'});await command({type:'open',id:'tab'});
  const revoke=host.beginInvocation(context);
  await assert.rejects(host.invoke(context,'snapshot','tab'),/another conversation/);
  await assert.rejects(host.invoke({...context},'tabs.list'),/no longer active/);
  await assert.rejects(host.invoke(context,'tabs.open',undefined,['file:///etc/passwd']),/HTTP/);revoke();host.dispose();
});
test('explicit close immediately rejects an in-flight automation call',async()=>{
  const {host,command,context}=fixture();await command({type:'activate',conversationId:'one'});await command({type:'open',id:'tab'});await command({type:'bind',tabId:'tab',guestId:2});
  // Replace the factory with an indefinitely waiting backend without exposing it to scripts.
  (host as any).automationFactory=()=>({call:()=>new Promise(()=>{}),dispose(){}});
  const revoke=host.beginInvocation(context);const pending=host.invoke(context,'snapshot','tab');
  await new Promise(resolve=>setImmediate(resolve));await command({type:'close',tabId:'tab'});
  await assert.rejects(pending,/tab closed/);revoke();host.dispose();
});
test('abort revokes calls and window destruction clears tabs',async()=>{
  const {host,command,context}=fixture();await command({type:'activate',conversationId:'one'});await command({type:'open',id:'tab'});
  const abort=new AbortController();context.signal=abort.signal;
  const revoke=host.beginInvocation(context);abort.abort();await assert.rejects(host.invoke(context,'tabs.list'),/no longer active/);
  host.closeWindow(10);assert.equal(host.registry.list(10).length,0);revoke();
});

test('unowned manual tabs are discoverable and bind on the first reference',async()=>{
  const {host,command,context}=fixture();await command({type:'open',id:'unowned'});
  await command({type:'activate',conversationId:'one'});const revoke=host.beginInvocation(context);
  assert.deepEqual(await host.invoke(context,'tabs.list'),[{id:'unowned',url:'about:blank',title:''}]);
  assert.equal(host.registry.list(10)[0].conversationId,null);
  assert.deepEqual(await host.invoke(context,'tabs.selected'),{id:'unowned'});
  assert.equal(host.registry.list(10)[0].conversationId,'one');revoke();host.dispose();
});
test('stopped or superseded navigation does not become a load error',async()=>{
  const {host,guest,command}=fixture();await command({type:'activate',conversationId:'one'});
  await command({type:'open',id:'tab'});await command({type:'bind',tabId:'tab',guestId:2});
  let rejectLoad!: (error: Error) => void;
  guest.loadURL=()=>new Promise((_,reject)=>{rejectLoad=reject;});
  const navigation=command({type:'goto',tabId:'tab',url:'http://localhost:1234/slow'});
  await command({type:'stop',tabId:'tab'});rejectLoad(Object.assign(new Error('ERR_FAILED'),{code:'ERR_FAILED'}));
  await navigation;assert.equal(host.state(10).tabs[0].error,null);host.dispose();
});
test('CDP detach fails the current call and a later call reattaches',async()=>{
  const {host,command,context}=fixture();await command({type:'activate',conversationId:'one'});
  await command({type:'open',id:'tab'});await command({type:'bind',tabId:'tab',guestId:2});
  let created=0,disposed=0;
  (host as any).automationFactory=()=>{
    const index=++created;
    return {call:async()=>{if(index===1)throw Object.assign(new Error('Debugger detached'),{code:'CDP_DETACHED'});return 'reattached';},dispose(){disposed++;}};
  };
  const revoke=host.beginInvocation(context);
  await assert.rejects(host.invoke(context,'snapshot','tab'),{code:'CDP_DETACHED'});
  assert.equal(disposed,1);assert.equal(await host.invoke(context,'snapshot','tab'),'reattached');
  revoke();host.dispose();
});

test('cursor stays visible through idle, completion, cancellation and navigation, ignoring stale callbacks',async()=>{
  const {host,guest,command,context}=fixture();
  await command({type:'activate',conversationId:'one'});await command({type:'open',id:'tab'});await command({type:'bind',tabId:'tab',guestId:2});
  const callbacks: ((action: BrowserAgentAction)=>void)[]=[];
  (host as any).automationFactory=()=>({call:async(_method: string,_args: unknown[],_frame: string,_signal: AbortSignal,notify: (action: BrowserAgentAction)=>void)=>{callbacks.push(notify);},dispose(){}});
  const action: BrowserAgentAction={x:120,y:80,viewportWidth:1024,viewportHeight:768,kind:'click'};
  const abort=new AbortController();const owner={...context,signal:abort.signal};const revoke=host.beginInvocation(owner);
  try {
    assert.equal(host.state(10).tabs[0].agentCursor?.active,false, 'page starts with an idle Agent pointer');
    await host.invoke(owner,'click','tab',[{css:'button'}]);callbacks[0](action);
    assert.equal(host.state(10).tabs[0].agentCursor?.x,120);
    await command({type:'activate',conversationId:'two'});
    assert.equal(host.state(10).tabs[0].conversationId,'one', 'cursor remains owned by its original tab');
    abort.abort();assert.equal(host.state(10).tabs[0].agentCursor?.active,false);
    const abortedCursor=host.state(10).tabs[0].agentCursor;
    callbacks[0]({...action,x:900});assert.deepEqual(host.state(10).tabs[0].agentCursor,abortedCursor);
    const next={...context,invocationId:'next'};const finish=host.beginInvocation(next);
    await host.invoke(next,'click','tab');callbacks[1](action);
    guest.emit('did-navigate');assert.equal(host.state(10).tabs[0].agentCursor?.active,false);
    const navigatedCursor=host.state(10).tabs[0].agentCursor;
    callbacks[1]({...action,x:900});assert.deepEqual(host.state(10).tabs[0].agentCursor,navigatedCursor);
    await host.invoke(next,'click','tab');callbacks[2](action);finish();
    assert.ok(host.state(10).tabs[0].agentCursor, 'completed actions retain the pointer');
    callbacks[2]({...action,x:900});assert.equal(host.state(10).tabs[0].agentCursor?.x,120);
    await new Promise(resolve=>setTimeout(resolve,1850));
    assert.equal(host.state(10).tabs[0].agentCursor?.x,120);
    assert.equal(host.state(10).tabs[0].agentCursor?.active,false, 'only action feedback expires');
    const cancelled={...context,invocationId:'cancelled'};const cancel=host.beginInvocation(cancelled);
    await host.invoke(cancelled,'click','tab');callbacks[3](action);cancel('cancel');
    assert.equal(host.state(10).tabs[0].agentCursor?.active,false, 'cancellation clears feedback while retaining the pointer');
    assert.equal(host.state(10).tabs[0].agentCursor?.x,120);
    await command({type:'activate',conversationId:'one'});await command({type:'close',tabId:'tab'});
    callbacks[3]({...action,x:900});assert.equal(host.state(10).tabs.length,0);
  } finally {revoke();host.dispose();}
});
