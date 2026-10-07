import assert from "node:assert/strict";
import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.VELA_TASK_SMOKE_ROOT, data = process.env.VELA_TASK_SMOKE_TEMP;
const phase = process.env.VELA_TASK_SMOKE_PHASE;
app.setPath("userData", join(data, "electron-data"));
app.setPath("sessionData", join(data, "electron-data"));
const deadline = setTimeout(() => { console.error("Scheduled Tasks startup deadline"); app.exit(1); }, 30000);
app.on("browser-window-created", (_event, win) => {
  win.webContents.once("did-finish-load", async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const wait = async (read, message) => {
          for (let i=0;i<200;i++) { const value = await read(); if(value) return value; await new Promise(resolve=>setTimeout(resolve,25)); }
          throw new Error(message);
        };
        const assert = (value,message) => { if(!value) throw new Error(message); };
        const api = window.vela.scheduledTasks;
        await wait(async()=>{ const state=await window.vela.getState(); return state.session.status==='ready' && state; },'Runtime did not become ready');
        const phase = ${JSON.stringify(phase)};
        const previous = await window.vela.getState();
        const workspace = ${JSON.stringify(join(data, "workspace"))};
        const other = ${JSON.stringify(join(data, "other"))};
        const buttons = () => [...document.querySelectorAll('button')];
        const click = text => {const button=buttons().find(button=>button.textContent.trim()===text);assert(button,'Missing button: '+text);button.click();};
        const entry = await wait(()=>document.querySelector('.sidebar-quick-actions'),'Sidebar did not mount');
        // 按名字找快捷入口：侧栏顶部还有 Pull Request 等可配置入口，位置下标不稳定。
        const quick = text => {const button=[...entry.children].find(button=>button.textContent.includes(text));assert(button,'Missing sidebar shortcut: '+text);return button;};
        const tasksEntry = quick('定时任务'), newChatEntry = quick('新对话');
        assert([...entry.children].indexOf(tasksEntry)<[...entry.children].indexOf(newChatEntry),'Scheduled Tasks must be above New chat');
        tasksEntry.click();
        await wait(()=>document.querySelector('.scheduled-tasks-page'),'Scheduled Tasks did not open');
        await wait(()=>document.querySelector('.main-stage-pane.is-hidden'), 'Conversation did not hide');
        assert(!document.querySelector('.scheduled-tasks-page').closest('.workbench-panel'),'Tasks still mounted in Workbench');
        assert(tasksEntry.getAttribute('aria-current')==='page','Sidebar page state is missing');
        assert(!buttons().some(button=>button.textContent.trim()==='返回对话'),'Independent page still has a back-to-chat button');
        const glass=getComputedStyle(document.querySelector('.scheduled-tasks-page-shell'),'::before');
        assert(glass.backgroundColor===getComputedStyle(document.querySelector('.sidebar-left')).backgroundColor,'Top bar does not share sidebar material');
        assert(glass.backdropFilter!=='none','Top bar glass blur is missing');
        assert(document.querySelector('.scheduled-tasks-page-toolbar').classList.contains('main-chat-header'),'Top bar does not reuse chat header');
        assert(document.querySelector('.scheduled-tasks-page').clientWidth>window.innerWidth*0.6,'Tasks page is not using the main stage');
        if(phase==='create') {
          await wait(()=>buttons().find(button=>button.textContent.trim()==='创建任务' && !button.disabled),'Create task stayed disabled: workspace is not loaded');
          click('创建任务');
          await wait(()=>document.querySelector('.scheduled-task-form'),'Task form did not open');
          const form=document.querySelector('.scheduled-task-form');
          const fill=(labelText,value)=>{
            const label=[...form.querySelectorAll('label')].find(label=>label.firstChild.textContent===labelText);
            assert(label,'Missing label: '+labelText);const input=label.querySelector('input,textarea,select');
            const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,value);
            input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));
          };
          fill('名称','英语复习');fill('执行内容（Prompt）','提醒我复习英语');
          fill('执行权限','full');fill('推理强度','high');
          const modelValue=JSON.stringify(['task-smoke','reasoner']);
          await wait(()=>[...form.querySelectorAll('option')].some(option=>option.value===modelValue),'Model catalog did not update');
          fill('模型',modelValue);
          await new Promise(resolve=>setTimeout(resolve,50));
          const effort=[...form.querySelectorAll('label')].find(label=>label.firstChild.textContent==='推理强度').querySelector('select');
          assert([...effort.options].some(option=>option.value==='high'),'Reasoning model omitted high effort');
          fill('模型','');await new Promise(resolve=>setTimeout(resolve,50));
          const plainValue=JSON.stringify(['task-smoke','plain']);
          await wait(()=>[...form.querySelectorAll('option')].some(option=>option.value===plainValue),'Plain model did not appear');
          fill('模型',plainValue);await new Promise(resolve=>setTimeout(resolve,50));
          assert(![...effort.options].some(option=>option.value==='high'),'Plain model offers unsupported effort');
          assert(effort.value==='','Unsupported effort did not reset');
          fill('模型',modelValue);await new Promise(resolve=>setTimeout(resolve,50));fill('推理强度','high');
          await window.vela.removeModel('task-smoke','plain');
          assert(form.scrollWidth<=form.clientWidth+1,'Task form overflows horizontally');
          await new Promise(resolve=>setTimeout(resolve,50));click('保存任务');
          await wait(()=>document.querySelector('.scheduled-task-card'),'Created task did not appear');
          let state=await api.list();assert(state.tasks.length===1,'Form did not create exactly one task');
          const task=state.tasks[0];assert(task.sandboxMode==='full','Task permissions were lost');assert(task.model?.id==='reasoner','Task model was lost');assert(task.thinkingLevel==='high','Task effort was lost');assert(task.workspace===workspace,'Form used wrong workspace');assert(task.schedule.kind==='daily','Form schedule mismatch');
          click('暂停');await wait(async()=> (await api.list()).tasks[0].status==='paused','Pause failed');
          click('恢复');await wait(async()=> (await api.list()).tasks[0].status==='active','Resume failed');
          click('编辑');await wait(()=>document.querySelector('.scheduled-task-form'),'Edit form missing');
          const editForm=document.querySelector('.scheduled-task-form');
          const readSelect=text=>[...editForm.querySelectorAll('label')].find(label=>label.firstChild.textContent===text).querySelector('select').value;
          assert(readSelect('执行权限')==='full','Edit did not restore permissions');assert(readSelect('模型')===modelValue,'Edit did not restore model');assert(readSelect('推理强度')==='high','Edit did not restore effort');
          const edited=document.querySelector('.scheduled-task-form input');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(edited,'英语复习（已编辑）');edited.dispatchEvent(new Event('input',{bubbles:true}));
          await new Promise(resolve=>setTimeout(resolve,50));click('保存任务');
          await wait(async()=> (await api.list()).tasks[0].title==='英语复习（已编辑）','Edit failed');
          await window.vela.removeModel('task-smoke','reasoner');
          click('立即执行');
          state=await wait(async()=>{const state=await api.list();return state.runs.some(run=>run.taskId===task.id && run.status==='failed') && state;},'Manual execution did not record missing-model failure');
          assert(state.runs[0].conversationId,'Manual execution did not link a chat');
          assert((await window.vela.getState()).activeConversationId===previous.activeConversationId,'Task stole active chat');
          click('执行记录 (1)');await wait(()=>document.querySelector('.scheduled-task-history'),'History did not expand');
          const once=await api.create({ title:'One shot',prompt:'One-shot reminder',workspace:other,schedule:{kind:'once',at:new Date(Date.now()+1500).toISOString()} });
          state=await wait(async()=>{const state=await api.list();return state.runs.some(run=>run.taskId===once.id && run.status==='failed') && state;},'Scheduled one-shot execution did not run');
          const onceRun=state.runs.find(run=>run.taskId===once.id);
          const chats=(await window.vela.getState()).conversations;
          assert(chats.find(chat=>chat.id===onceRun.conversationId)?.cwd===other,'Scheduled execution used wrong workspace');
          assert(state.tasks.find(task=>task.id===once.id).status==='completed','One-shot stayed active');
          const disposable=await api.create({title:'Delete fixture',prompt:'delete',workspace,schedule:{kind:'daily',time:'10:00',timezone:'Asia/Taipei'}});
          await api.delete(disposable.id);assert(!(await api.list()).tasks.some(task=>task.id===disposable.id),'Delete failed');
          const panel=document.querySelector('.scheduled-tasks-page');
          assert(panel.scrollWidth<=panel.clientWidth+1,'Task list overflows horizontally');
          newChatEntry.click();
          await wait(()=>document.querySelector('.main-chat-view')?.closest('.main-stage-pane:not(.is-hidden)'),'Sidebar new-chat action did not leave task page');
          await wait(async()=> (await window.vela.getState()).activeConversationId!==previous.activeConversationId,'Sidebar new-chat action did not create chat');
          await window.vela.switchConversation(previous.activeConversationId);
          tasksEntry.click();await wait(()=>document.querySelector('.scheduled-tasks-page'),'Task page did not reopen');
          await wait(()=>buttons().some(button=>button.textContent.trim()==='执行记录 (1)'),'Task history did not reload');
          click('执行记录 (1)');await wait(()=>buttons().some(button=>button.textContent.trim()==='打开对话'),'History chat action missing');
          click('打开对话');
          await wait(async()=> (await window.vela.getState()).activeConversationId===onceRun.conversationId,'History did not open the task chat');
          await wait(()=>document.querySelector('.main-chat-view')?.closest('.main-stage-pane:not(.is-hidden)'),'Opening a task chat did not leave the task page');
          await window.vela.switchConversation(previous.activeConversationId);
          tasksEntry.click();await wait(()=>document.querySelector('.scheduled-tasks-page'),'Task page did not reopen after history navigation');
          await wait(()=>getComputedStyle(document.querySelector('.scheduled-tasks-stage')).opacity==='1','Task page transition did not finish');
          assert(!document.querySelector('.main-stage-pane:not(.is-hidden) .main-chat-view'),'Chat remains visible beside the task page');
          return {taskId:task.id,onceId:once.id,runIds:state.runs.map(run=>run.id),active:previous.activeConversationId};
        }
        const saved=${JSON.stringify(phase === "restore" ? JSON.parse(readFileSync(join(data, "saved.json"), "utf8")) : null)};
        const state=await api.list();assert(state.tasks.length===2,'Tasks did not survive restart');
        const restoredTask=state.tasks.find(task=>task.id===saved.taskId);
        assert(restoredTask.sandboxMode==='full' && restoredTask.model?.id==='reasoner' && restoredTask.thinkingLevel==='high','Execution options did not survive restart');
        assert(state.tasks.find(task=>task.id===saved.taskId)?.title==='英语复习（已编辑）','Edited task not restored');
        assert(state.tasks.find(task=>task.id===saved.onceId)?.status==='completed','Completed one-shot not restored');
        assert(state.runs.length===saved.runIds.length,'Restart duplicated a run');
        assert(state.runs.every(run=>saved.runIds.includes(run.id)),'Restart changed run IDs');
        click('删除');await wait(()=>buttons().some(button=>button.textContent.trim()==='确认删除'),'Delete confirmation did not appear');
        click('确认删除');await wait(async()=> (await api.list()).tasks.length===1,'UI delete failed');
        return {restored:true};
      })()`);
      if (phase === "create") {
        writeFileSync(join(data, "saved.json"), JSON.stringify(result));
        if (process.env.VELA_TASK_SMOKE_SCREENSHOT) {
          await win.webContents.executeJavaScript(`(async () => {
            [...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='创建任务').click();
            for(let i=0;i<100 && !document.querySelector('.scheduled-task-form');i++) await new Promise(resolve=>setTimeout(resolve,25));
            document.querySelector('.scheduled-tasks-page-scroll').scrollTop=100;
          })()`);
          writeFileSync(process.env.VELA_TASK_SMOKE_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
        }
      }
      clearTimeout(deadline); console.log(`PASS Scheduled Tasks ${phase}`); app.quit();
    } catch (error) { clearTimeout(deadline); console.error(error); app.exit(1); }
  });
});
await import(pathToFileURL(join(root, "out/main/index.mjs")).href);
