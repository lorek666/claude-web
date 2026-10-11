// Debug e2e for the two fork commits (084fba0 gateway effort rewrite, 6acb4e3 grok on openai providers),
// plus the assumption they stand on (the engine sends a thinking budget for a non-Claude model on an
// anthropic-format provider). Real server + real claude-web-engine, one fake upstream that records bodies:
//   A  anthropic provider, grok-4.7 + 更深      → upstream sees thinking.budget_tokens 32768, no output_config
//   B  gateway → member with effortAsOutputConfig → upstream sees output_config.effort "xhigh", no thinking
//   C  gateway → member without the flag (control) → upstream sees the budget untouched
//   D  openai provider, grok-4.7 + 更深         → upstream sees reasoning_effort "xhigh"
//   node server/ws-effort-debug.mjs
import WebSocket from 'ws';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-effort-debug-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'proj');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'README.md'), '# e2e\n');
const KEY = 'dbg-key';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };

// ---- fake upstream ----
const hits = [];
let n = 0;
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => typeof p === 'string' ? p : p?.text ?? '').join('\n') : '';
const turnText = (h) => {
  const msgs = h.body.messages ?? [];
  let i = msgs.length;
  while (i > 0 && msgs[i - 1].role !== 'assistant') i--;
  return msgs.slice(i).filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
};
const json = (s, status, o) => s.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));

function anthropic(q, s, j, h) {
  if (q.url.includes('/count_tokens')) return json(s, 200, { input_tokens: 10 });
  const msg = { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, stop_sequence: null };
  const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end(ev('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'anthropic:ok' } })
    + ev('content_block_stop', { index: 0 })
    + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
    + ev('message_stop', {}));
}

function openai(q, s, j) {
  if (q.method === 'GET' && q.url.endsWith('/models')) return json(s, 200, { object: 'list', data: [{ id: 'grok-4.7', object: 'model' }] });
  if (!q.url.endsWith('/chat/completions')) return json(s, 404, { error: { message: `Invalid URL (${q.method} ${q.url})` } });
  const base = { id: `c${++n}`, created: 1, model: j.model };
  const usage = { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 };
  const chunk = (o) => `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...o })}\n\n`;
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: `relay:${j.model}` }, finish_reason: null }] })
    + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + chunk({ choices: [], usage }) + 'data: [DONE]\n\n');
}

