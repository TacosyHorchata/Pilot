#!/usr/bin/env tsx
/**
 * Pilot vs @playwright/mcp Comparison Benchmark
 *
 * Runs identical browser tasks on both MCP servers and compares:
 * - Token efficiency (chars returned per tool call)
 * - Wall time
 * - Tool definition overhead
 *
 * Usage: npx tsx benchmark/playwright-compare.ts [--url https://example.com]
 * Requires: npm run build (to produce dist/index.js)
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// ---------- config ----------
const TARGET_URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'https://news.ycombinator.com';

// ---------- MCP client ----------
interface SpawnConfig {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

interface CallResult {
  time_ms: number;
  text_chars: number;
  image_chars: number;
  est_tokens: number;
  error?: string;
  unsupported?: boolean;
}

class McpClient {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private ready: Promise<void>;
  public tools: string[] = [];

  constructor(config: SpawnConfig, private startupDelayMs = 0) {
    this.proc = spawn(config.cmd, config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(config.env ?? {}) },
    });

    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } catch { /* ignore non-JSON lines */ }
    });

    this.proc.stderr?.on('data', () => {});

    this.ready = startupDelayMs > 0
      ? new Promise(r => setTimeout(r, startupDelayMs)).then(() => this.initialize())
      : this.initialize();
  }

  private send(method: string, params?: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.proc.stdin!.write(msg + '\n');
    });
  }

  private async initialize(): Promise<void> {
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pilot-compare', version: '1.0.0' },
    });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async listTools(): Promise<string[]> {
    await this.ready;
    const result = await this.send('tools/list');
    this.tools = (result?.tools ?? []).map((t: any) => t.name);
    return this.tools;
  }

  async callTool(name: string, args: Record<string, any> = {}): Promise<CallResult> {
    await this.ready;
    if (!this.tools.includes(name)) {
      return { time_ms: 0, text_chars: 0, image_chars: 0, est_tokens: 0, unsupported: true };
    }
    const start = performance.now();
    try {
      const res = await this.send('tools/call', { name, arguments: args });
      const time_ms = performance.now() - start;
      let text_chars = 0, image_chars = 0;
      for (const block of res?.content ?? []) {
        if (block.type === 'text') text_chars += block.text.length;
        else if (block.type === 'image') image_chars += (block.data ?? '').length;
      }
      return { time_ms, text_chars, image_chars, est_tokens: Math.ceil(text_chars / 4) };
    } catch (err: any) {
      return { time_ms: performance.now() - start, text_chars: 0, image_chars: 0, est_tokens: 0, error: err.message };
    }
  }

  async close(): Promise<void> {
    this.proc.kill('SIGTERM');
    return new Promise((resolve) => this.proc.on('exit', resolve));
  }
}

// ---------- helpers ----------
function findTextTool(tools: string[]): string | null {
  // Look for a tool that returns page text
  const candidates = ['browser_get_text', 'browser_text', 'browser_page_text', 'browser_content'];
  for (const c of candidates) if (tools.includes(c)) return c;
  // Fallback: any tool with 'text' in the name (but not screenshot/snapshot)
  return tools.find(t => t.includes('text') && !t.includes('screenshot') && !t.includes('snapshot')) ?? null;
}

function fmt(n: number, unit = '') {
  return n.toLocaleString() + unit;
}

function ratio(pilot: number, pw: number): string {
  if (pw === 0) return 'N/A';
  const r = pilot / pw;
  const pct = Math.round((1 - r) * 100);
  if (pct > 0) return `Pilot ${pct}% leaner`;
  if (pct < 0) return `Pilot ${Math.abs(pct)}% heavier`;
  return 'equal';
}

function printRow(label: string, pilot: number, pw: number, unit = '') {
  const pw_str = pw === 0 ? 'N/A' : fmt(pw, unit);
  console.log(`  ${label.padEnd(16)} ${fmt(pilot, unit).padStart(10)}   ${pw_str.padStart(16)}   ${ratio(pilot, pw)}`);
}

