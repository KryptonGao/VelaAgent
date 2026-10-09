// 真实 Electron + 真实 git 仓库 + fake gh：从 PR 详情开始回应审阅，到检查、推送、回复。
// 不访问 GitHub；远程是本机 bare 仓库，通过 url.insteadOf 伪装成 github.com/fixture/Repo。
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)); const root = resolve(here, '..');
const require = createRequire(join(root, 'package.json'));
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'vela-pr-response-smoke-')));
const shots = join(tmpdir(), 'vela-pr-response-screenshots'); mkdirSync(shots, { recursive: true });
mkdirSync(join(temp, 'vela')); mkdirSync(join(temp, 'bin'));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const bare = join(temp, 'remote.git'); const clone = join(temp, 'clone');
sh(temp, 'init', '--bare', '-b', 'main', bare); sh(temp, 'clone', bare, clone);
writeFileSync(join(clone, 'a.txt'), 'one\n'); sh(clone, 'add', '.'); sh(clone, 'commit', '-m', 'init'); sh(clone, 'push', 'origin', 'main');
sh(clone, 'checkout', '-b', 'feature'); writeFileSync(join(clone, 'a.txt'), 'one\ntwo\n'); sh(clone, 'commit', '-am', 'feature work'); sh(clone, 'push', 'origin', 'feature'); sh(clone, 'checkout', 'main');
sh(clone, 'remote', 'set-url', 'origin', 'https://github.com/fixture/Repo.git'); sh(clone, 'config', `url.${bare}.insteadOf`, 'https://github.com/fixture/Repo.git');
const head = sh(clone, 'rev-parse', 'feature');
writeFileSync(join(temp, 'vela/ui-state.json'), JSON.stringify({ 'vela.onboarding.complete': 'true', 'vela.leftCollapsed': 'false' }));
writeFileSync(join(temp, 'vela/workspaces.json'), JSON.stringify({ current: null, recents: [{ path: clone, name: 'clone', lastUsedAt: Date.now() }] }));
writeFileSync(join(temp, 'vela/models.json'), JSON.stringify({ providers: { fixture: { name: 'Fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only', models: [{ id: 'fixture', name: 'Fixture', reasoning: false, contextWindow: 32768, maxTokens: 4096 }] } } }));
writeFileSync(join(temp, 'vela/selection.json'), JSON.stringify({ provider: 'fixture', modelId: 'fixture', thinkingLevel: 'off', newConversationSelection: 'default' }));
const calls = join(temp, 'calls.jsonl');
const fake = `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);const chunks=[];process.stdin.on('data',d=>chunks.push(d));process.stdin.on('end',()=>{
const stdin=Buffer.concat(chunks).toString();fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,stdin})+'\\n');
const h=${JSON.stringify(head)},b='b'.repeat(40);const out=v=>process.stdout.write(typeof v==='string'?v:JSON.stringify(v));
const url='https://github.com/fixture/Repo/pull/128';
const pr={number:128,title:'Rename the helper',url,state:'OPEN',isDraft:false,author:{login:'fixture'},body:'Body',headRefOid:h,baseRefOid:b,headRefName:'feature',baseRefName:'main',isCrossRepository:false,headRepository:{name:'Repo'},headRepositoryOwner:{login:'fixture'},statusCheckRollup:[],changedFiles:1,additions:1,deletions:0,createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-05T00:00:00Z',mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'CHANGES_REQUESTED'};
if(args[0]==='--version'){out('gh version 2.96.0');return;}
if(args[0]==='auth'){out({hosts:{'github.com':[{state:'success',active:true,login:'fixture'}]}});return;}
if(args.includes('user')){out({login:'fixture'});return;}
if(args.includes('search/issues')){const q=args.find(a=>a.startsWith('q='));out({total_count:q.includes('author:')?1:0,incomplete_results:false,items:q.includes('author:')?[{number:128,html_url:url,title:pr.title,state:'open',draft:false,updated_at:pr.updatedAt,user:{login:'fixture'},pull_request:{}}]:[]});return;}
if(args[0]==='pr'&&args[1]==='view'){out(pr);return;}
if(args[0]==='pr'&&args[1]==='checks'){out([]);return;}
if(args.some(a=>a.includes('/files?'))){out([]);return;}
if(args.includes('graphql')){const input=JSON.parse(stdin);const q=input.query,v=input.variables;
 if(q.includes('maintainerCanModify')){const t=(id,line,body)=>({id,path:'a.txt',line,isResolved:false,isOutdated:false,comments:{pageInfo:{hasNextPage:false},nodes:[{author:{login:'reviewer'},body,url:url+'#discussion_r'+line}]}});
  out({data:{repository:{pullRequest:{headRefOid:h,maintainerCanModify:false,reviews:{nodes:[]},reviewThreads:{pageInfo:{hasNextPage:false},nodes:[t('PRRT_T1',2,'Please rename the helper.'),t('PRRT_T2',1,'Why is this needed?')]}}}}});return;}
 if(q.includes('viewerCanReply')){out({data:{node:{id:v.id,isResolved:false,viewerCanReply:true,viewerCanResolve:true,pullRequest:{number:128,repository:{name:'Repo',owner:{login:'fixture'}}}}}});return;}
 if(q.includes('addPullRequestReviewThreadReply')){out({data:{addPullRequestReviewThreadReply:{comment:{id:'C_new',url:url+'#discussion_r99'}}}});return;}
 if(q.includes('resolveReviewThread')){out({data:{resolveReviewThread:{thread:{id:v.id,isResolved:true}}}});return;}
 if(q.includes('r0:repository')){out({data:{}});return;}
 const none={nodes:[],pageInfo:{hasPreviousPage:false,hasNextPage:false}};out({data:{repository:{pullRequest:{headRefOid:h,comments:none,reviews:none,commits:none,reviewThreads:none}}}});return;}
process.stderr.write('Unexpected fake command '+args.join(' '));process.exitCode=1;});`;
writeFileSync(join(temp, 'bin/gh'), fake); chmodSync(join(temp, 'bin/gh'), 0o755);
const entry = join(temp, 'entry.mjs');
// Helpers are injected into every page script. Main-process steps (the stand-in agent, remote checks) run between phases.
const helpers = `
const wait=async(read,label,ms=15000)=>{for(let i=0;i<ms/20;i++){const v=await read();if(v)return v;await new Promise(r=>setTimeout(r,20));}throw new Error(label)};
const assert=(v,label)=>{if(!v)throw new Error(label)};const visible=n=>n&&!n.closest('.is-hidden')&&n.getClientRects().length;
const buttons=(s=document)=>[...s.querySelectorAll('button')].filter(visible);
const click=(text,s=document)=>{const b=buttons(s).find(b=>b.textContent.trim().startsWith(text));assert(b,'Missing button '+text);assert(!b.disabled,'Disabled '+text);b.click()};`;
writeFileSync(entry, `import { app } from 'electron';import { writeFileSync, readFileSync } from 'node:fs';import { execFileSync } from 'node:child_process';import { pathToFileURL } from 'node:url';
const temp=${JSON.stringify(temp)}, root=${JSON.stringify(root)}, shots=${JSON.stringify(shots)}, gitEnv=${JSON.stringify(gitEnv)}, helpers=${JSON.stringify(helpers)};
app.setPath('userData',temp+'/electron');app.setPath('sessionData',temp+'/electron');
const deadline=setTimeout(()=>{console.error('PR response smoke deadline');app.exit(1)},90000);
app.on('browser-window-created',(_event,win)=>{
process.env.PATH=temp+'/bin:'+process.env.PATH;
win.webContents.on('console-message',details=>{if(details.message.startsWith('SHOT:'))setTimeout(()=>void win.webContents.capturePage().then(image=>writeFileSync(shots+'/'+details.message.slice(5)+'.png',image.toPNG())),100);});
const page=code=>win.webContents.executeJavaScript('(async()=>{'+helpers+code+'})()');
win.webContents.once('did-finish-load',async()=>{try{
await page(\`
await wait(()=>document.querySelector('.sidebar-quick-actions'),'Sidebar missing');
click('Pull Request');await wait(()=>document.querySelectorAll('.pr-inbox-row').length===1,'PR row missing');
document.querySelector('.pr-inbox-row').click();await wait(()=>document.querySelector('.pr-response'),'Response panel missing');
click('让 Agent 回应审阅意见');await wait(()=>document.querySelectorAll('.pr-response-dialog[open] .pr-response-threads li').length===2,'Two threads expected');
const select=document.querySelector('.pr-response-dialog select');assert(select&&select.value.endsWith('/clone'),'Checkout not found from the recent workspace');
console.log('SHOT:start');await new Promise(r=>setTimeout(r,250));
click('开始处理 2 条意见');await wait(()=>!document.querySelector('.pr-response-dialog[open]'),'Start dialog did not close');
await wait(()=>!visible(document.querySelector('.pr-inbox-page')),'Did not leave the inbox for the new conversation');
\`);
// Stand-in for the agent: one local commit that claims thread T1 and carries the reply text.
const run=JSON.parse(readFileSync(temp+'/vela/pr-review-responses.json','utf8')).runs.at(-1);
if(run.status!=='working'||run.threadIds.length!==2||run.branch!=='vela/pr-128-review')throw new Error('Unexpected run record '+JSON.stringify(run));
writeFileSync(run.worktree+'/a.txt','one\\ntwo\\nthree\\n');
execFileSync('git',['commit','-am','Rename the helper\\n\\nRenamed it to makeThing and updated the caller.\\n\\nReview-Thread: PRRT_T1'],{cwd:run.worktree,env:gitEnv});
const tip=execFileSync('git',['rev-parse','HEAD'],{cwd:run.worktree,env:gitEnv,encoding:'utf8'}).trim();
const before=execFileSync('git',['rev-parse','feature'],{cwd:${JSON.stringify(bare)},env:gitEnv,encoding:'utf8'}).trim();
if(before===tip)throw new Error('Remote must not have the commit before the user confirms');
await page(\`
click('Pull Request');await wait(()=>visible(document.querySelector('.pr-inbox-page')),'Inbox not restored');
await wait(()=>document.querySelector('.pr-response-run'),'Run not listed');
click('检查并发布');await wait(()=>document.querySelector('.pr-response-dialog[open] .pr-response-draft'),'Drafts missing');
const dialog=document.querySelector('.pr-response-dialog');
assert(dialog.textContent.includes('Rename the helper'),'Commit subject missing');
const drafts=[...dialog.querySelectorAll('.pr-response-draft')];assert(drafts.length===2,'Two drafts expected, got '+drafts.length);
const first=drafts.find(d=>d.textContent.includes('a.txt:2'))||drafts[0];
const boxes=drafts.map(d=>d.querySelector('textarea').value);assert(boxes.some(v=>v.includes('Renamed it to makeThing')&&v.includes('Addressed in')),'Reply draft not taken from the commit');
assert(drafts.filter(d=>d.querySelector('input[type=checkbox]').checked).length===1,'Only the claimed thread should be selected');
console.log('SHOT:publish');await new Promise(r=>setTimeout(r,250));
click('推送 1 个提交并回复 1 条');await wait(()=>dialog.querySelector('.pr-response-result'),'No publish result');
assert(dialog.querySelector('.pr-response-result').textContent.includes('已推送'),'Push not confirmed: '+dialog.textContent);
console.log('SHOT:published');await new Promise(r=>setTimeout(r,250));
\`);
const after=execFileSync('git',['rev-parse','feature'],{cwd:${JSON.stringify(bare)},env:gitEnv,encoding:'utf8'}).trim();
if(after!==tip)throw new Error('Remote branch did not receive the reviewed commit');
console.log('PASS PR review response electron '+JSON.stringify({pushed:true}));clearTimeout(deadline);app.quit();
}catch(error){console.error(error);writeFileSync(shots+'/failure.png',(await win.webContents.capturePage()).toPNG());clearTimeout(deadline);app.exit(1);}});
});await import(pathToFileURL(root+'/out/main/index.mjs').href);`);
const env = { ...process.env, PI_OFFLINE: '1', VELA_USER_DATA: join(temp, 'vela'), VELA_CWD: '', VELA_DISABLE_PRODUCTION_SYNC: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
try {
  const child = spawn(require('electron'), [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const code = await new Promise(resolve => child.on('exit', resolve)); console.log(output.split('\n').filter(l => !l.includes('app started')).join('\n')); assert.equal(code, 0);
  const log = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const writes = log.filter(c => /mutation/.test(c.stdin));
  assert.deepEqual(writes.map(c => Object.keys(JSON.parse(c.stdin).variables).sort().join(',') + ':' + /(\w+)\(input/.exec(JSON.parse(c.stdin).query)[1]), ['body,id:addPullRequestReviewThreadReply']);
  const reply = JSON.parse(writes[0].stdin).variables;
  assert.equal(reply.id, 'PRRT_T1'); assert.match(reply.body, /^Renamed it to makeThing and updated the caller\.\n\nAddressed in [a-f0-9]{7}\.$/);
  assert.ok(log.every(c => !(c.args[0] === 'pr' && ['merge', 'review', 'comment', 'close', 'ready', 'checkout'].includes(c.args[1]))), 'No gh pr write commands');
  console.log('PASS exactly one reply was written, to the selected thread, after the push; screenshots: ' + shots);
} finally { rmSync(temp, { recursive: true, force: true }); }
