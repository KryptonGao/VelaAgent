/** Loopback HTTP/OAuth MCP fixture shared by SDK and Electron/ASAR smoke tests. */
import { createServer } from 'node:http';

export async function startMcpHttpFixture() {
  let origin = '';
  let hangDiscovery = false;
  let discoveryStarted;
  const requests = [];
  const tokenRequests = [];
  const tools = [
    { name: 'read-data', description: 'Read HTTP fixture data', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'write_data', description: 'Write HTTP fixture data', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
    { name: 'hang', description: 'Wait until cancelled', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  ];
  const server = createServer(async (req, res) => {
    try {
      const reply = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.url?.startsWith('/.well-known/')) {
        discoveryStarted?.();
        if (hangDiscovery) return;
        return reply({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (req.url === '/metadata') {
        discoveryStarted?.();
        if (hangDiscovery) return;
        return reply({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
      }
      if (req.url === '/token') {
        let body = ''; for await (const chunk of req) body += chunk;
        const grant = new URLSearchParams(body).get('grant_type') ?? 'unknown';
        tokenRequests.push(grant);
        const refreshed = grant === 'refresh_token';
        return reply({ access_token: refreshed ? 'controller-test-refreshed' : 'controller-test-access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fixture-refresh' });
      }
      if (req.url === '/mcp') {
        const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!['controller-test-access', 'controller-test-refreshed'].includes(token)) {
          res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }); return res.end();
        }
        if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
        if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
        let body = ''; for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        requests.push(request.method);
        if (request.id === undefined) { res.writeHead(202); return res.end(); }
        const result = value => reply({ jsonrpc: '2.0', id: request.id, result: value });
        switch (request.method) {
          case 'initialize': return result({ protocolVersion: request.params.protocolVersion, serverInfo: { name: 'oauth-fixture', version: '1' }, capabilities: { tools: {}, resources: {} } });
          case 'tools/list': return result({ tools });
          case 'tools/call':
            if (request.params.name === 'hang') return;
            return result({ content: [{ type: 'text', text: 'HTTP fixture success' }] });
          case 'resources/list': return result({ resources: [{ uri: 'fixture://data', name: 'data', mimeType: 'text/plain' }] });
          case 'resources/templates/list': return result({ resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'template' }] });
          case 'resources/read':
            if (request.params.uri === 'fixture://hang') return;
            return result({ contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'HTTP fixture resource' }] });
          default: return reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
        }
      }
      return reply({}, 404);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  let closing;
  return {
    origin, requests, tokenRequests,
    hang() { hangDiscovery = true; },
    discovered() { return new Promise(resolve => { discoveryStarted = resolve; }); },
    close() {
      closing ??= new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      return closing;
    },
  };
}
