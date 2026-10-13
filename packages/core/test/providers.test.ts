import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildProviders,
  claudeCodeArgs,
  estimateCostUsd,
  findOnPath,
  ProviderError,
  redact,
  type ProviderAdapter,
  type ProviderEnv,
  type ProviderId,
  type ProviderRunInput,
} from '../src/providers';

// Adapter tests run against recorded fixtures: a local HTTP server that answers like each provider, and small stand-in
// binaries for the CLIs. Nothing here touches the real network or a real provider.

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}
let server: Server;
let base = '';
let seen: Seen[] = [];
/** What the fixture server does next; tests set it. */
let reply: (req: Seen) => { status: number; body: unknown; delayMs?: number; raw?: string };

const FIXTURES = {
  anthropic: {
    id: 'msg_01',
    type: 'message',
    model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: 'Edited the form.\nSUMMARY: form done' }],
    usage: { input_tokens: 1200, output_tokens: 340 },
  },
  openai: {
    id: 'chatcmpl-1',
    model: 'gpt-4o-mini',
    choices: [{ message: { role: 'assistant', content: 'done\nSUMMARY: ok' } }],
    usage: { prompt_tokens: 900, completion_tokens: 80 },
  },
  gemini: {
    candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }],
    usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 60 },
  },
  ollamaTags: { models: [{ name: 'llama3.2:3b' }, { name: 'qwen2.5-coder:7b' }] },
  ollamaChat: {
    message: { role: 'assistant', content: 'local reply' },
    prompt_eval_count: 21,
    eval_count: 9,
  },
  lmstudioModels: { data: [{ id: 'qwen2.5-7b-instruct' }] },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString('utf8')));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        /* GETs have no body */
      }
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      seen.push(s);
      const r = reply(s);
      setTimeout(() => {
        res.statusCode = r.status;
        res.setHeader('content-type', 'application/json');
        res.end(r.raw ?? JSON.stringify(r.body));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  seen = [];
});

const KEY = 'sk-fixture-KEY-9876543210';
function env(over: Partial<ProviderEnv> = {}): ProviderEnv {
  return {
    fetch,
    baseUrl: () => base,
    findBinary: () => null,
    apiKey: () => KEY,
    ...over,
  };
}
const input = (over: Partial<ProviderRunInput> = {}): ProviderRunInput => ({
  prompt: 'Do the thing.',
  workdir: process.cwd(),
  model: null,
  timeoutMs: 5000,
  signal: new AbortController().signal,
  maxOutputChars: 10_000,
  ...over,
});
const adapter = (id: ProviderId, e = env()): ProviderAdapter => buildProviders(e)[id];