// ---------- main ----------
async function main() {
  const serverPath = path.resolve(fileURLToPath(import.meta.url), '../../dist/index.js');

  if (!fs.existsSync(serverPath)) {
    console.error(`❌ dist/index.js not found. Run: npm run build`);
    process.exit(1);
  }

  console.log(`\nStarting Pilot...`);
  const pilot = new McpClient({
    cmd: 'node',
    args: [serverPath],
    env: { PILOT_PROFILE: 'full' },
  });

  const pwBin = (() => {
    try {
      const result = execSync('ls ~/.npm/_npx/*/node_modules/.bin/playwright-mcp 2>/dev/null | head -1', { shell: '/bin/zsh' }).toString().trim();
      if (result) return result;
    } catch {}
    return null;
  })();

  console.log(`Starting @playwright/mcp${pwBin ? '' : ' (downloading via npx)'}...`);
  const pw = new McpClient(
    pwBin
      ? { cmd: 'node', args: [pwBin, '--headless'] }
      : { cmd: 'npx', args: ['@playwright/mcp@latest', '--headless'] },
    500  // give @playwright/mcp 500ms to start before sending initialize
  );

  // Discover tools on both servers
  const [pilotTools, pwTools] = await Promise.all([pilot.listTools(), pw.listTools()]);
  const pwTextTool = findTextTool(pwTools);

  // Pilot tool overhead: ~50 tokens per tool definition
  const TOKEN_PER_TOOL = 50;
  const pilotToolTokens = pilotTools.length * TOKEN_PER_TOOL;
  const pwToolTokens = pwTools.length * TOKEN_PER_TOOL;

  console.log(`\nRunning tasks on ${TARGET_URL}...`);

  // Run all scenarios sequentially (Pilot first, then playwright)
  const pilotNav    = await pilot.callTool('pilot_navigate',  { url: TARGET_URL });
  const pilotSnap   = await pilot.callTool('pilot_snapshot',  {});
  const pilotShot   = await pilot.callTool('pilot_screenshot', {});
  const pilotText   = await pilot.callTool('pilot_page_text', {});

  const pwNav    = await pw.callTool('browser_navigate', { url: TARGET_URL });
  const pwSnap   = await pw.callTool('browser_snapshot', {});
  const pwShot   = await pw.callTool('browser_screenshot', {});
  const pwText   = pwTextTool ? await pw.callTool(pwTextTool, {}) : { time_ms: 0, text_chars: 0, image_chars: 0, est_tokens: 0, unsupported: true };

  await pilot.close();
  await pw.close();

  // ---------- print results ----------
  const W = 70;
  const sep = '═'.repeat(W);
  const thin = '─'.repeat(W);

  console.log('\n' + sep);
  console.log(`  PILOT vs @playwright/mcp`);
  console.log(`  Target: ${TARGET_URL}`);
  console.log(sep);

  // Tool definition overhead
  console.log(`\n  TOOL DEFINITIONS (system prompt overhead on every request)`);
  console.log(`  Pilot:           ${pilotTools.length} tools  (~${fmt(pilotToolTokens)} tokens)`);
  console.log(`  @playwright/mcp: ${pwTools.length} tools  (~${fmt(pwToolTokens)} tokens)`);

  // Per-task comparison
  const header = `  ${'Task'.padEnd(16)} ${'Pilot'.padStart(10)}   ${'@playwright/mcp'.padStart(16)}`;

  // Navigate
  console.log(`\n${thin}`);
  console.log(`  NAVIGATE`);
  console.log(header);
  printRow('Time (ms)',    Math.round(pilotNav.time_ms),  Math.round(pwNav.time_ms));
  printRow('Text tokens',  pilotNav.est_tokens,           pwNav.est_tokens);

  // Snapshot (ARIA)
  console.log(`\n${thin}`);
  console.log(`  SNAPSHOT (ARIA text)`);
  console.log(header);
  printRow('Time (ms)',    Math.round(pilotSnap.time_ms), Math.round(pwSnap.time_ms));
  printRow('Text chars',   pilotSnap.text_chars,          pwSnap.text_chars);
  printRow('Text tokens',  pilotSnap.est_tokens,          pwSnap.est_tokens);

  // Screenshot
  console.log(`\n${thin}`);
  console.log(`  SCREENSHOT`);
  console.log(`  [Image data — base64 chars shown, not token-comparable to ARIA text]`);
  console.log(header);
  printRow('Time (ms)',    Math.round(pilotShot.time_ms), Math.round(pwShot.time_ms));
  printRow('Text chars',   pilotShot.text_chars,          pwShot.text_chars);
  printRow('Image chars',  pilotShot.image_chars,         pwShot.image_chars);

  // Page text
  console.log(`\n${thin}`);
  console.log(`  PAGE TEXT${pwTextTool ? ` (playwright: ${pwTextTool})` : ' (playwright: unsupported)'}`);
  if (!pwText.unsupported) {
    console.log(header);
    printRow('Time (ms)',   Math.round(pilotText.time_ms), Math.round(pwText.time_ms));
    printRow('Text tokens', pilotText.est_tokens,          pwText.est_tokens);
  } else {
    console.log(`  Pilot: ${fmt(pilotText.est_tokens)} tokens  |  @playwright/mcp: tool not found`);
  }

  // Summary
  const pilotTotal = pilotNav.est_tokens + pilotSnap.est_tokens + pilotText.est_tokens;
  const pwTotal = pwNav.est_tokens + pwSnap.est_tokens + pwText.est_tokens;

  console.log(`\n${thin}`);
  console.log(`  SUMMARY (navigate + snapshot + page_text)`);
  console.log(`  Pilot:           ~${fmt(pilotTotal)} tokens/turn`);
  console.log(`  @playwright/mcp: ~${fmt(pwTotal)} tokens/turn`);
  if (pwTotal > 0) {
    const savings = Math.round((1 - pilotTotal / pwTotal) * 100);
    console.log(`  Pilot advantage: ${savings > 0 ? `${savings}% fewer tokens per turn` : `${Math.abs(savings)}% more tokens per turn`}`);
  }
  console.log(sep + '\n');

  // ---------- persist to results.jsonl ----------
  const resultDir = path.resolve(fileURLToPath(import.meta.url), '../../benchmark');
  const jsonlPath = path.join(resultDir, 'results.jsonl');
  const record = {
    ts: new Date().toISOString(),
    type: 'comparison',
    url: TARGET_URL,
    pilot: {
      tool_count: pilotTools.length,
      navigate:   { time_ms: Math.round(pilotNav.time_ms),  text_chars: pilotNav.text_chars,  image_chars: pilotNav.image_chars,  est_tokens: pilotNav.est_tokens },
      snapshot:   { time_ms: Math.round(pilotSnap.time_ms), text_chars: pilotSnap.text_chars, image_chars: pilotSnap.image_chars, est_tokens: pilotSnap.est_tokens },
      screenshot: { time_ms: Math.round(pilotShot.time_ms), text_chars: pilotShot.text_chars, image_chars: pilotShot.image_chars, est_tokens: pilotShot.est_tokens },
      page_text:  { time_ms: Math.round(pilotText.time_ms), text_chars: pilotText.text_chars, image_chars: pilotText.image_chars, est_tokens: pilotText.est_tokens },
    },
    playwright_mcp: {
      tool_count: pwTools.length,
      navigate:   { time_ms: Math.round(pwNav.time_ms),  text_chars: pwNav.text_chars,  image_chars: pwNav.image_chars,  est_tokens: pwNav.est_tokens },
      snapshot:   { time_ms: Math.round(pwSnap.time_ms), text_chars: pwSnap.text_chars, image_chars: pwSnap.image_chars, est_tokens: pwSnap.est_tokens },
      screenshot: { time_ms: Math.round(pwShot.time_ms), text_chars: pwShot.text_chars, image_chars: pwShot.image_chars, est_tokens: pwShot.est_tokens },
      page_text:  pwText.unsupported
        ? { unsupported: true }
        : { time_ms: Math.round(pwText.time_ms), text_chars: pwText.text_chars, image_chars: pwText.image_chars, est_tokens: pwText.est_tokens },
    },
  };
  fs.appendFileSync(jsonlPath, JSON.stringify(record) + '\n');
  console.log(`Results appended to benchmark/results.jsonl`);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
