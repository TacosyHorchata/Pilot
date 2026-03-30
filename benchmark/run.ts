#!/usr/bin/env tsx
/**
 * Pilot MCP Benchmark
 *
 * Spawns the MCP server, runs 3 representative interactions,
 * and reports wall time + estimated token cost for each.
 *
 * Usage: npx tsx benchmark/run.ts [--url https://example.com] [--runs 3]
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

// ---------- config ----------
const TARGET_URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'https://news.ycombinator.com';

const RUNS = process.argv.includes('--runs')
  ? parseInt(process.argv[process.argv.indexOf('--runs') + 1], 10)
  : 1;

// Approximate token count: ~4 chars per token for English text, images counted by base64 size
function estimateTokens(result: any): number {
  let chars = 0;
  if (result?.content) {
    for (const block of result.content) {
      if (block.type === 'text') chars += block.text.length;
      else if (block.type === 'image') chars += block.data.length; // base64
    }
  }
  return Math.ceil(chars / 4);
}

function bytesHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- MCP client over stdio ----------
class McpClient {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private ready: Promise<void>;

  constructor(serverPath: string) {
    this.proc = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PILOT_PROFILE: 'full' },
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
      } catch { /* ignore non-JSON stderr leaks */ }
    });

    // Collect stderr for debugging
    this.proc.stderr?.on('data', () => {});

    this.ready = this.initialize();
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
      clientInfo: { name: 'pilot-benchmark', version: '1.0.0' },
    });
    // Send initialized notification (no response expected)
    const msg = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.proc.stdin!.write(msg + '\n');
  }

  async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    await this.ready;
    return this.send('tools/call', { name, arguments: args });
  }

  async close(): Promise<void> {
    this.proc.kill('SIGTERM');
    return new Promise((resolve) => this.proc.on('exit', resolve));
  }
}

// ---------- benchmark scenarios ----------
interface Scenario {
  name: string;
  tool: string;
  args: Record<string, any>;
}

function getScenarios(url: string): Scenario[] {
  return [
    {
      name: '1. navigate',
      tool: 'pilot_navigate',
      args: { url },
    },
    {
      name: '2. snapshot',
      tool: 'pilot_snapshot',
      args: {},
    },
    {
      name: '3. snapshot (interactive_only)',
      tool: 'pilot_snapshot',
      args: { interactive_only: true },
    },
  ];
}

// ---------- main ----------
interface Result {
  scenario: string;
  timeMs: number;
  tokens: number;
  bytes: number;
  error?: string;
}

async function runBenchmark(client: McpClient, scenarios: Scenario[]): Promise<Result[]> {
  const results: Result[] = [];

  for (const s of scenarios) {
    const start = performance.now();
    try {
      const res = await client.callTool(s.tool, s.args);
      const timeMs = performance.now() - start;
      const tokens = estimateTokens(res);
      const bytes = JSON.stringify(res).length;
      results.push({ scenario: s.name, timeMs, tokens, bytes });
    } catch (err: any) {
      const timeMs = performance.now() - start;
      results.push({ scenario: s.name, timeMs, tokens: 0, bytes: 0, error: err.message });
    }
  }

  return results;
}