describe('anthropic-api', () => {
  it('posts the Messages API shape with the key in a header and maps text and usage', async () => {
    reply = () => ({ status: 200, body: FIXTURES.anthropic });
    const r = await adapter('anthropic-api').run(
      input({ system: 'Be brief.', model: 'claude-opus-5-5' }),
    );
    expect(r).toMatchObject({
      output: 'Edited the form.\nSUMMARY: form done',
      exitCode: 200,
      truncated: false,
      usage: { inputTokens: 1200, outputTokens: 340, costUsd: null },
      model: 'claude-sonnet-5-5',
    });
    const req = seen[0] as Seen;
    expect(req.url).toBe('/v1/messages');
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.body).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Do the thing.' }],
    });
    expect(JSON.stringify(req.body)).not.toContain(KEY);
  });

  it('uses its default model when none is chosen, and an estimate follows from the tokens', async () => {
    reply = () => ({ status: 200, body: FIXTURES.anthropic });
    const a = adapter('anthropic-api');
    await a.run(input());
    expect(seen[0]?.body['model']).toBe('claude-sonnet-5-5');
    expect(estimateCostUsd('anthropic-api', 'claude-sonnet-5-5', 1200, 340)).toBeCloseTo(
      (1200 * 3 + 340 * 15) / 1e6,
      8,
    );
  });

  it('no key: fails before any request; detect says so', async () => {
    const a = adapter('anthropic-api', env({ apiKey: () => null }));
    await expect(a.run(input())).rejects.toMatchObject({ code: 'no_key' });
    expect(seen).toHaveLength(0);
    expect(await a.detect()).toEqual({ available: false, detail: 'No API key set' });
    expect((await adapter('anthropic-api').detect()).available).toBe(true);
  });

  it('an error body that echoes the key is redacted in the thrown message', async () => {
    reply = () => ({
      status: 401,
      body: { error: { type: 'authentication_error', message: `invalid x-api-key: ${KEY}` } },
    });
    const e = (await adapter('anthropic-api')
      .run(input())
      .catch((x: unknown) => x)) as ProviderError;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe('failed');
    expect(e.exitCode).toBe(401);
    expect(e.message).toBe('HTTP 401: invalid x-api-key: ***');
    expect(e.message).not.toContain(KEY);
  });

  it('times out, honours an abort, rejects non-JSON, and keeps only the output cap', async () => {
    reply = () => ({ status: 200, body: FIXTURES.anthropic, delayMs: 400 });
    await expect(adapter('anthropic-api').run(input({ timeoutMs: 80 }))).rejects.toMatchObject({
      code: 'timeout',
    });
    const ac = new AbortController();
    const pending = adapter('anthropic-api').run(input({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', message: 'Cancelled.' });
    reply = () => ({ status: 200, body: null, raw: '<html>not json</html>' });
    await expect(adapter('anthropic-api').run(input())).rejects.toMatchObject({
      code: 'bad_response',
    });
    reply = () => ({ status: 200, body: FIXTURES.anthropic });
    const capped = await adapter('anthropic-api').run(input({ maxOutputChars: 10 }));
    expect(capped.output).toHaveLength(10);
    expect(capped.truncated).toBe(true);
  });
});

describe('openai-api', () => {
  it('posts chat completions with a bearer key and maps usage', async () => {
    reply = () => ({ status: 200, body: FIXTURES.openai });
    const r = await adapter('openai-api').run(input({ system: 'sys' }));
    expect(r.output).toBe('done\nSUMMARY: ok');
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 80, costUsd: null });
    const req = seen[0] as Seen;
    expect(req.url).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body).toMatchObject({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Do the thing.' },
      ],
    });
  });

  it('a reply without message content is a bad response', async () => {
    reply = () => ({ status: 200, body: { choices: [] } });
    await expect(adapter('openai-api').run(input())).rejects.toMatchObject({
      code: 'bad_response',
    });
  });
});

describe('gemini', () => {
  it('uses the REST API with the key in a header when no CLI is installed', async () => {
    reply = () => ({ status: 200, body: FIXTURES.gemini });
    const a = adapter('gemini');
    expect(await a.detect()).toEqual({ available: true, detail: 'Using the Gemini API (key set)' });
    const r = await a.run(input({ system: 'sys', model: 'gemini-2.5-pro' }));
    expect(r.output).toBe('hello world');
    expect(r.usage).toEqual({ inputTokens: 700, outputTokens: 60, costUsd: null });
    const req = seen[0] as Seen;
    expect(req.url).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
    expect(req.headers['x-goog-api-key']).toBe(KEY);
    expect(req.url).not.toContain(KEY);
    expect(req.body).toMatchObject({ systemInstruction: { parts: [{ text: 'sys' }] } });
  });

  it('is not detected with neither a CLI nor a key', async () => {
    const d = await adapter('gemini', env({ apiKey: () => null })).detect();
    expect(d.available).toBe(false);
    expect(d.detail).toMatch(/Neither the `gemini` CLI nor an API key/);
  });
});

