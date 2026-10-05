import { BrowserWindow, dialog, ipcMain } from 'electron';
import { isAbsolute, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { TaskRecipesIpc } from '@vela/shared';
import { TaskRecipeService } from './task-recipe-service';
import { exportRecipeExchange, parseRecipeExchange } from './task-recipe-library';
import type { AgentRuntime } from '@vela/agent';

export class TaskRecipeHost {
  private unsubscribe: (() => void) | null = null;
  constructor(private readonly service: TaskRecipeService, private readonly workspaces: () => string[], private readonly runtime?: AgentRuntime) {}
  register(): void {
    ipcMain.handle(TaskRecipesIpc.list, (_event, locale) => this.service.list(locale));
    ipcMain.handle(TaskRecipesIpc.save, (_event, input, id, revision, workspace) => this.service.save(input, id, revision, workspace));
    ipcMain.handle(TaskRecipesIpc.delete, (_event, id, fingerprint) => this.service.delete(id, fingerprint));
    ipcMain.handle(TaskRecipesIpc.stageEvidence, (_event, id, stageId, attempt, evidenceId) => {
      const { run, evidence } = this.service.evidenceReference(id, stageId, attempt, evidenceId);
      if (!this.runtime) throw new Error('聊天运行时不可用'); return this.runtime.getRecipeEvidence(run, evidence);
    });
    ipcMain.handle(TaskRecipesIpc.approveStage, (_event, id, stageId, approved) => this.service.approveStage(id, stageId, approved));
    ipcMain.handle(TaskRecipesIpc.retryStage, (_event, id, stageId, requestId) => this.service.retryStage(id, stageId, requestId));
    ipcMain.handle(TaskRecipesIpc.rateRun, (_event, id, rating, note) => this.service.rateRun(id, rating, note));
    ipcMain.handle(TaskRecipesIpc.connectTeam, (_event, workspace, permission) => this.service.connectTeam(workspace, permission));
    ipcMain.handle(TaskRecipesIpc.disconnectTeam, (_event, workspace) => this.service.disconnectTeam(workspace));
    ipcMain.handle(TaskRecipesIpc.saveTeam, (_event, input, workspace, id, revision, fingerprint) => this.service.saveTeam(input, workspace, id, revision, fingerprint));
    ipcMain.handle(TaskRecipesIpc.preview, (_event, draft) => this.service.preview(draft));
    ipcMain.handle(TaskRecipesIpc.start, (_event, input) => this.service.start(input));
    ipcMain.handle(TaskRecipesIpc.generate, (_event, input) => { if (!this.runtime) throw new Error('AI 整理不可用'); return this.runtime.generateRecipe(input); });
    ipcMain.handle(TaskRecipesIpc.cancelGenerate, (_event, id) => { if (typeof id !== 'string' || id.length > 100) throw new Error('请求 ID 不正确'); this.runtime?.cancelRecipeGeneration(id); });
    ipcMain.handle(TaskRecipesIpc.cleanupWorktree, (_event, id) => this.service.cleanupWorktree(id));
    ipcMain.handle(TaskRecipesIpc.importFile, async event => {
      const win = BrowserWindow.fromWebContents(event.sender); const options = { properties: ['openFile'] as ('openFile')[], filters: [{ name: 'Task Recipes', extensions: ['json'] }] };
      const selection = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0]) return null;
      if ((await stat(selection.filePaths[0])).size > 4_000_000) throw new Error('导入文件最多 4 MB');
      return parseRecipeExchange(await readFile(selection.filePaths[0], 'utf8'));
    });
    ipcMain.handle(TaskRecipesIpc.exportFile, async (event, raw) => {
      const recipe = this.service.validateSnapshot(raw); const text = exportRecipeExchange(recipe);
      const win = BrowserWindow.fromWebContents(event.sender); const options = { defaultPath: 'task-recipe.json', filters: [{ name: 'Task Recipes', extensions: ['json'] }] };
      const selection = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (selection.canceled || !selection.filePath) return false;
      await writeFile(selection.filePath, text, { encoding: 'utf8', mode: 0o600 }); return true;
    });
    ipcMain.handle(TaskRecipesIpc.pickPath, async (event, workspace, kind) => {
      if (typeof workspace !== 'string' || !this.workspaces().includes(workspace) || !['file', 'directory', 'any'].includes(kind)) throw new Error('路径选择范围不正确');
      const root = await realpath(workspace);
      const win = BrowserWindow.fromWebContents(event.sender);
      const options = { defaultPath: workspace, properties: (kind === 'file' ? ['openFile'] : kind === 'directory' ? ['openDirectory'] : ['openFile', 'openDirectory']) as ('openFile' | 'openDirectory')[] };
      const selection = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0]) return null;
      const target = await realpath(selection.filePaths[0]); const path = relative(root, target);
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('所选路径越出工作区');
      return path || '.';
    });
    this.unsubscribe = this.service.subscribe(() => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(TaskRecipesIpc.state);
    });
  }
  dispose(): void { this.unsubscribe?.(); for (const channel of Object.values(TaskRecipesIpc)) if (channel !== TaskRecipesIpc.state) ipcMain.removeHandler(channel); }
}
