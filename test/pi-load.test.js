import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle', 'cli.js');

function runNode(args, options) {
  const result = spawnSync(process.execPath, args, { ...options, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('packed extension installs, exposes /agenthint once, and uninstalls in Pi 1.1',
  { timeout: 60_000 }, async (t) => {
    const directory = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'pi-agenthint-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: join(directory, 'config'),
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0',
    };
    const options = { cwd: directory, env };
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, 'run through npm test so npm CLI is available');
    const packed = JSON.parse(runNode([
      npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', directory,
    ], { cwd: root, env }).stdout)[0];
    const paths = packed.files.map((file) => file.path);
    assert.ok(paths.includes('src/extension.js'));
    assert.ok(paths.includes('src/index.d.ts'));
    assert.ok(!paths.some((path) => /^(test|node_modules)\//.test(path)));

    const extracted = join(directory, 'unpacked');
    mkdirSync(extracted);
    const extraction = spawnSync('tar', [
      '-xf', join(directory, packed.filename), '-C', extracted,
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(extraction.status, 0, `${extraction.error ?? ''} ${extraction.stderr}`);
    const pluginDirectory = join(extracted, 'package');
    const manifest = JSON.parse(readFileSync(join(pluginDirectory, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies, undefined);

    runNode([host, 'install', pluginDirectory], options);
    const settingsPath = join(env.PI_CODING_AGENT_DIR, 'settings.json');
    const installedPaths = () => JSON.parse(readFileSync(settingsPath, 'utf8')).packages
      .map((entry) => resolve(env.PI_CODING_AGENT_DIR, typeof entry === 'string' ? entry : entry.source));
    assert.ok(installedPaths().includes(pluginDirectory));

    const child = spawn(process.execPath, [
      host, '--offline', '--no-session', '--no-approve', '--mode', 'rpc',
    ], options);
    const closed = new Promise((resolveClosed) => child.once('close', resolveClosed));
    t.after(() => { child.stdin.destroy(); child.kill(); });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout });
    let requestedStatus = false;
    try {
      await new Promise((resolveDone, reject) => {
        const timer = setTimeout(() => reject(new Error(`RPC timed out: ${stderr}`)), 20_000);
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`RPC exited early (${code}): ${stderr}`)));
        lines.on('line', (line) => {
          try {
            const event = JSON.parse(line);
            assert.notEqual(event.type, 'agent_start', 'status command must not call a model');
            if (event.type === 'response' && event.id === 'commands') {
              assert.equal(event.success, true);
              assert.equal(event.data.commands.filter((command) => command.name === 'agenthint').length, 1);
              requestedStatus = true;
              child.stdin.write(`${JSON.stringify({ id: 'status', type: 'prompt', message: '/agenthint' })}\n`);
            }
            if (event.type === 'extension_ui_request' && event.method === 'notify') {
              assert.ok(requestedStatus, 'no unsolicited RPC UI events');
              const status = JSON.parse(event.message);
              assert.equal(status.package, 'pi-agenthint');
              // 宿主版本不要写死：这里跑的是仓内 devDependency 的 Pi，版本会随升级变化。
              // 契约是「当前宿主版本在已验证清单里，且清单确实带版本号」。
              assert.ok(Array.isArray(status.verifiedPiVersions) && status.verifiedPiVersions.length > 0);
              assert.equal(status.hostVersionVerified, true,
                `Pi ${status.piVersion} 不在已验证清单 ${JSON.stringify(status.verifiedPiVersions)} 里`);
              assert.equal(status.enabled, true);
              clearTimeout(timer);
              resolveDone();
            }
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
        child.stdin.write(`${JSON.stringify({ id: 'commands', type: 'get_commands' })}\n`);
      });
    } finally {
      lines.close();
      child.stdin.destroy();
      child.kill();
      await closed;
    }

    runNode([host, 'remove', pluginDirectory], options);
    assert.ok(!installedPaths().includes(pluginDirectory));
  });
