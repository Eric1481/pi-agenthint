import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const host = join(
  dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
  'bundle',
  'cli.js',
);

function runNode(args, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

test('real Pi sends X-Agent-Hint to a mock provider without changing the body',
  { timeout: 60_000 }, async (t) => {
    const directory = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'pi-agenthint-e2e-'));
    const configDirectory = join(directory, 'config');
    const workspace = join(directory, 'workspace');
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    t.after(() => rmSync(directory, { recursive: true, force: true }));

    const captured = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        captured.push({ headers: req.headers, body });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        send(res, {
          id: 'agenthint-e2e',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'WIRE_OK' }, finish_reason: null }],
        });
        send(res, {
          id: 'agenthint-e2e',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
        });
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;

    writeFileSync(join(configDirectory, 'models.json'), `${JSON.stringify({
      providers: {
        'agenthint-e2e': {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: 'openai-completions',
          apiKey: 'local-test-key',
          models: [{
            id: 'mock',
            name: 'AgentHint E2E',
            reasoning: false,
            input: ['text'],
            contextWindow: 16_000,
            maxTokens: 1_024,
          }],
        },
      },
    }, null, 2)}\n`, 'utf8');
    writeFileSync(join(configDirectory, 'auth.json'), '{}\n', 'utf8');

    const result = await runNode([
      host,
      '--print',
      '--no-session',
      '--provider', 'agenthint-e2e',
      '--model', 'mock',
      '-e', join(root, 'src', 'extension.js'),
      'Reply with WIRE_OK.',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: configDirectory,
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
      },
    });

    assert.equal(result.code, 0, `pi exited ${result.code}\n${result.stdout}\n${result.stderr}`);
    assert.ok(captured.length >= 1, 'the real Pi process must reach the mock provider');

    const request = captured[0];
    const encoded = request.headers['x-agent-hint'];
    assert.equal(typeof encoded, 'string');
    const hint = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    assert.equal(typeof hint.session?.session_id, 'string');
    assert.ok(hint.session.session_id.length > 0);
    assert.equal(hint.session.call_index, 1);
    assert.equal(hint.agent_status.state, 'running');
    assert.equal(typeof hint.agent_status.state_since_ms, 'number');
    assert.equal(hint.agent_status.reason, undefined);
    assert.equal(hint.agent_status.tools, undefined);
    assert.equal(request.body.agent_hint, undefined, 'Agent Hint must not alter the provider body');
    assert.equal(request.body.model, 'mock');
  });