const upstream = http.createServer((q, s) => {
  let raw = '';
  q.on('data', (c) => { raw += c; });
  q.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch { /* keep */ }
    const url = q.url ?? '';
    const fmt = url.startsWith('/v1/messages') ? 'anthropic' : 'openai';
    const h = { fmt, method: q.method, url, body: j, status: 200 };
    hits.push(h);
    if (fmt === 'anthropic') return anthropic(q, s, j, h);
    openai(q, s, j);
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const up = `http://127.0.0.1:${upstream.address().port}`;
const mainOf = (fmt, marker) => hits.filter((h) => h.fmt === fmt && h.method === 'POST' && h.body.stream === true && turnText(h).includes(marker));

// ---- the server ----
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_|GEMINI_|GROK_|XAI_)/.test(k) || /^(no_proxy|https?_proxy|all_proxy)$/i.test(k)) delete env[k];
const server = spawn(process.execPath, [path.join(here, 'dist', 'index.js')], { cwd: path.dirname(here), env, stdio: ['ignore', 'pipe', 'pipe'] });
let slog = '';
server.stderr.on('data', (d) => { slog += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${slog}`)), 60_000);
  server.stdout.on('data', (d) => { slog += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(slog); if (m) { clearTimeout(t); res(m[1]); } });
  server.on('exit', (c) => rej(new Error(`server exited (${c})\n${slog}`)));
});

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
let seq = 0;
const pending = new Map();
const events = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type === 'event') events.push(m.event);
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const resultOf = (sid, from) => until(() => events.slice(from).find((e) => e.kind === 'session.event' && e.sessionId === sid && e.message.type === 'result')?.message, 120_000);
const opened = [];
async function openOn(providerId, model, extra = {}) {
  const o = await req({ kind: 'session.open', params: { cwd: proj, providerId, model, permissionMode: 'default', ...extra } });
  opened.push(o.sessionId);
  await until(() => events.some((e) => e.kind === 'session.state' && e.sessionId === o.sessionId && e.state === 'idle'), 90_000);
  return o;
}
async function turn(sid, text) {
  const from = events.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text } });
  return { result: await resultOf(sid, from), from };
}

async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  // providers: P1 plain anthropic (also the control gateway member), P2 with the rewrite flag, O openai
  const P1 = await req({ kind: 'providers.upsert', provider: { name: '桥-不开', type: 'anthropic', baseUrl: up, apiKey: KEY, defaultModel: 'grok-4.7', models: ['grok-4.7'] } });
  const P2 = await req({ kind: 'providers.upsert', provider: { name: '桥-开', type: 'anthropic', baseUrl: up, apiKey: KEY, defaultModel: 'grok-4.7', models: ['grok-4.7'], effortAsOutputConfig: true } });
  const O = await req({ kind: 'providers.upsert', provider: { name: '直连O', type: 'openai', baseUrl: `${up}/v1`, apiKey: KEY, defaultModel: 'grok-4.7', models: ['grok-4.7'], responsesApi: false } });
  const G2 = await req({ kind: 'gateway.groups.upsert', group: { name: '开', members: [{ providerId: P2.id }] } });
  const G1 = await req({ kind: 'gateway.groups.upsert', group: { name: '不开', members: [{ providerId: P1.id }] } });
  const GB = await req({ kind: 'providers.upsert', provider: { name: '网关-开', type: 'gateway', gatewayGroupId: G2.id } });
  const GA = await req({ kind: 'providers.upsert', provider: { name: '网关-不开', type: 'gateway', gatewayGroupId: G1.id } });
  await req({ kind: 'gateway.set', enabled: true });

  // A: plain anthropic provider — the engine should send a thinking budget for a non-Claude model
  // (the engine clamps the budget to max_tokens-1: xhigh's 32768 arrives as 31999 — ≥24576 is still the xhigh neighborhood)
  const a = await openOn(P1.id, 'grok-4.7', { effort: 'xhigh' });
  const ar = await turn(a.sessionId, 'DBG-A 你好');
  const am = mainOf('anthropic', 'DBG-A');
  check('A · anthropic provider, grok-4.7 + 更深 → a xhigh-neighborhood budget, no output_config', am.length > 0 && am.every((h) => h.body.thinking?.budget_tokens >= 24576 && h.body.thinking.budget_tokens < 63999 && !h.body.output_config), am.map((h) => JSON.stringify({ th: h.body.thinking, oc: h.body.output_config })).join(' | ').slice(0, 200));
  check('A · the answer comes back', /anthropic:ok/.test(ar.result?.result ?? ''), String(ar.result?.result ?? ar.result?.subtype ?? '(no result)').slice(0, 100));

  // B: gateway → member with effortAsOutputConfig — the passthrough rewrite carries the strength
  const b = await openOn(GB.id, 'grok-4.7', { effort: 'xhigh' });
  const br = await turn(b.sessionId, 'DBG-B 你好');
  const bm = mainOf('anthropic', 'DBG-B');
  check('B · gateway member with the flag → output_config.effort "xhigh", thinking gone', bm.length > 0 && bm.every((h) => h.body.output_config?.effort === 'xhigh' && !h.body.thinking), bm.map((h) => JSON.stringify({ th: h.body.thinking, oc: h.body.output_config })).join(' | ').slice(0, 200));
  check('B · the answer comes back', /anthropic:ok/.test(br.result?.result ?? ''), String(br.result?.result ?? br.result?.subtype ?? '(no result)').slice(0, 100));

  // C: gateway → member without the flag — the budget passes through byte for byte
  const c = await openOn(GA.id, 'grok-4.7', { effort: 'xhigh' });
  await turn(c.sessionId, 'DBG-C 你好');
  const cm = mainOf('anthropic', 'DBG-C');
  check('C · gateway member without the flag (control) → budget untouched', cm.length > 0 && cm.every((h) => h.body.thinking?.budget_tokens >= 24576 && h.body.thinking.budget_tokens < 63999 && !h.body.output_config), cm.map((h) => JSON.stringify({ th: h.body.thinking, oc: h.body.output_config })).join(' | ').slice(0, 200));

  // D: openai provider — native reasoning_effort
  const d = await openOn(O.id, 'grok-4.7', { effort: 'xhigh' });
  const dr = await turn(d.sessionId, 'DBG-D 你好');
  const dm = mainOf('openai', 'DBG-D');
  check('D · openai provider, grok-4.7 + 更深 → reasoning_effort "xhigh"', dm.length > 0 && dm.every((h) => h.body.reasoning_effort === 'xhigh'), dm.map((h) => String(h.body.reasoning_effort)).join(','));
  check('D · the answer comes back', /relay:grok-4\.7/.test(dr.result?.result ?? ''), String(dr.result?.result ?? dr.result?.subtype ?? '(no result)').slice(0, 100));

  for (const sid of opened) await req({ kind: 'session.close', sessionId: sid }).catch(() => { /* done */ });
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\neffort-debug: ${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

try { await main(); } catch (e) {
  console.error('ERROR', e?.message ?? e);
  const brief = (x) => x.kind === 'session.state' ? `${x.sessionId.slice(0, 8)} state ${x.state}${x.error ? ` (${x.error})` : ''}` : `${x.sessionId?.slice(0, 8)} ${x.message?.type}${x.message?.subtype ? `/${x.message.subtype}` : ''}${x.message?.type === 'result' ? ` ${String(x.message.result ?? x.message.errors ?? '').slice(0, 160)}` : ''}`;
  console.log(`\n--- events ---\n${events.filter((x) => x.kind === 'session.state' || (x.kind === 'session.event' && x.message?.type !== 'stream_event')).map(brief).join('\n')}`);
  console.log(`\n--- server log tail ---\n${slog.split('\n').slice(-30).join('\n')}`);
  process.exitCode = 1;
} finally {
  server.kill('SIGKILL');
  upstream.close();
}
