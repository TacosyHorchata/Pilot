#!/usr/bin/env node
/**
 * Pilot CLI client — sends commands to the daemon and prints output to stdout.
 *
 * Usage:
 *   pilot-cli daemon          # start daemon in background
 *   pilot-cli get <url>       # navigate + return content + interactive
 *   pilot-cli navigate <url>  # navigate
 *   pilot-cli snapshot        # get accessibility snapshot
 *   pilot-cli snapshot --file # snapshot to file, print path
 *   pilot-cli click <ref>     # click @ref or CSS selector
 *   pilot-cli fill <ref> <value>
 *   pilot-cli type <ref> <value>
 *   pilot-cli press <key>
 *   pilot-cli scroll [down|up] [px]
 *   pilot-cli url             # current URL
 *   pilot-cli title           # current title
 *   pilot-cli back
 *   pilot-cli forward
 *   pilot-cli stop            # stop daemon
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const SOCKET_PATH = path.join(os.tmpdir(), 'pilot-daemon.sock');
const PID_PATH    = path.join(os.tmpdir(), 'pilot-daemon.pid');
const DAEMON_BIN  = path.resolve(fileURLToPath(import.meta.url), '../../cli/daemon.js');

function isDaemonRunning(): boolean {
  if (!fs.existsSync(SOCKET_PATH) || !fs.existsSync(PID_PATH)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function ensureDaemon(): Promise<void> {
  if (isDaemonRunning()) return;
  // Launch daemon as detached background process
  const child = spawn('node', [DAEMON_BIN], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  // Wait for socket to appear (up to 8s — Chromium launch)
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (fs.existsSync(SOCKET_PATH)) break;
  }
  if (!fs.existsSync(SOCKET_PATH)) {
    console.error('Error: daemon failed to start');
    process.exit(1);
  }
  // Give it a moment to be ready
  await new Promise(r => setTimeout(r, 200));
}

function sendCommand(cmd: string, args: Record<string, any>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    let response = '';
    socket.on('connect', () => {
      socket.write(JSON.stringify({ cmd, args }) + '\n');
    });
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('end', () => {
      const lines = response.trim().split('\n');
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.ok) resolve(msg.output);
          else reject(new Error(msg.output));
          return;
        } catch {}
      }
      reject(new Error('No response from daemon'));
    });
    socket.on('error', reject);
    socket.setTimeout(30000, () => {
      socket.destroy();
      reject(new Error('Command timed out'));
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const subcmd = argv[0];

  if (!subcmd || subcmd === 'help' || subcmd === '--help') {
    console.log(`pilot-cli — browser automation CLI

Commands:
  pilot-cli daemon              Start daemon in background (auto-started on first use)
  pilot-cli get <url>           Navigate and return content + interactive elements
  pilot-cli navigate <url>      Navigate to URL
  pilot-cli snapshot            Get accessibility snapshot (inline)
  pilot-cli snapshot --file     Snapshot to temp file, print path
  pilot-cli click <ref>         Click @eN ref or CSS selector
  pilot-cli fill <ref> <value>  Fill input
  pilot-cli type <ref> <value>  Type text character by character
  pilot-cli press <key>         Press keyboard key (Enter, Tab, Escape, etc.)
  pilot-cli scroll [down|up] [px]
  pilot-cli url                 Print current URL
  pilot-cli title               Print current page title
  pilot-cli back                Go back
  pilot-cli forward             Go forward
  pilot-cli stop                Stop daemon`);
    return;
  }

  if (subcmd === 'daemon') {
    if (isDaemonRunning()) {
      console.log('Daemon already running');
      return;
    }
    await ensureDaemon();
    console.log('Daemon started');
    return;
  }

  if (subcmd === 'stop') {
    if (!isDaemonRunning()) { console.log('Daemon not running'); return; }
    const out = await sendCommand('stop', {});
    console.log(out);
    return;
  }

  // Auto-start daemon if needed
  await ensureDaemon();

  switch (subcmd) {
    case 'get':
      console.log(await sendCommand('get', { url: argv[1] }));
      break;

    case 'navigate':
      console.log(await sendCommand('navigate', { url: argv[1] }));
      break;

    case 'snapshot': {
      const toFile = argv.includes('--file');
      const maxEl  = argv.includes('--max') ? parseInt(argv[argv.indexOf('--max') + 1], 10) : undefined;
      const interactiveOnly = argv.includes('--interactive');
      console.log(await sendCommand('snapshot', { output_file: toFile, max_elements: maxEl, interactive_only: interactiveOnly }));
      break;
    }

    case 'click':
      console.log(await sendCommand('click', { ref: argv[1] }));
      break;

    case 'fill':
      console.log(await sendCommand('fill', { ref: argv[1], value: argv[2] }));
      break;

    case 'type':
      console.log(await sendCommand('type', { ref: argv[1], value: argv[2] }));
      break;

    case 'press':
      console.log(await sendCommand('press', { key: argv[1], ref: argv[2] }));
      break;

    case 'scroll': {
      const dir = argv[1] ?? 'down';
      const px  = argv[2] ? parseInt(argv[2], 10) : 500;
      console.log(await sendCommand('scroll', { direction: dir, amount: px }));
      break;
    }

    case 'url':
      console.log(await sendCommand('url', {}));
      break;

    case 'title':
      console.log(await sendCommand('title', {}));
      break;

    case 'back':
      console.log(await sendCommand('back', {}));
      break;

    case 'forward':
      console.log(await sendCommand('forward', {}));
      break;

    case 'ping': {
      const out = await sendCommand('ping', {});
      console.log(out);
      break;
    }

    default:
      console.error(`Unknown command: ${subcmd}. Run pilot-cli help.`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
