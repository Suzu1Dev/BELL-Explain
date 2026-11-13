import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatProgress } from './ai.js';
import { AppError } from './errors.js';
import {
  antigravityArguments,
  antigravityCli,
  antigravityEnvironment,
  createAntigravityChat,
  discoverAntigravity,
  normalizeAntigravitySettings,
  parseAntigravityJson,
  parseAntigravityModels,
  resolveAntigravityModelId,
  type AntigravityCli,
  type AntigravityRunOptions,
} from './antigravity.js';
import { ProviderSettingsStore } from './provider-settings.js';
import { ProviderService } from './provider-router.js';
import type { ProviderInfo, ProviderSettings } from '../shared/settings.js';

const sampleModelsOutput = [
  '⠋ Fetching available models...\rgemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
  'gemini-4-carbon-high\tGemini 4 Carbon (High)',
  'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-pro-orchestrator\tOrchestrator (Carbon)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
];

const parsedModels = parseAntigravityModels(sampleModelsOutput);
const carbon = parsedModels.find(model => model.id === 'gemini-4-carbon')!;
const flash = parsedModels.find(model => model.id === 'gemini-3.8-flash')!;
const orchestrator = parsedModels.find(model => model.id === 'gemini-pro-orchestrator')!;
const settings: ProviderSettings = { provider: 'antigravity', model: carbon.id, effort: 'high', speed: 'default', ponytailMode: 'full' };

const initEvent = (model = 'gemini-4-carbon-high', permissionMode = 'request-review') =>
  JSON.stringify({ event: 'init', conversation_id: 'c1', init: { model, cwd: '/tmp/w', tools: ['read_file'], permission_mode: permissionMode } });
const deltaEvent = (text: string, state = 'ACTIVE', stepIndex = 1) =>
  JSON.stringify({ event: 'step_update', step_update: { step_index: stepIndex, state, step_type: 'agent_response', text_delta: text } });
const resultEvent = (response: string, override: Record<string, unknown> = {}) =>
  JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response, ...override } });
const successLines = (text = '{"ok":true}', model = 'gemini-4-carbon-high') => [
  initEvent(model),
  deltaEvent(text, 'DONE'),
  resultEvent(text),
];

interface Call { args: string[]; cwd: string; input?: string; }
class FakeAgyCli implements AntigravityCli {
  calls: Call[] = [];
  constructor(
    public lines: string[] | ((call: Call) => string[]) = successLines(),
    private exitCode = 0,
    private hold?: (options: AntigravityRunOptions) => Promise<number | null>,
  ) {}
  async run(args: string[], options: AntigravityRunOptions) {
    const call: Call = { args, cwd: options.cwd, input: options.input };
    this.calls.push(call);
    const emitted = typeof this.lines === 'function' ? this.lines(call) : this.lines;
    for (const line of emitted) options.onLine(line);
    return this.hold ? this.hold(options) : this.exitCode;
  }
}

test('parseAntigravityModels groups thinking levels into per-model efforts and keeps ungrouped IDs', () => {
  assert.deepEqual(
    parsedModels.map(item => ({ id: item.id, name: item.name, isDefault: item.isDefault, defaultEffort: item.defaultEffort, efforts: item.efforts.map(e => e.id) })),
    [
      { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', isDefault: true, defaultEffort: 'medium', efforts: ['low', 'medium', 'high'] },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', isDefault: false, defaultEffort: 'medium', efforts: ['low', 'medium', 'high'] },
      { id: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)', isDefault: false, defaultEffort: 'default', efforts: ['default'] },
      { id: 'gpt-oss-120b', name: 'GPT-OSS 120B', isDefault: false, defaultEffort: 'medium', efforts: ['medium'] },
    ],
  );
  assert.equal(resolveAntigravityModelId(carbon, 'default'), 'gemini-4-carbon-medium');
  assert.equal(resolveAntigravityModelId(carbon, 'high'), 'gemini-4-carbon-high');
  assert.equal(resolveAntigravityModelId(orchestrator, 'default'), 'gemini-pro-orchestrator');
  assert.deepEqual(
    normalizeAntigravitySettings({ provider: 'antigravity', model: 'gemini-3.8-flash-low', effort: 'default', speed: 'default' }, parsedModels),
    { provider: 'antigravity', model: 'gemini-3.8-flash', effort: 'low', speed: 'default' },
  );
  assert.throws(() => parseAntigravityModels(['dup\tDup', 'dup\tDup 2']));
});