describe('local (Ollama and LM Studio)', () => {
  it('detects Ollama, lists its models and runs a chat; local runs cost nothing', async () => {
    reply = (r) =>
      r.url === '/api/tags'
        ? { status: 200, body: FIXTURES.ollamaTags }
        : r.url === '/api/chat'
          ? { status: 200, body: FIXTURES.ollamaChat }
          : { status: 404, body: {} };
    const a = adapter('local');
    const d = await a.detect();
    expect(d).toEqual({ available: true, detail: `Ollama at ${base} (2 models)` });
    expect((await a.listModels?.())?.map((m) => m.id)).toEqual(['llama3.2:3b', 'qwen2.5-coder:7b']);
    const r = await a.run(input({ system: 'sys' }));
    expect(r.output).toBe('local reply');
    expect(r.usage).toEqual({ inputTokens: 21, outputTokens: 9, costUsd: 0 });
    const chat = seen.find((s) => s.url === '/api/chat') as Seen;
    expect(chat.body).toMatchObject({ model: 'llama3.2:3b', stream: false });
    expect(chat.headers.authorization).toBeUndefined();
    expect(estimateCostUsd('local', 'llama3.2:3b', 21, 9)).toBe(0);
  });

  it('falls back to an LM Studio server (OpenAI-compatible) when Ollama does not answer', async () => {
    reply = (r) =>
      r.url === '/v1/models'
        ? { status: 200, body: FIXTURES.lmstudioModels }
        : r.url === '/v1/chat/completions'
          ? { status: 200, body: FIXTURES.openai }
          : { status: 404, body: {} };
    const a = adapter('local');
    expect((await a.detect()).detail).toBe(`LM Studio at ${base} (1 model)`);
    const r = await a.run(input({ model: 'qwen2.5-7b-instruct' }));
    expect(r.output).toBe('done\nSUMMARY: ok');
    expect(seen.find((s) => s.url === '/v1/chat/completions')?.body['model']).toBe(
      'qwen2.5-7b-instruct',
    );
  });

  it('is not detected when nothing answers, and cannot run', async () => {
    const dead = adapter('local', env({ baseUrl: () => 'http://127.0.0.1:9' }));
    expect((await dead.detect()).available).toBe(false);
    await expect(dead.run(input())).rejects.toMatchObject({ code: 'not_available' });
  });
});

// ---- CLI adapters, against stand-in binaries ----

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-prov-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

/** A stand-in CLI: records its arguments and stdin, then prints what `body` says (JS, may use `args` and `stdin`). */
function fakeBin(name: string, body: string): string {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d)).on('end', async () => {
  const args = process.argv.slice(2);
  writeFileSync(${JSON.stringify(join(dir, `${name}.seen.json`))}, JSON.stringify({ args, stdin, cwd: process.cwd() }));
  ${body}
});\n`,
  );
  const bin = join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(
    bin,
    process.platform === 'win32'
      ? `@echo off\r\nnode "${script}" %*\r\n`
      : `#!/bin/sh\nexec node "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}
const seenBy = (name: string) =>
  JSON.parse(readFileSync(join(dir, `${name}.seen.json`), 'utf8')) as {
    args: string[];
    stdin: string;
    cwd: string;
  };

describe('claude-code', () => {
  const REPLY = {
    result: 'Edited src/login.ts.\nSUMMARY: login form done',
    is_error: false,
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 400,
      output_tokens: 55,
    },
  };

  it('builds read-only args without edits, edit args with them, and --model only when set', () => {
    const plain = claudeCodeArgs({ model: null, allowEdits: false });
    expect(plain).toEqual([
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--tools',
      'Read',
      'Grep',
      'Glob',
    ]);
    const edit = claudeCodeArgs({ model: 'opus', allowEdits: true });
    expect(edit).toContain('--permission-mode');
    expect(edit.slice(edit.indexOf('--model'), edit.indexOf('--model') + 2)).toEqual([
      '--model',
      'opus',
    ]);
    expect(edit).not.toContain('--tools');
    expect(plain).not.toContain('--model');
  });

  it('runs claude in the project folder, prompt on stdin, and reports exact usage and cost', async () => {
    const bin = fakeBin('claude', `console.log(JSON.stringify(${JSON.stringify(REPLY)}));`);
    const a = adapter('claude-code', env({ findBinary: (n) => (n === 'claude' ? bin : null) }));
    expect((await a.detect()).available).toBe(true);
    const r = await a.run(
      input({ workdir: dir, model: 'sonnet', system: 'You are X.', allowEdits: true }),
    );
    expect(r.output).toBe('Edited src/login.ts.\nSUMMARY: login form done');
    expect(r.usage).toEqual({ inputTokens: 432, outputTokens: 55, costUsd: 0.0123 });
    expect(r.exitCode).toBe(0);
    const s = seenBy('claude');
    expect(s.args).toContain('sonnet');
    expect(s.stdin).toBe('You are X.\n\nDo the thing.');
    expect(s.args.join(' ')).not.toContain('Do the thing');
    expect(s.cwd.toLowerCase()).toBe(dir.toLowerCase());
  });

  it('a non-zero exit, an error reply, and a missing binary are failures', async () => {
    const bad = fakeBin('bad', `console.error('boom'); process.exit(3);`);
    await expect(
      adapter('claude-code', env({ findBinary: () => bad })).run(input()),
    ).rejects.toMatchObject({ code: 'failed', exitCode: 3 });
    const iserr = fakeBin(
      'iserr',
      `console.log(JSON.stringify({ result: 'rate limited', is_error: true }));`,
    );
    await expect(
      adapter('claude-code', env({ findBinary: () => iserr })).run(input()),
    ).rejects.toThrow(/rate limited/);
    await expect(
      adapter('claude-code', env({ findBinary: () => null })).run(input()),
    ).rejects.toMatchObject({ code: 'not_available' });
    expect((await adapter('claude-code', env({ findBinary: () => null })).detect()).available).toBe(
      false,
    );
  });

  it('plain-text output (no JSON) is kept as the output with no usage; the cap truncates', async () => {
    const plain = fakeBin('plain', `console.log('x'.repeat(500));`);
    const r = await adapter('claude-code', env({ findBinary: () => plain })).run(
      input({ maxOutputChars: 100 }),
    );
    expect(r.output).toHaveLength(100);
    expect(r.truncated).toBe(true);
    expect(r.usage).toEqual({ inputTokens: null, outputTokens: null, costUsd: null });
  });

  it('a timeout or a cancel ends the process tree: no orphan is left', async () => {
    const hang = fakeBin(
      'hang',
      `import('node:child_process').then(({ spawn }) => { const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); writeFileSync(${JSON.stringify(join(dir, 'pids.json'))}, JSON.stringify([process.pid, c.pid])); setInterval(()=>{},1000); });`,
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const a = adapter('claude-code', env({ findBinary: () => hang }));
    const ac = new AbortController();
    const pending = a.run(input({ signal: ac.signal, timeoutMs: 20_000 }));
    let pids: number[] = [];
    for (let i = 0; i < 60 && pids.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        pids = JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8')) as number[];
      } catch {
        /* not yet */
      }
    }
    expect(pids).toHaveLength(2);
    expect(pids.every(alive)).toBe(true);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise((r) => setTimeout(r, 600));
    expect(pids.map(alive)).toEqual([false, false]);

    writeFileSync(join(dir, 'pids.json'), '[]');
    await expect(a.run(input({ timeoutMs: 700 }))).rejects.toMatchObject({ code: 'timeout' });
  }, 30_000);
});

