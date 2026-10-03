import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
const [mode = 'normal', tracePath] = process.argv.slice(2);
if (tracePath) writeFileSync(tracePath, String(process.pid) + '\n');
let changed = false;
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const tools = () => [
  { name: 'read-data', description: changed ? 'Read changed fixture data' : 'Read fixture data', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'write_data', description: 'Write fixture data', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
  { name: 'change_tools', description: 'Change fixture list', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  ...(changed ? [{ name: 'new_read', description: 'New read tool', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] : []),
  { name: 'fail', description: 'Return an MCP error', inputSchema: { type: 'object', properties: {} } },
  { name: 'image_data', description: 'Return a PNG image', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'large_result', description: 'Return a large structured result', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: { text: { type: 'string' }, size: { type: 'number' } }, required: ['text', 'size'] }, annotations: { readOnlyHint: true } },
  { name: 'hang', description: 'Wait until cancelled', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'delayed', description: 'Complete after a delay', inputSchema: { type: 'object', properties: { delayMs: { type: 'number' } } }, annotations: { readOnlyHint: false } },
];
process.on('SIGTERM', () => { if (tracePath) appendFileSync(tracePath, 'closed\n'); process.exit(0); });
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (tracePath) appendFileSync(tracePath, `${request.method}\n`);
  if (request.method === 'notifications/initialized') send({ method: 'notifications/message', params: { level: 'info', data: 'fixture server started' } });
  if (request.id === undefined) return;
  const result = value => send({ id: request.id, result: value });
  switch (request.method) {
    case 'initialize':
      if (mode === 'fail') { process.stderr.write('fixture stderr failure\n'); process.exit(1); }
      if (mode === 'slow') return;
      return result({ protocolVersion: request.params.protocolVersion, serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: { listChanged: true }, resources: { listChanged: true } }, instructions: 'Fixture instructions' });
    case 'tools/list': return result({ tools: tools() });
    case 'tools/call':
      if (request.params.name === 'image_data') return result({ content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=' }] });
      if (request.params.name === 'large_result') {
        const text = 'START fixture large result\n' + 'x'.repeat(48000) + '\nEND fixture large result';
        return result({ content: [{ type: 'text', text }], structuredContent: { text, size: text.length }, _meta: { ignored: 'server-only' } });
      }
      if (request.params.name === 'hang') return;
      if (request.params.name === 'delayed') {
        setTimeout(() => {
          if (tracePath) appendFileSync(tracePath, 'completed:delayed\n');
          result({ content: [{ type: 'text', text: 'fixture delayed success' }] });
        }, request.params.arguments?.delayMs ?? 1000);
        return;
      }
      if (request.params.name === 'change_tools') {
        changed = true;
        send({ method: 'notifications/tools/list_changed' });
      }
      return result({ content: [{ type: 'text', text: request.params.name === 'fail' ? 'fixture tool error' : 'fixture success' }], ...(request.params.name === 'fail' ? { isError: true } : {}) });
    case 'resources/list': return result({ resources: [{ uri: 'fixture://data', name: 'data', mimeType: 'text/plain' }, { uri: 'ui://hidden', name: 'app' }] });
    case 'resources/templates/list': return result({ resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'template' }] });
    case 'resources/read':
      if (request.params.uri === 'fixture://hang') return;
      if (request.params.uri === 'fixture://error') return send({ id: request.id, error: { code: -32000, message: 'fixture resource error' } });
      return result({ contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'fixture resource' }] });
    default: return send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
  }
});
