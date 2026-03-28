#!/usr/bin/env tsx
/**
 * Pilot vs @playwright/mcp — Accurate End-to-End LLM Benchmark
 *
 * Uses `claude -p --output-format stream-json --verbose` to capture every
 * intermediate message, giving us:
 *
 *   - Exact tool result sizes (chars in each snapshot / navigate response)
 *   - Per-turn token counts (input, cache_creation, cache_read, output)
 *   - Actual dollar cost from Claude Code
 *   - Wall time for the full task
 *
 * Each task is run RUNS_PER_TASK times and averaged to reduce variance.
 *
 * Usage:
 *   npx tsx benchmark/llm-compare.ts
 *   npx tsx benchmark/llm-compare.ts --model haiku --runs 3
 */

import { spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const MODEL = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : 'sonnet';

const RUNS_PER_TASK = process.argv.includes('--runs')
  ? parseInt(process.argv[process.argv.indexOf('--runs') + 1], 10)
  : 3;

const TASK_SET = process.argv.includes('--tasks')
  ? process.argv[process.argv.indexOf('--tasks') + 1]
  : 'multi';

// Multi-step tasks: require 2-3 page navigations + interactions
// This is where snapshot size accumulation matters most
const MULTI_TASKS = [
  {
    id: 'hn_click_story',
    prompt: 'Go to https://news.ycombinator.com, click the #1 story link (not the comments), then tell me the first sentence or main point from the actual article page.',
  },
  {
    id: 'gh_trending_stars',
    prompt: 'Go to https://github.com/trending, click the #1 trending repository, then tell me how many total stars it has.',
  },
  {
    id: 'gh_repo_latest_release',
    prompt: 'Go to https://github.com/microsoft/vscode/releases, then tell me the version number and date of the latest release.',
  },
  {
    id: 'npm_search_click',
    prompt: 'Go to https://www.npmjs.com, search for "zod", click the first result, then tell me the weekly download count.',
  },
  {
    id: 'wiki_click_article',
    prompt: "Go to https://en.wikipedia.org/wiki/Main_Page, click on today's featured article link, then tell me the first sentence of the article.",
  },
];

// Simple read tasks: single page, no clicks — validates pilot_get effectiveness
// Target: pilot resolves these in 1 tool call using pilot_get
const SIMPLE_TASKS = [
  {
    id: 'hn_top_title',
    prompt: 'Go to https://news.ycombinator.com, tell me the title of the #1 story.',
  },
  {
    id: 'gh_repo_desc',
    prompt: 'Go to https://github.com/anthropics/claude-code, tell me the one-line repository description.',
  },
  {
    id: 'npm_react_downloads',
    prompt: 'Go to https://www.npmjs.com/package/react, tell me the weekly download count.',
  },
  {
    id: 'wiki_featured_title',
    prompt: "Go to https://en.wikipedia.org/wiki/Main_Page, tell me the title of today's featured article.",
  },
  {
    id: 'gh_trending_top',
    prompt: 'Go to https://github.com/trending, tell me the name of the #1 trending repository.',
  },
];

const TASKS = TASK_SET === 'simple' ? SIMPLE_TASKS
  : TASK_SET === 'all' ? [...MULTI_TASKS, ...SIMPLE_TASKS]
  : MULTI_TASKS;

// ---------- types ----------
interface TurnUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

interface RunResult {
  task_id: string;
  success: boolean;
  answer: string;
  total_time_ms: number;
  cost_usd: number;
  num_tool_calls: number;
  // Per-call tool result sizes (chars) — the raw data entering LLM context
  tool_result_chars: number[];
  // Aggregate tokens across all turns
  total_input_tokens: number;           // uncached fresh tokens
  total_cache_creation_tokens: number;  // tokens written to cache (full price)
  total_cache_read_tokens: number;      // tokens read from cache (1/10 price)
  total_output_tokens: number;
  // Context actually processed = input + cache_creation + cache_read
  total_context_tokens: number;
  error?: string;
}

interface TaskStats {
  task_id: string;
  runs: number;
  success_rate: number;
  avg_time_ms: number;
  avg_cost_usd: number;
  avg_tool_calls: number;
  avg_tool_result_chars: number;   // average total chars from tool responses per task
  avg_context_tokens: number;
  avg_output_tokens: number;
  p50_time_ms: number;
  p50_cost_usd: number;
}

// ---------- helpers ----------
function findPwBin(): string | null {
  try {
    const r = execSync('ls ~/.npm/_npx/*/node_modules/.bin/playwright-mcp 2>/dev/null | head -1', { shell: '/bin/zsh' }).toString().trim();
    return r || null;
  } catch { return null; }
}

function writeTempConfig(servers: Record<string, any>): string {
  const tmp = path.join(os.tmpdir(), `mcp-bench-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2));
  return tmp;
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// ---------- single task run ----------
// extraArgs: MCP args like ['--mcp-config', path, '--strict-mcp-config']
//            or CLI args like ['--append-system-prompt', skillMd]
function runOnce(extraArgs: string[], task: typeof TASKS[0]): RunResult {
  const start = performance.now();

  const result = spawnSync(
    'claude',
    [
      '-p', task.prompt,
      '--model', MODEL,
      ...extraArgs,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ],
    { encoding: 'utf8', timeout: 180_000, input: '' }
  );

  const total_time_ms = Math.round(performance.now() - start);

  if (result.status !== 0 && !result.stdout) {
    return {
      task_id: task.id, success: false, answer: '',
      total_time_ms, cost_usd: 0, num_tool_calls: 0,
      tool_result_chars: [],
      total_input_tokens: 0, total_cache_creation_tokens: 0,
      total_cache_read_tokens: 0, total_output_tokens: 0,
      total_context_tokens: 0,
      error: (result.stderr || 'non-zero exit').slice(0, 200),
    };
  }

  // Parse stream-json events
  const lines = result.stdout.split('\n').filter(l => l.trim());
  const tool_result_chars: number[] = [];
  const turns: TurnUsage[] = [];
  let answer = '';
  let cost_usd = 0;
  let num_tool_calls = 0;
  let success = false;

  for (const line of lines) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'assistant') {
      const msg = obj.message ?? {};
      const usage = msg.usage ?? {};
      // Deduplicate: stream may emit same message multiple times as it streams
      // Keep only entries with output_tokens > 0 (complete messages)
      if (usage.output_tokens > 0) {
        turns.push({
          input_tokens:                usage.input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens:     usage.cache_read_input_tokens ?? 0,
          output_tokens:               usage.output_tokens ?? 0,
        });
      }
      // Count tool_use blocks
      for (const block of msg.content ?? []) {
        if (block.type === 'tool_use') num_tool_calls++;
      }
    }

    if (obj.type === 'user') {
      for (const block of (obj.message?.content ?? [])) {
        if (block.type === 'tool_result') {
          const content = block.content;
          const chars = typeof content === 'string'
            ? content.length
            : JSON.stringify(content).length;
          tool_result_chars.push(chars);
        }
      }
    }

    if (obj.type === 'result') {
      answer = (obj.result ?? '').slice(0, 300);
      cost_usd = obj.total_cost_usd ?? 0;
      success = !obj.is_error;
    }
  }

  // Aggregate tokens — sum across all turns
  const total_input_tokens = turns.reduce((s, t) => s + t.input_tokens, 0);
  const total_cache_creation_tokens = turns.reduce((s, t) => s + t.cache_creation_input_tokens, 0);
  const total_cache_read_tokens = turns.reduce((s, t) => s + t.cache_read_input_tokens, 0);
  const total_output_tokens = turns.reduce((s, t) => s + t.output_tokens, 0);
  const total_context_tokens = total_input_tokens + total_cache_creation_tokens + total_cache_read_tokens;

  return {
    task_id: task.id, success, answer,
    total_time_ms, cost_usd, num_tool_calls, tool_result_chars,
    total_input_tokens, total_cache_creation_tokens,
    total_cache_read_tokens, total_output_tokens, total_context_tokens,
  };
}

// ---------- run all tasks, RUNS_PER_TASK times each ----------
function benchmarkServer(label: string, extraArgs: string[]): TaskStats[] {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${label}  (${RUNS_PER_TASK} runs × ${TASKS.length} tasks)`);
  console.log('─'.repeat(60));

  const allStats: TaskStats[] = [];

  for (const task of TASKS) {
    const runs: RunResult[] = [];
    process.stdout.write(`  [${task.id}]`);

    for (let i = 0; i < RUNS_PER_TASK; i++) {
      process.stdout.write(` run${i + 1}...`);
      const r = runOnce(extraArgs, task);
      runs.push(r);
      const symbol = r.success ? `✓${r.total_time_ms}ms` : `✗`;
      process.stdout.write(symbol);
    }
    console.log();

    const successes = runs.filter(r => r.success);
    const n = successes.length;

    const stats: TaskStats = {
      task_id: task.id,
      runs: RUNS_PER_TASK,
      success_rate: n / RUNS_PER_TASK,
      avg_time_ms:        n > 0 ? Math.round(successes.reduce((s, r) => s + r.total_time_ms, 0) / n) : 0,
      avg_cost_usd:       n > 0 ? successes.reduce((s, r) => s + r.cost_usd, 0) / n : 0,
      avg_tool_calls:     n > 0 ? Math.round(successes.reduce((s, r) => s + r.num_tool_calls, 0) / n) : 0,
      avg_tool_result_chars: n > 0
        ? Math.round(successes.reduce((s, r) => s + r.tool_result_chars.reduce((a, b) => a + b, 0), 0) / n)
        : 0,
      avg_context_tokens: n > 0 ? Math.round(successes.reduce((s, r) => s + r.total_context_tokens, 0) / n) : 0,
      avg_output_tokens:  n > 0 ? Math.round(successes.reduce((s, r) => s + r.total_output_tokens, 0) / n) : 0,
      p50_time_ms: n > 0 ? median(successes.map(r => r.total_time_ms)) : 0,
      p50_cost_usd: n > 0 ? median(successes.map(r => Math.round(r.cost_usd * 10000))) / 10000 : 0,
    };

    allStats.push(stats);
  }

  return allStats;
}

// ---------- print comparison ----------
function printComparison(pilotStats: TaskStats[], pwStats: TaskStats[], compareLabel = '@playwright/mcp') {
  const W = 76;
  const sep  = '═'.repeat(W);
  const thin = '─'.repeat(W);

  const avgAcrossTasks = (stats: TaskStats[], key: keyof TaskStats) => {
    const vals = stats.map(s => s[key] as number);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  console.log('\n' + sep);
  console.log(`  PILOT vs ${compareLabel} — End-to-End LLM Benchmark`);
  console.log(`  Runtime: claude -p (Claude Code)  |  Model: ${MODEL}  |  ${RUNS_PER_TASK} runs/task`);
  console.log(sep);

  // Per-task rows
  for (let i = 0; i < TASKS.length; i++) {
    const p = pilotStats[i];
    const w = pwStats[i];

    const timeAdv    = w.avg_time_ms > 0          ? Math.round((1 - p.avg_time_ms / w.avg_time_ms) * 100)             : 0;
    const charAdv    = w.avg_tool_result_chars > 0 ? Math.round((1 - p.avg_tool_result_chars / w.avg_tool_result_chars) * 100) : 0;
    const tokenAdv   = w.avg_context_tokens > 0    ? Math.round((1 - p.avg_context_tokens / w.avg_context_tokens) * 100)    : 0;
    const costAdv    = w.avg_cost_usd > 0          ? Math.round((1 - p.avg_cost_usd / w.avg_cost_usd) * 100)                : 0;

    const adv = (n: number, unit: string) =>
      n > 0 ? `Pilot ${n}% ${unit}` : n < 0 ? `Pilot ${Math.abs(n)}% worse` : 'equal';

    console.log(`\n  ── ${TASKS[i].id} ──`);
    console.log(`  "${TASKS[i].prompt}"`);
    console.log(`  ${''.padEnd(26)} ${'Pilot'.padStart(10)}   ${compareLabel.padStart(16)}   Delta`);
    console.log(`  ${'Wall time p50 (ms)'.padEnd(26)} ${p.p50_time_ms.toLocaleString().padStart(10)}   ${w.p50_time_ms.toLocaleString().padStart(16)}   ${adv(timeAdv, 'faster')}`);
    console.log(`  ${'Wall time avg (ms)'.padEnd(26)} ${p.avg_time_ms.toLocaleString().padStart(10)}   ${w.avg_time_ms.toLocaleString().padStart(16)}`);
    console.log(`  ${'Tool result (chars)'.padEnd(26)} ${p.avg_tool_result_chars.toLocaleString().padStart(10)}   ${w.avg_tool_result_chars.toLocaleString().padStart(16)}   ${adv(charAdv, 'smaller')}`);
    console.log(`  ${'Context tokens'.padEnd(26)} ${p.avg_context_tokens.toLocaleString().padStart(10)}   ${w.avg_context_tokens.toLocaleString().padStart(16)}   ${adv(tokenAdv, 'fewer')}`);
    console.log(`  ${'Output tokens'.padEnd(26)} ${p.avg_output_tokens.toLocaleString().padStart(10)}   ${w.avg_output_tokens.toLocaleString().padStart(16)}`);
    console.log(`  ${'Tool calls'.padEnd(26)} ${p.avg_tool_calls.toLocaleString().padStart(10)}   ${w.avg_tool_calls.toLocaleString().padStart(16)}`);
    console.log(`  ${'Cost avg (USD)'.padEnd(26)} ${'$'+p.avg_cost_usd.toFixed(4).padStart(9)}   ${'$'+w.avg_cost_usd.toFixed(4).padStart(15)}   ${adv(costAdv, 'cheaper')}`);
    console.log(`  ${'Success rate'.padEnd(26)} ${(p.success_rate * 100).toFixed(0).padStart(9)+'%'}   ${(w.success_rate * 100).toFixed(0).padStart(15)+'%'}`);
  }

  // Averages across all tasks
  const pAvgTime   = Math.round(avgAcrossTasks(pilotStats, 'avg_time_ms'));
  const wAvgTime   = Math.round(avgAcrossTasks(pwStats,    'avg_time_ms'));
  const pAvgChars  = Math.round(avgAcrossTasks(pilotStats, 'avg_tool_result_chars'));
  const wAvgChars  = Math.round(avgAcrossTasks(pwStats,    'avg_tool_result_chars'));
  const pAvgTok    = Math.round(avgAcrossTasks(pilotStats, 'avg_context_tokens'));
  const wAvgTok    = Math.round(avgAcrossTasks(pwStats,    'avg_context_tokens'));
  const pAvgCost   = avgAcrossTasks(pilotStats, 'avg_cost_usd');
  const wAvgCost   = avgAcrossTasks(pwStats,    'avg_cost_usd');
  const pAvgCalls  = Math.round(avgAcrossTasks(pilotStats, 'avg_tool_calls'));
  const wAvgCalls  = Math.round(avgAcrossTasks(pwStats,    'avg_tool_calls'));
  const pSucc      = pilotStats.filter(s => s.success_rate === 1).length;
  const wSucc      = pwStats.filter(s => s.success_rate === 1).length;

  const timeAdv  = wAvgTime  > 0 ? Math.round((1 - pAvgTime  / wAvgTime)  * 100) : 0;
  const charAdv  = wAvgChars > 0 ? Math.round((1 - pAvgChars / wAvgChars) * 100) : 0;
  const tokenAdv = wAvgTok   > 0 ? Math.round((1 - pAvgTok   / wAvgTok)   * 100) : 0;
  const costAdv  = wAvgCost  > 0 ? Math.round((1 - pAvgCost  / wAvgCost)  * 100) : 0;
  const callAdv  = wAvgCalls > 0 ? Math.round((1 - pAvgCalls / wAvgCalls) * 100) : 0;

  console.log('\n' + thin);
  console.log(`  AVERAGES ACROSS ALL ${TASKS.length} TASKS (${RUNS_PER_TASK} runs each)`);
  console.log(`  ${''.padEnd(26)} ${'Pilot'.padStart(10)}   ${compareLabel.padStart(16)}   Delta`);
  console.log(`  ${'Wall time avg (ms)'.padEnd(26)} ${pAvgTime.toLocaleString().padStart(10)}   ${wAvgTime.toLocaleString().padStart(16)}   ${timeAdv >= 0 ? 'Pilot '+timeAdv+'% faster' : 'Pilot '+Math.abs(timeAdv)+'% slower'}`);
  console.log(`  ${'Tool result (chars)'.padEnd(26)} ${pAvgChars.toLocaleString().padStart(10)}   ${wAvgChars.toLocaleString().padStart(16)}   ${charAdv >= 0 ? 'Pilot '+charAdv+'% smaller' : 'Pilot '+Math.abs(charAdv)+'% larger'}`);
  console.log(`  ${'Context tokens'.padEnd(26)} ${pAvgTok.toLocaleString().padStart(10)}   ${wAvgTok.toLocaleString().padStart(16)}   ${tokenAdv >= 0 ? 'Pilot '+tokenAdv+'% fewer' : 'Pilot '+Math.abs(tokenAdv)+'% more'}`);
  console.log(`  ${'Tool calls avg'.padEnd(26)} ${pAvgCalls.toLocaleString().padStart(10)}   ${wAvgCalls.toLocaleString().padStart(16)}   ${callAdv >= 0 ? 'Pilot '+callAdv+'% fewer' : 'Pilot '+Math.abs(callAdv)+'% more'}`);
  console.log(`  ${'Cost avg (USD)'.padEnd(26)} ${'$'+pAvgCost.toFixed(4).padStart(9)}   ${'$'+wAvgCost.toFixed(4).padStart(15)}   ${costAdv >= 0 ? 'Pilot '+costAdv+'% cheaper' : 'Pilot '+Math.abs(costAdv)+'% costlier'}`);
  console.log(`  ${'Perfect success (all runs)'.padEnd(26)} ${`${pSucc}/${TASKS.length}`.padStart(10)}   ${`${wSucc}/${TASKS.length}`.padStart(16)}`);

  console.log('\n' + thin);
  console.log(`  KEY FINDINGS`);
  console.log(`  • Tool results fed to LLM:  Pilot ${Math.abs(charAdv)}% ${charAdv >= 0 ? 'smaller' : 'larger'} snapshots`);
  console.log(`  • Context tokens processed: Pilot ${Math.abs(tokenAdv)}% ${tokenAdv >= 0 ? 'fewer' : 'more'}`);
  console.log(`  • Wall time per task:       Pilot ${Math.abs(timeAdv)}% ${timeAdv >= 0 ? 'faster' : 'slower'}`);
  console.log(`  • Cost per task:            Pilot ${Math.abs(costAdv)}% ${costAdv >= 0 ? 'cheaper' : 'costlier'}`);
  console.log(sep + '\n');
}

const VS = process.argv.includes('--vs')
  ? process.argv[process.argv.indexOf('--vs') + 1]
  : 'mcp';  // 'mcp' | 'cli' | 'pilot-cli'

function findSkillMd(): string | null {
  try {
    const r = execSync('find $(npm root -g)/@playwright/cli -name "SKILL.md" 2>/dev/null | head -1', { shell: '/bin/zsh' }).toString().trim();
    return r || null;
  } catch { return null; }
}

function findPilotCliSkillMd(): string | null {
  // Local cli/SKILL.md relative to this benchmark file
  const local = path.resolve(fileURLToPath(import.meta.url), '../../cli/SKILL.md');
  if (fs.existsSync(local)) return local;
  return null;
}

// ---------- main ----------
async function main() {
  const serverPath = path.resolve(fileURLToPath(import.meta.url), '../../dist/index.js');
  if (!fs.existsSync(serverPath)) {
    console.error('❌ dist/index.js not found. Run: npm run build');
    process.exit(1);
  }

  const pilotConfig = writeTempConfig({
    pilot: { command: 'node', args: [serverPath] },
  });
  const pilotArgs = ['--mcp-config', pilotConfig, '--strict-mcp-config'];

  let compareLabel: string;
  let compareArgs: string[];
  let configToClean: string | null = null;

  if (VS === 'pilot-cli') {
    const skillPath = findPilotCliSkillMd();
    if (!skillPath) {
      console.error('❌ cli/SKILL.md not found. Run: npm run build first.');
      process.exit(1);
    }
    // Also ensure pilot-cli daemon is not already running from a previous run
    const daemonBin = path.resolve(fileURLToPath(import.meta.url), '../../dist/cli/daemon.js');
    if (!fs.existsSync(daemonBin)) {
      console.error('❌ dist/cli/daemon.js not found. Run: npm run build');
      process.exit(1);
    }
    const skillMd = fs.readFileSync(skillPath, 'utf8');
    // Inject the path to pilot-cli binary into the SKILL.md so the LLM knows the exact command
    const clientBin = path.resolve(fileURLToPath(import.meta.url), '../../dist/cli/client.js');
    const injected = `The pilot-cli binary for this session is: \`node ${clientBin}\`\nUse this exact command instead of \`pilot-cli\` in all examples below.\n\n${skillMd}`;
    compareLabel = 'pilot-cli';
    compareArgs  = ['--append-system-prompt', injected];
  } else if (VS === 'cli') {
    const skillPath = findSkillMd();
    if (!skillPath) {
      console.error('❌ @playwright/cli SKILL.md not found. Run: npm install -g @playwright/cli@latest');
      process.exit(1);
    }
    const skillMd = fs.readFileSync(skillPath, 'utf8');
    compareLabel = '@playwright/cli';
    compareArgs  = ['--append-system-prompt', skillMd];
  } else {
    const pwBin = findPwBin();
    if (!pwBin) {
      console.error('❌ @playwright/mcp not found. Run: npx @playwright/mcp@latest --version');
      process.exit(1);
    }
    const pwConfig = writeTempConfig({
      playwright: { command: 'node', args: [pwBin, '--headless'] },
    });
    configToClean = pwConfig;
    compareLabel = '@playwright/mcp';
    compareArgs  = ['--mcp-config', pwConfig, '--strict-mcp-config'];
  }

  console.log(`\nPilot vs ${compareLabel} — End-to-End LLM Benchmark`);
  console.log(`Runtime: claude -p  |  Model: ${MODEL}  |  ${RUNS_PER_TASK} runs × ${TASKS.length} tasks = ${RUNS_PER_TASK * TASKS.length * 2} total runs`);
  console.log(`Measuring: tool result size, context tokens, wall time, cost`);

  let pilotStats: TaskStats[], compareStats: TaskStats[];

  try {
    pilotStats   = benchmarkServer('Pilot', pilotArgs);
    compareStats = benchmarkServer(compareLabel, compareArgs);
  } finally {
    try { fs.unlinkSync(pilotConfig); } catch {}
    if (configToClean) try { fs.unlinkSync(configToClean); } catch {}
  }

  printComparison(pilotStats, compareStats, compareLabel);

  // Persist
  const jsonlPath = path.resolve(fileURLToPath(import.meta.url), '../../benchmark/results.jsonl');
  const record: any = {
    ts:            new Date().toISOString(),
    type:          'llm-comparison-accurate',
    model:         MODEL,
    runtime:       'claude-code',
    runs_per_task: RUNS_PER_TASK,
    tasks:         TASKS.map(t => t.id),
    pilot:         pilotStats,
  };
  if (VS === 'cli') record.playwright_cli = compareStats;
  else if (VS === 'pilot-cli') record.pilot_cli = compareStats;
  else record.playwright_mcp = compareStats;
  fs.appendFileSync(jsonlPath, JSON.stringify(record) + '\n');
  console.log(`Results saved to benchmark/results.jsonl\n`);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
