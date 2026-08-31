import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

if (process.argv.includes('--list-devices')) {
  process.stdout.write('Vulkan0: AMD Radeon RX 7900 XTX (RADV NAVI31)\n');
  process.exit(0);
}

const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const port = Number(option('--port'));
const alias = option('--alias');
const contextSize = Number(option('--ctx-size'));
const apiKey = readFileSync(option('--api-key-file'), 'utf8').trim();
const modelPath = option('--model');
if (Object.values(process.env).includes(apiKey)) process.exit(81);
if (modelPath.includes('crash-start')) process.exit(9);
let healthAttempts = 0;
const authorized = (request) => request.headers.authorization === `Bearer ${apiKey}`;

const server = createServer((request, response) => {
  if (request.url === '/health') {
    healthAttempts += 1;
    if (healthAttempts === 1) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"status":"loading"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}');
    return;
  }
  if (!authorized(request)) {
    response.writeHead(401);
    response.end();
    return;
  }
  if (request.url === '/props') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model_alias: modelPath.includes('wrong-props') ? 'wrong' : alias, total_slots: 1, default_generation_settings: { n_ctx: contextSize } }));
    return;
  }
  if (request.url === '/v1/chat/completions' && request.method === 'POST') {
    response.writeHead(200, { 'content-type': 'application/json' });
    const body = modelPath.includes('empty-choice')
      ? { choices: [], usage: { completion_tokens: 1 } }
      : modelPath.includes('zero-token')
        ? { choices: [{ message: { content: 'x' } }], usage: { completion_tokens: 0 } }
        : { choices: [{ message: { content: 'x' } }], usage: { completion_tokens: 1 } };
    response.end(JSON.stringify(body));
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, '127.0.0.1');
if (modelPath.includes('ignore-term')) {
  process.on('SIGTERM', () => {});
} else {
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
if (modelPath.includes('crash-ready')) setTimeout(() => process.exit(9), 80);