test('discoverAntigravity checks login via agy models in an isolated directory', async () => {
  const cli = new FakeAgyCli(sampleModelsOutput);
  const info = await discoverAntigravity(cli, new AbortController().signal);
  assert.deepEqual(cli.calls[0].args, ['models']);
  assert.equal(info.available, true);
  assert.equal(info.authenticated, true);
  assert.equal(info.models.length, 4);
  await assert.rejects(() => access(cli.calls[0].cwd));

  const signedOut = await discoverAntigravity(new FakeAgyCli([], 1), new AbortController().signal);
  assert.equal(signedOut.available, false);
  assert.equal(signedOut.authenticated, false);
  assert.match(signedOut.message, /agy/);
});

test('parseAntigravityJson handles raw JSON, markdown fences, and trailing summary notes cleanly', () => {
  assert.deepEqual(parseAntigravityJson('{"ok":true}'), { ok: true });
  assert.deepEqual(parseAntigravityJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(
    parseAntigravityJson('{"note":"brace {inside} string","count":2}\n\nSkipped extra checks; no risk.'),
    { note: 'brace {inside} string', count: 2 },
  );
  assert.throws(() => parseAntigravityJson('not json'), /JSON/);
  assert.throws(() => parseAntigravityJson('{"truncated":'), /JSON/);
});

test('createAntigravityChat isolates tools, sends stdin JSON, tracks progress/usage, and cleans up temp workspace', async () => {
  const events: ChatProgress[] = [];
  const lines = [
    initEvent('gemini-4-carbon-high'),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response' } }),
    deltaEvent('{"ok":', 'ACTIVE', 2),
    deltaEvent('true}\n', 'DONE', 2),
    resultEvent('{"ok":true}\n', { usage: { input_tokens: 1500, cache_read_tokens: 400, output_tokens: 80, thinking_tokens: 25 } }),
  ];
  const cli = new FakeAgyCli(lines);
  const result = await createAntigravityChat(settings, carbon, cli)(
    '教學代理',
    'Return JSON',
    { code: 'const x = 1;' },
    new AbortController().signal,
    progress => events.push(progress),
  );
  assert.deepEqual(result, { ok: true });
  const call = cli.calls[0];
  assert.deepEqual(call.args.slice(0, antigravityArguments.length), antigravityArguments);
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'gemini-4-carbon-high');
  const sessionSettings = JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
  assert.equal(sessionSettings.toolPermission, 'request-review');
  assert.equal(sessionSettings.enableTerminalSandbox, false);
  assert.equal(sessionSettings.allowNonWorkspaceAccess, false);
  assert.deepEqual(sessionSettings.permissions.allow, []);
  for (const rule of ['read_file(*)', 'write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)']) {
    assert.ok(sessionSettings.permissions.deny.includes(rule), rule);
  }
  const stdinEvent = JSON.parse(call.input!.trim());
  assert.equal(stdinEvent.event, 'user');
  assert.match(stdinEvent.message.content, /代理角色：教學代理\nReturn JSON/);
  assert.match(stdinEvent.message.content, /\{"code":"const x = 1;"\}/);
  assert.deepEqual(events.map(e => e.phase).filter((p, i, a) => p !== a[i - 1]), ['connecting', 'thinking', 'writing']);
  assert.deepEqual(events.at(-1)?.usage, { inputTokens: 1500, cachedInputTokens: 400, outputTokens: 80, reasoningTokens: 25 });
  await assert.rejects(() => access(call.cwd));
});

