import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)); const root = resolve(here, '..');
const require = createRequire(join(root, 'package.json'));
const temp = mkdtempSync(join(tmpdir(), 'vela-pr-inbox-smoke-'));
const shots = join(tmpdir(), 'vela-pr-inbox-screenshots'); mkdirSync(shots, { recursive: true });
mkdirSync(join(temp, 'vela')); mkdirSync(join(temp, 'bin'));
writeFileSync(join(temp, 'vela/ui-state.json'), JSON.stringify({ 'vela.onboarding.complete': 'true', 'vela.leftCollapsed': 'false' }));
writeFileSync(join(temp, 'vela/workspaces.json'), JSON.stringify({ current: null, recents: [] }));
writeFileSync(join(temp, 'vela/models.json'), JSON.stringify({ providers: { fixture: { name: 'Fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only', models: [{ id: 'fixture', name: 'Fixture', reasoning: false, contextWindow: 32768, maxTokens: 4096 }] } } }));
writeFileSync(join(temp, 'vela/selection.json'), JSON.stringify({ provider: 'fixture', modelId: 'fixture', thinkingLevel: 'off', newConversationSelection: 'default' }));
writeFileSync(join(temp, 'mode'), 'ok');
writeFileSync(join(temp, 'delay'), '0'); writeFileSync(join(temp, 'title'), '');
const fake = `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);const chunks=[];process.stdin.on('data',d=>chunks.push(d));process.stdin.on('end',()=>{const run=()=>{
fs.appendFileSync(${JSON.stringify(join(temp, 'calls.jsonl'))},JSON.stringify({args,stdin:Buffer.concat(chunks).toString(),host:process.env.GH_HOST})+'\\n');
const mode=fs.readFileSync(${JSON.stringify(join(temp, 'mode'))},'utf8');const h='a'.repeat(40),b='b'.repeat(40);
const refreshed=fs.readFileSync(${JSON.stringify(join(temp, 'title'))},'utf8');
const item=(repo='Repo')=>({number:128,html_url:'https://github.com/fixture/'+repo+'/pull/128',title:(repo==='Repo'?'Add the Pull Request inbox and preserve workspace context':'Handle renamed files safely in remote diffs')+refreshed,state:'open',draft:false,user:{login:'fixture'},updated_at:'2026-10-05T02:00:00Z',pull_request:{}});
const pr=(repo='Repo')=>({number:128,title:item(repo).title,url:item(repo).html_url,state:'OPEN',isDraft:false,author:{login:'fixture'},body:'# Summary\\nRead PRs without a local checkout.\\n\\n## Test plan\\n- Targeted fake gh checks\\n\\n<script>window.PR_SCRIPT_EXECUTED=true</script>',createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-05T02:00:00Z',headRefOid:h,baseRefOid:b,headRefName:'feature/inbox',baseRefName:'main',headRepository:{name:repo},headRepositoryOwner:{login:'fixture'},additions:42,deletions:7,changedFiles:3,reviewDecision:'REVIEW_REQUIRED',mergeable:'MERGEABLE',mergeStateStatus:'BLOCKED',statusCheckRollup:[{state:'SUCCESS'}]});
const out=v=>process.stdout.write(typeof v==='string'?v:JSON.stringify(v));
if(args[0]==='--version'){out('gh version 2.96.0');return;}
if(args[0]==='auth'){out({hosts:{'github.com':[{state:'success',active:true,login:'fixture'}]}});return;}
if(args.includes('user')){out({login:mode==='ok'?'fixture':'bob'});return;}
if(args.includes('search/issues')){if(mode==='offline'){process.stderr.write('network connection reset');process.exitCode=1;return;}const q=args.find(a=>a.startsWith('q='));const repo=q.includes('repo:fixture/Other')?'Other':'Repo';const rows=q.includes('author:')?[item(repo),...(!q.includes('repo:')?[item('Other')]:[])]:q.includes('assignee:')?[item('Other')]:[item(repo)];out({items:rows,total_count:rows.length,incomplete_results:false});return;}
if(args[0]==='pr'&&args[1]==='view'){out(pr(args.find(a=>a.includes('github.com/fixture/Other'))?'Other':'Repo'));return;}
if(args[0]==='pr'&&args[1]==='checks'){out([{name:'Unit tests',state:'SUCCESS',bucket:'pass'},{name:'Build',state:'PENDING',bucket:'pending'}]);process.exitCode=8;return;}
if(args.some(a=>a.includes('/files?'))){out([{filename:'src/new name.ts',previous_filename:'src/old name.ts',status:'renamed',additions:2,deletions:1,patch:'@@ -1,2 +1,3 @@\\n export const value = 1;\\n-old();\\n+newValue();\\n+added();',blob_url:'https://github.com/fixture/Repo/blob/'+h+'/src/new%20name.ts'},{filename:'assets/binary.png',status:'modified',additions:0,deletions:0},{filename:'src/large.ts',status:'added',additions:900,deletions:0,patch:'@@ -0,0 +1,900 @@\\n'+Array.from({length:900},(_,i)=>'+const line'+i+' = '+i+';').join('\\n')}]);return;}
if(args[0]==='pr'&&args[1]==='diff'){out('diff --git a/assets/binary.png b/assets/binary.png\\nBinary files differ\\n');return;}
if(args.includes('graphql')){const input=JSON.parse(Buffer.concat(chunks).toString());const vars=input.variables,q=input.query;if(q.includes('r0:repository')){const data={};for(const k of Object.keys(vars).filter(k=>/^r\\d+$/.test(k))){const r=k.slice(1),repo=vars[k];const prs={};for(const n of Object.keys(vars).filter(k=>/^n\\d+$/.test(k)))prs['p'+n.slice(1)]={...pr(repo),commits:{nodes:[{commit:{statusCheckRollup:{contexts:{nodes:[{state:'SUCCESS'}],pageInfo:{hasNextPage:false}}}}}]}};data['r'+r]=prs;}out({data});return;}
const activity={headRefOid:h};if(q.includes('reviewThreads('))activity.reviewThreads={nodes:[{id:'T1',path:'src/new name.ts',line:2,isResolved:false,isOutdated:false,viewerCanResolve:true,viewerCanUnresolve:false,comments:{nodes:[{id:'C2',body:'Please keep the path explicit.',author:{login:'reviewer'},createdAt:'2026-10-05T02:00:00Z',originalCommit:{oid:h}}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}};
else if(q.includes('commits('))activity.commits={nodes:[{commit:{oid:h,messageHeadline:'Add the Pull Request inbox',committedDate:'2026-10-04T01:00:00Z',author:{name:'Fixture',user:{login:'fixture'}}}}],pageInfo:{hasPreviousPage:false}};
else if(q.includes('reviews('))activity.reviews={nodes:[{author:{login:'reviewer'},body:'Reviewed the previous head.',state:'APPROVED',submittedAt:'2026-10-04T02:00:00Z',commit:{oid:'c'.repeat(40)}}],pageInfo:{hasPreviousPage:false}};
else activity.comments={nodes:[{id:'C1',body:'The inbox works without checking out a repository.',author:{login:'reviewer'},createdAt:'2026-10-05T01:00:00Z'}],pageInfo:{hasPreviousPage:false}};
out({data:{repository:{pullRequest:activity}}});return;}
process.stderr.write('Unexpected fake command '+args.join(' '));process.exitCode=1;
};setTimeout(run,Number(fs.readFileSync(${JSON.stringify(join(temp, 'delay'))},'utf8')));
});`;
writeFileSync(join(temp, 'bin/gh'), fake); chmodSync(join(temp, 'bin/gh'), 0o755);
const entry = join(temp, 'entry.mjs');
writeFileSync(entry, `import { app } from 'electron';import { writeFileSync } from 'node:fs';import { pathToFileURL } from 'node:url';
const temp=${JSON.stringify(temp)}, root=${JSON.stringify(root)},shots=${JSON.stringify(shots)};
app.setPath('userData',temp+'/electron');app.setPath('sessionData',temp+'/electron');
const deadline=setTimeout(()=>{console.error('PR inbox smoke deadline');app.exit(1)},55000);
app.on('browser-window-created',(_event,win)=>{
process.env.PATH=temp+'/bin:'+process.env.PATH;
win.webContents.on('console-message',details=>{if(details.message.startsWith('PR_MODE:'))writeFileSync(temp+'/mode',details.message.slice(8));if(details.message.startsWith('PR_DELAY:'))writeFileSync(temp+'/delay',details.message.slice(9));if(details.message.startsWith('PR_TITLE:'))writeFileSync(temp+'/title',details.message.slice(9));if(details.message.startsWith('PR_SHOT:'))setTimeout(()=>void win.webContents.capturePage().then(image=>writeFileSync(shots+'/'+details.message.slice(8)+'.png',image.toPNG())),100);});
win.webContents.once('did-finish-load',async()=>{try{
const result=await win.webContents.executeJavaScript(\`(async()=>{
const wait=async(read,label)=>{for(let i=0;i<500;i++){const v=await read();if(v)return v;await new Promise(r=>setTimeout(r,20));}throw new Error(label)};
const assert=(v,label)=>{if(!v)throw new Error(label)};const visible=n=>n&&!n.closest('.is-hidden')&&n.getClientRects().length;
const buttons=(s=document)=>[...s.querySelectorAll('button')].filter(visible);const click=(text,s=document)=>{const b=buttons(s).find(b=>b.textContent.trim()===text);assert(b,'Missing button '+text);assert(!b.disabled,'Disabled '+text);b.click()};
const fill=(selector,value)=>{const n=document.querySelector(selector);Object.getOwnPropertyDescriptor(n.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,value);n.dispatchEvent(new Event(n.tagName==='SELECT'?'change':'input',{bubbles:true}));};
await wait(()=>document.querySelector('.sidebar-quick-actions'),'Sidebar missing');const before=await window.vela.getState();
// Accelerate only the PR idle interval and its session clock; gh still uses the real clock and forced reads.
const realNow=Date.now;window.PR_CLOCK=0;Date.now=()=>realNow()+window.PR_CLOCK;
const realInterval=window.setInterval.bind(window);window.setInterval=(fn,ms,...args)=>realInterval(fn,ms===15000?100:ms,...args);
click('Pull Request');await wait(()=>document.querySelectorAll('.pr-inbox-row').length===2,'Cross-repository rows missing');
await wait(()=>document.querySelector('.pr-inbox-account')?.textContent==='@fixture','Identity missing');assert((await window.vela.getWorkspaceState()).current===null,'Fixture must have no workspace');
await new Promise(r=>setTimeout(r,450));console.log('PR_SHOT:inbox');await new Promise(r=>setTimeout(r,250));
const relation=[...document.querySelectorAll('.pr-inbox-relations button')].find(b=>b.textContent.startsWith('待我审查'));relation.click();await wait(()=>document.querySelectorAll('.pr-inbox-row').length===1,'Relation filter');
fill('.pr-inbox-search input','no-match');await wait(()=>document.querySelector('.pr-inbox-empty')?.textContent.includes('已加载'),'Loaded search scope');fill('.pr-inbox-search input','#128');await wait(()=>document.querySelectorAll('.pr-inbox-row').length===1,'Number search');
document.querySelector('.pr-inbox-row').click();await wait(()=>document.querySelector('.pr-inbox-overview'),'Overview missing');await wait(()=>document.querySelector('.pr-inbox-activity')?.textContent.includes('旧版本审阅'),'Activity/current-head review');assert(!window.PR_SCRIPT_EXECUTED,'Markdown executed a script');assert(document.querySelector('.pr-inbox-checks').textContent.includes('检查运行中'),'Pending check exit 8');
console.log('PR_SHOT:overview');await new Promise(r=>setTimeout(r,150));
click('让 Agent 回应审阅意见');await wait(()=>document.querySelector('.pr-response-dialog[open] .pr-response-threads li'),'Response dialog threads missing');
const responseDialog=document.querySelector('.pr-response-dialog');assert(responseDialog.textContent.includes('src/new name.ts'),'Thread path missing');assert(responseDialog.textContent.includes('没有找到 fixture/Repo 的本机检出'),'No-checkout notice missing');
assert([...responseDialog.querySelectorAll('footer button')].find(b=>b.classList.contains('is-primary')).disabled,'Start must stay disabled without a local checkout');
console.log('PR_SHOT:response');await new Promise(r=>setTimeout(r,250));click('取消');await wait(()=>!document.querySelector('.pr-response-dialog[open]'),'Response dialog not closed');
click('变更 3');await wait(()=>document.querySelector('.pr-inbox-file-tree nav button'),'Files missing');await wait(()=>document.querySelector('.pr-inbox-diff-header')?.textContent.includes('src/new name.ts'),'Renamed diff missing');assert(document.querySelector('.diff-line.add')?.textContent.includes('newValue'),'Remote diff missing');
assert(document.querySelectorAll('.diff-line.ctx .diff-line-number').length===2,'Unified diff line numbers missing');await new Promise(r=>setTimeout(r,300));console.log('PR_SHOT:changes');await new Promise(r=>setTimeout(r,250));const fileButtons=[...document.querySelectorAll('.pr-inbox-file-tree nav button')];fileButtons.find(b=>b.textContent.includes('binary.png')).click();await wait(()=>document.querySelector('.pr-inbox-file-diff').textContent.includes('没有可用的文本差异'),'Binary state missing');fileButtons.find(b=>b.textContent.includes('large.ts')).click();await wait(()=>buttons().some(b=>b.textContent.includes('展开更多差异')),'Large diff progressive rendering');
click('← 返回列表');await wait(()=>document.querySelector('.pr-inbox-search input')?.value==='#128','Search not restored');assert(document.querySelector('.pr-inbox-relations [aria-selected="true"]').textContent.startsWith('待我审查'),'Relation not restored');
console.log('PR_DELAY:350');await new Promise(r=>setTimeout(r,80));
document.querySelector('.pr-inbox-row').click();await new Promise(r=>setTimeout(r,60));
assert(document.querySelector('.pr-inbox-overview')?.textContent.includes('Read PRs without'),'Cached detail was not shown before slow revalidation');
assert(document.querySelector('.pr-inbox-activity')?.textContent.includes('旧版本审阅'),'Cached activity was not shown on remount');
assert(!document.querySelector('.pr-inbox-detail-toolbar').textContent.includes('读取中'),'Cached detail refresh showed a loading state');
click('变更 3');await new Promise(r=>setTimeout(r,60));assert(document.querySelector('.diff-line.add')?.textContent.includes('newValue'),'Cached file patch was not shown before revalidation');
click('← 返回列表');await wait(()=>document.querySelector('.pr-inbox-row'),'Cached list missing');
console.log('PR_DELAY:0');await new Promise(r=>setTimeout(r,80));
click('定时任务');await wait(()=>!visible(document.querySelector('.pr-inbox-page')),'PR page not hidden for idle refresh');
console.log('PR_TITLE: (idle-refreshed)');await new Promise(r=>setTimeout(r,80));window.PR_CLOCK+=61000;
await wait(()=>document.querySelector('.pr-inbox-row')?.textContent.includes('idle-refreshed'),'Loaded PRs did not refresh while working outside the inbox');
assert(!document.querySelector('.pr-inbox-topbar').textContent.includes('读取中'),'Idle refresh showed a loading state');
console.log('PR_DELAY:350');await new Promise(r=>setTimeout(r,80));click('Pull Request');await new Promise(r=>setTimeout(r,60));
assert(document.querySelector('.pr-inbox-row')?.textContent.includes('idle-refreshed'),'Returning to the inbox did not immediately show the idle-updated cache');
console.log('PR_DELAY:0');await new Promise(r=>setTimeout(r,1000));
const stale=await window.vela.prInbox.list({state:'openAndDraft',repository:null},{requestId:'manual-fresh',force:true});assert(stale.complete&&stale.items.length===2,'Main IPC list failed');
let invalid=false;try{await window.vela.prInbox.detail({host:'evil.test',owner:'fixture',repo:'Repo',number:128},{requestId:'invalid',identityKey:'github.com/fixture'})}catch{invalid=true}assert(invalid,'Target validation missing');
console.log('PR_MODE:bob');await new Promise(r=>setTimeout(r,80));click('刷新');await wait(()=>document.querySelector('.pr-inbox-account')?.textContent==='@bob','Identity refresh');
console.log('PR_MODE:offline');await new Promise(r=>setTimeout(r,80));click('刷新');await wait(()=>document.querySelector('.pr-inbox-notice')?.textContent.includes('无法连接'),'Offline state');assert(document.querySelectorAll('.pr-inbox-row').length===1,'Offline cache erased');
const after=await window.vela.getState();assert(after.session.id===before.session.id,'Conversation changed');assert((await window.vela.getWorkspaceState()).current===null,'Workspace changed');
click('新对话');await wait(()=>!visible(document.querySelector('.pr-inbox-page')),'PR page not hidden');click('Pull Request');await wait(()=>visible(document.querySelector('.pr-inbox-page')),'PR page not restored');assert(document.querySelector('.pr-inbox-search input').value==='#128','Filters lost on navigation');
return {rows:2,noWorkspace:true,markdownSafe:true,ipcValidated:true,cachePreserved:true,cacheBeforeNetwork:true,idleRefreshOutsideInbox:true,reviewResponseDialog:true};
})()\`);
win.setSize(1000,760);win.webContents.setZoomFactor(2);await new Promise(r=>setTimeout(r,250));
const overflow=await win.webContents.executeJavaScript('document.querySelector(".pr-inbox-page").scrollWidth>document.querySelector(".pr-inbox-page").clientWidth');if(overflow)throw new Error('PR page overflow at 200%');writeFileSync(shots+'/zoom-200.png',(await win.webContents.capturePage()).toPNG());
console.log('PASS PR inbox electron '+JSON.stringify(result));clearTimeout(deadline);app.quit();
}catch(error){console.error(error);writeFileSync(shots+'/failure.png',(await win.webContents.capturePage()).toPNG());clearTimeout(deadline);app.exit(1);}});
});await import(pathToFileURL(root+'/out/main/index.mjs').href);`);
const env = { ...process.env, PI_OFFLINE: '1', VELA_USER_DATA: join(temp, 'vela'), VELA_CWD: '', VELA_DISABLE_PRODUCTION_SYNC: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
try {
  const child = spawn(require('electron'), [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const code = await new Promise(resolve => child.on('exit', resolve)); console.log(output); assert.equal(code, 0);
  const calls = readFileSync(join(temp, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.length > 10); assert.ok(calls.filter(c => c.args.includes('search/issues') || c.args.includes('graphql') || c.args.includes('user') || c.args.includes('--repo')).every(c => c.host === 'github.com'));
  assert.ok(calls.every(c => !(c.args[0] === 'pr' && ['merge', 'review', 'comment', 'close', 'ready', 'checkout'].includes(c.args[1]))));
  assert.ok(calls.every(c => !/mutation/.test(c.stdin)), 'The review response dialog must not write to GitHub');
  console.log('PASS read-only gh calls: ' + calls.length + '; screenshots: ' + shots);
} finally { rmSync(temp, { recursive: true, force: true }); }