describe('gemini CLI', () => {
  it('is preferred when installed: prompt on stdin, model via -m, no usage reported', async () => {
    const bin = fakeBin('gemini', `console.log('cli answer');`);
    const a = adapter('gemini', env({ findBinary: (n) => (n === 'gemini' ? bin : null) }));
    expect((await a.detect()).detail).toContain('gemini CLI found');
    const r = await a.run(input({ model: 'gemini-2.5-pro' }));
    expect(r.output).toBe('cli answer');
    expect(r.usage).toEqual({ inputTokens: null, outputTokens: null, costUsd: null });
    const s = seenBy('gemini');
    expect(s.args).toEqual([
      '-p',
      'Follow the instructions given on standard input.',
      '-m',
      'gemini-2.5-pro',
    ]);
    expect(s.stdin).toBe('Do the thing.');
    expect(seen).toHaveLength(0); // the API was not called
  });
});

describe('helpers', () => {
  it('redact replaces every occurrence and ignores short or empty secrets', () => {
    expect(redact('a KEY1234 b KEY1234', ['KEY1234', null, '', 'ab'])).toBe('a *** b ***');
  });

  it('estimates: sonnet/haiku/opus/gpt/gemini by name, unknown models and missing tokens give null', () => {
    expect(estimateCostUsd('anthropic-api', 'claude-haiku-5-5', 1_000_000, 1_000_000)).toBe(6);
    expect(estimateCostUsd('openai-api', 'gpt-4o-mini', 1_000_000, 0)).toBe(0.25);
    expect(estimateCostUsd('gemini', 'gemini-2.5-flash', 0, 1_000_000)).toBe(2.5);
    expect(estimateCostUsd('openai-api', 'mystery-9', 10, 10)).toBeNull();
    expect(estimateCostUsd('anthropic-api', 'claude-sonnet-5-5', null, null)).toBeNull();
  });

  it('findOnPath searches PATH then the installer folder', () => {
    const exists = (p: string) => p.includes('onpath');
    expect(findOnPath('gemini', { PATH: '/a/onpath:/b' }, exists)).toContain('onpath');
    expect(findOnPath('gemini', { PATH: '' }, () => false)).toBeNull();
  });
});