function printResults(allRuns: Result[][]) {
  console.log('\n' + '═'.repeat(80));
  console.log('  PILOT MCP BENCHMARK');
  console.log('  Target: ' + TARGET_URL);
  console.log('  Runs: ' + allRuns.length);
  console.log('═'.repeat(80));

  // Aggregate across runs
  const scenarios = allRuns[0].map((r) => r.scenario);
  for (const name of scenarios) {
    const runs = allRuns.map((r) => r.find((x) => x.scenario === name)!);
    const times = runs.map((r) => r.timeMs);
    const tokens = runs.map((r) => r.tokens);
    const bytes = runs.map((r) => r.bytes);
    const errors = runs.filter((r) => r.error);

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const min = (arr: number[]) => Math.min(...arr);
    const max = (arr: number[]) => Math.max(...arr);

    console.log(`\n  ${name}`);
    if (errors.length > 0) {
      console.log(`    ❌ ${errors.length}/${runs.length} errors: ${errors[0].error}`);
    }
    if (allRuns.length === 1) {
      console.log(`    Time:   ${times[0].toFixed(0)}ms`);
      console.log(`    Tokens: ~${tokens[0].toLocaleString()}`);
      console.log(`    Bytes:  ${bytesHuman(bytes[0])}`);
    } else {
      console.log(`    Time:   avg ${avg(times).toFixed(0)}ms  (min ${min(times).toFixed(0)}ms, max ${max(times).toFixed(0)}ms)`);
      console.log(`    Tokens: avg ~${Math.round(avg(tokens)).toLocaleString()}  (min ~${min(tokens).toLocaleString()}, max ~${max(tokens).toLocaleString()})`);
      console.log(`    Bytes:  avg ${bytesHuman(Math.round(avg(bytes)))}`);
    }
  }

  // Totals
  const totals = allRuns.map((run) => ({
    time: run.reduce((s, r) => s + r.timeMs, 0),
    tokens: run.reduce((s, r) => s + r.tokens, 0),
    bytes: run.reduce((s, r) => s + r.bytes, 0),
  }));

  console.log('\n' + '─'.repeat(80));
  const avgTotal = (key: 'time' | 'tokens' | 'bytes') =>
    totals.reduce((s, t) => s + t[key], 0) / totals.length;

  console.log(`  TOTAL (per session)`);
  console.log(`    Time:   ${avgTotal('time').toFixed(0)}ms`);
  console.log(`    Tokens: ~${Math.round(avgTotal('tokens')).toLocaleString()}`);
  console.log(`    Bytes:  ${bytesHuman(Math.round(avgTotal('bytes')))}`);

  // Token cost comparison: 3-tier architecture
  const rawTokens = Math.round(avgTotal('tokens'));
  const TOOL_DEF_TOKENS = 2550; // ~51 tools * ~50 tokens each
  const AGENT_SUMMARY_TOKENS = 200; // concise summary to main session
  const HAIKU_ANSWER_TOKENS = 50; // browser-eye answer to browser agent

  console.log('\n' + '─'.repeat(80));
  console.log('  TOKEN COST: 3-TIER ARCHITECTURE');
  console.log('─'.repeat(80));
  console.log('');
  console.log('  Main Session (Opus)');
  console.log(`    Direct MCP:      ~${(rawTokens + TOOL_DEF_TOKENS).toLocaleString()} tokens/req (output + tool defs)`);
  console.log(`    Via browser agent: ~${AGENT_SUMMARY_TOKENS} tokens/req (summary only)`);
  console.log(`    Savings:          ${((1 - AGENT_SUMMARY_TOKENS / (rawTokens + TOOL_DEF_TOKENS)) * 100).toFixed(0)}%`);
  console.log('');
  console.log('  Browser Agent (Sonnet) — orchestration');
  console.log(`    Handles:         navigate, click, fill, multi-step flows`);
  console.log(`    Snapshot cost:   ~${rawTokens.toLocaleString()} tokens (isolated context)`);
  console.log(`    Delegates reads: to browser-eye (Haiku)`);
  console.log('');
  console.log('  Browser Eye (Haiku) — quick page reads');
  console.log(`    Handles:         "what's on page?", element checks, text extraction`);
  console.log(`    Input:           snapshot (~${rawTokens.toLocaleString()} tokens)`);
  console.log(`    Output:          ~${HAIKU_ANSWER_TOKENS} tokens (<100 words)`);
  console.log(`    Speed:           ~10x faster than Sonnet for read-only tasks`);
  console.log('');
  console.log('  Cost per "navigate + read page" flow:');
  console.log(`    Before: ~${(rawTokens + TOOL_DEF_TOKENS).toLocaleString()} Opus tokens`);
  console.log(`    After:  ~${AGENT_SUMMARY_TOKENS} Opus + ~${rawTokens.toLocaleString()} Sonnet + ~${(rawTokens + HAIKU_ANSWER_TOKENS).toLocaleString()} Haiku`);
  const opusCostPer1k = 0.015; // output
  const sonnetCostPer1k = 0.003;
  const haikuCostPer1k = 0.001;
  const beforeCost = ((rawTokens + TOOL_DEF_TOKENS) / 1000) * opusCostPer1k;
  const afterCost = (AGENT_SUMMARY_TOKENS / 1000) * opusCostPer1k
    + (rawTokens / 1000) * sonnetCostPer1k
    + ((rawTokens + HAIKU_ANSWER_TOKENS) / 1000) * haikuCostPer1k;
  console.log(`    $ cost:  $${beforeCost.toFixed(4)} → $${afterCost.toFixed(4)} (${((1 - afterCost / beforeCost) * 100).toFixed(0)}% cheaper)`);
  console.log('═'.repeat(80) + '\n');
}

async function main() {
  const serverPath = path.resolve(new URL('..', import.meta.url).pathname, 'dist', 'index.js');
  const scenarios = getScenarios(TARGET_URL);
  const allRuns: Result[][] = [];

  for (let i = 0; i < RUNS; i++) {
    if (RUNS > 1) console.log(`Run ${i + 1}/${RUNS}...`);
    const client = new McpClient(serverPath);

    try {
      const results = await runBenchmark(client, scenarios);
      allRuns.push(results);
    } finally {
      await client.close();
    }
  }

  printResults(allRuns);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
