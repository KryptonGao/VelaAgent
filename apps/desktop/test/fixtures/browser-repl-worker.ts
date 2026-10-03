import { parentPort } from 'node:worker_threads';
import { attachBrowserRepl } from '../../src/main/browser-repl-worker';
attachBrowserRepl(parentPort!);