test('page images write scoped temp files and allow read_file only for those exact image paths', async () => {
  const cli = new FakeAgyCli(call => {
    const imgPath = join(call.cwd, 'page-1.png');
    return [
      initEvent('gemini-3.8-flash-medium'),
      JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: imgPath } } } }),
      JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { path: 'page-2.jpg' } } } }),
      deltaEvent('{"saw":2}', 'DONE', 3),
      resultEvent('{"saw":2}'),
    ];
  });
  const result = await createAntigravityChat({ ...settings, model: flash.id, effort: 'default' }, flash, cli)(
    '分析代理',
    'Read page image',
    { doc: true },
    new AbortController().signal,
    undefined,
    [
      { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', label: '第 1 頁影像' },
      { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', label: '第 2 頁影像' },
    ],
  );
  assert.deepEqual(result, { saw: 2 });
  const call = cli.calls[0];
  const sessionSettings = JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
  assert.deepEqual(sessionSettings.permissions.allow, [
    `read_file(${join(call.cwd, 'page-1.png')})`,
    `read_file(${join(call.cwd, 'page-2.jpg')})`,
  ]);
  assert.equal(sessionSettings.permissions.deny.includes('read_file(*)'), false);
  assert.ok(sessionSettings.permissions.deny.some((rule: string) => rule.endsWith('/.ssh)')));

  // Reading a traversal path, unapproved path, or calling any other tool stops the turn immediately.
  const traversalCli = new FakeAgyCli([
    initEvent('gemini-4-carbon-high'),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: '../page-1.png' } } } }),
    resultEvent('{"ok":true}'),
  ]);
  await assert.rejects(() => createAntigravityChat(settings, carbon, traversalCli)(
    'Teacher', 'JSON', {}, new AbortController().signal, undefined,
    [{ mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', label: 'p1' }],
  ), /教學以外的動作/);
  const roguePathCli = new FakeAgyCli([
    initEvent('gemini-4-carbon-high'),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: '/etc/passwd' } } } }),
    resultEvent('{"ok":true}'),
  ]);
  await assert.rejects(() => createAntigravityChat(settings, carbon, roguePathCli)('Teacher', 'JSON', {}, new AbortController().signal), /教學以外的動作/);

  const rogueToolCli = new FakeAgyCli([
    initEvent('gemini-4-carbon-high'),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } } }),
    resultEvent('{"ok":true}'),
  ]);
  await assert.rejects(() => createAntigravityChat(settings, carbon, rogueToolCli)('Teacher', 'JSON', {}, new AbortController().signal), /教學以外的動作/);
});

test('isolation checks, error mapping, environment filtering, and ProviderService routing work end-to-end', async t => {
  await assert.rejects(
    () => createAntigravityChat(settings, carbon, new FakeAgyCli([initEvent('wrong-model'), resultEvent('{"ok":true}')]))('Teacher', 'JSON', {}, new AbortController().signal),
    /隔離設定/,
  );
  const authErr = await createAntigravityChat(settings, carbon, new FakeAgyCli([initEvent(), JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'authentication required: token SECRET_TOKEN' } })]))('教學代理', 'JSON', {}, new AbortController().signal).then(() => undefined, err => err);
  assert.ok(authErr instanceof AppError);
  assert.equal(authErr.status, 502);
  assert.match(authErr.message, /agy/);
  assert.doesNotMatch(authErr.message, /SECRET_TOKEN/);

  const env = antigravityEnvironment({ HOME: '/home/u', PATH: '/bin', GEMINI_API_KEY: 'gem-key', AI_API_KEY: 'secret', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret' });
  assert.deepEqual(env, { HOME: '/home/u', PATH: '/bin', GEMINI_API_KEY: 'gem-key' });

  const dir = await mkdtemp(join(tmpdir(), 'bell-agy-cli-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, 'agy');
  await writeFile(script, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdout.write('spinner\\r{"ok":1}\\n');\n`);
  await chmod(script, 0o700);
  const lines: string[] = [];
  await antigravityCli(script).run([], { cwd: dir, input: 'hi', signal: new AbortController().signal, onLine: line => lines.push(line) });
  assert.deepEqual(lines, ['{"ok":1}']);

  const store = new ProviderSettingsStore(':memory:');
  const offline = (id: 'codex' | 'claude', name: string): ProviderInfo => ({ id, name, available: false, authenticated: false, message: 'offline', models: [] });
  const cli = new FakeAgyCli(successLines('{"routed":true}', 'gemini-3.8-flash-medium'));
  const service = new ProviderService({
    store,
    discover: async () => offline('codex', 'Codex'),
    discoverClaude: async () => offline('claude', 'Claude Code'),
    antigravityCli: cli,
    discoverAntigravity: async () => ({ id: 'antigravity', name: 'Antigravity', available: true, authenticated: true, message: 'ready', models: structuredClone(parsedModels) }),
  });
  try {
    const updated = await service.update({ provider: 'antigravity', model: 'gemini-3.8-flash-medium' });
    assert.equal(updated.settings.model, 'gemini-3.8-flash');
    assert.equal(updated.settings.effort, 'medium');
    assert.equal((await service.status()).configured, true);
    const out = await (await service.createChat())('Teacher', 'Return JSON', {}, new AbortController().signal);
    assert.deepEqual(out, { routed: true });
  } finally {
    store.close();
  }
});
