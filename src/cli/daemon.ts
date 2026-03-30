#!/usr/bin/env node
/**
 * Pilot CLI Daemon — persistent Chromium over Unix socket
 *
 * File-first design: all snapshot/content output goes to a temp file.
 * Commands return a short header + file path — the LLM reads the file only when needed.
 * This mirrors how @playwright/cli works: paths accumulate in context, not 50K snapshots.
 *
 * Listens on /tmp/pilot-daemon.sock for JSON commands from the CLI client.
 * Each command: { cmd: string, args: Record<string, any> }
 * Each response: { ok: boolean, output: string }
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { BrowserManager } from '../browser-manager.js';
import { takeSnapshot, pageContentPreview } from '../snapshot.js';
import { validateNavigationUrl } from '../url-validation.js';
import { wrapError } from '../errors.js';

export const SOCKET_PATH = path.join(os.tmpdir(), 'pilot-daemon.sock');
export const PID_PATH    = path.join(os.tmpdir(), 'pilot-daemon.pid');

const bm = new BrowserManager();

function writeToFile(content: string): string {
  const p = path.join(os.tmpdir(), `pilot-${crypto.randomBytes(6).toString('hex')}.txt`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

async function handleCommand(cmd: string, args: Record<string, any>): Promise<string> {
  await bm.ensureBrowser();

  switch (cmd) {
    case 'get': {
      // Navigate + full content to file. Returns short inline summary + path.
      await validateNavigationUrl(args.url);
      const page = bm.getPage();
      await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      bm.resetFailures();
      const [preview, interactive] = await Promise.all([
        pageContentPreview(page),
        takeSnapshot(bm, { lean: true, maxElements: 50, interactive: true }),
      ]);
      const full = `${page.url()}\n\n--- content ---\n${preview}\n\n--- interactive ---\n${interactive}`;
      const filePath = writeToFile(full);
      // Inline: title + first 400 chars of content (enough to answer simple read tasks without reading the file)
      const title = await page.title().catch(() => '');
      const snippet = preview.slice(0, 400);
      return `${page.url()} — ${title}\n${snippet}${preview.length > 400 ? '\n[truncated — full content in ' + filePath + ']' : ''}`;
    }

    case 'navigate': {
      await validateNavigationUrl(args.url);
      const page = bm.getPage();
      const res = await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      bm.resetFailures();
      const status = res?.status() ?? 'unknown';
      const [preview, interactive] = await Promise.all([
        pageContentPreview(page),
        takeSnapshot(bm, { lean: true, maxElements: 30, interactive: true }),
      ]);
      const full = `${page.url()}\n\n--- content ---\n${preview}\n\n--- interactive ---\n${interactive}`;
      const filePath = writeToFile(full);
      return `Navigated to ${page.url()} (${status})\nSnapshot → ${filePath}`;
    }

    case 'snapshot': {
      const result = await takeSnapshot(bm, {
        lean: true,
        maxElements: args.max_elements ?? 50,
        interactive: args.interactive_only ?? false,
      });
      const filePath = writeToFile(result);
      // Always file-based: the LLM reads with Read tool when it needs element refs
      return filePath;
    }

    case 'click': {
      const page = bm.getPage();
      const ref = args.ref as string;
      const resolved = await bm.resolveRef(ref);
      if ('locator' in resolved) {
        await resolved.locator.click({ timeout: 10000 });
      } else {
        await page.click(resolved.selector, { timeout: 10000 });
      }
      bm.resetFailures();
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      // Post-click: interactive snapshot to file
      const snap = await takeSnapshot(bm, { lean: true, maxElements: 30, interactive: true });
      const filePath = writeToFile(snap);
      return `Clicked ${args.ref} — snapshot → ${filePath}`;
    }

    case 'fill': {
      const ref = args.ref as string;
      const resolved = await bm.resolveRef(ref);
      const locator = 'locator' in resolved ? resolved.locator : bm.getPage().locator(resolved.selector);
      await locator.fill(args.value ?? '', { timeout: 10000 });
      bm.resetFailures();
      return `Filled ${args.ref} with "${args.value}"`;
    }

    case 'type': {
      const ref = args.ref as string;
      const resolved = await bm.resolveRef(ref);
      const locator = 'locator' in resolved ? resolved.locator : bm.getPage().locator(resolved.selector);
      await locator.pressSequentially(args.value ?? '', { delay: 30 });
      bm.resetFailures();
      return `Typed "${args.value}" into ${args.ref}`;
    }

    case 'press': {
      const page = bm.getPage();
      if (args.ref) {
        const resolved = await bm.resolveRef(args.ref);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
        await locator.press(args.key, { timeout: 10000 });
      } else {
        await page.keyboard.press(args.key);
      }
      bm.resetFailures();
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      return `Pressed ${args.key}`;
    }

    case 'scroll': {
      const page = bm.getPage();
      const dir = args.direction ?? 'down';
      const amount = args.amount ?? 500;
      await page.evaluate(({ dir, amount }) => {
        window.scrollBy(0, dir === 'down' ? amount : -amount);
      }, { dir, amount });
      bm.resetFailures();
      return `Scrolled ${dir} ${amount}px`;
    }

    case 'url':   return bm.getPage().url();
    case 'title': return await bm.getPage().title();

    case 'back': {
      const page = bm.getPage();
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
      bm.resetFailures();
      return `Back → ${page.url()}`;
    }

    case 'forward': {
      const page = bm.getPage();
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 });
      bm.resetFailures();
      return `Forward → ${page.url()}`;
    }

    case 'ping':  return 'pong';

    case 'stop': {
      await bm.close();
      setTimeout(() => process.exit(0), 100);
      return 'Daemon stopping';
    }

    default:
      return `Unknown command: ${cmd}`;
  }
}

async function startDaemon() {
  if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);

  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: { cmd: string; args: Record<string, any> };
        try { msg = JSON.parse(line); } catch {
          socket.write(JSON.stringify({ ok: false, output: 'Invalid JSON' }) + '\n');
          continue;
        }
        handleCommand(msg.cmd, msg.args ?? {})
          .then(output => socket.write(JSON.stringify({ ok: true, output }) + '\n'))
          .catch(err  => socket.write(JSON.stringify({ ok: false, output: wrapError(err) }) + '\n'));
      }
    });
  });

  server.listen(SOCKET_PATH, () => {
    fs.writeFileSync(PID_PATH, String(process.pid));
    console.error(`[pilot-daemon] Listening on ${SOCKET_PATH} (pid ${process.pid})`);
  });

  process.on('SIGTERM', async () => { await bm.close(); process.exit(0); });
  process.on('SIGINT',  async () => { await bm.close(); process.exit(0); });
}

startDaemon().catch(err => {
  console.error('[pilot-daemon] Fatal:', err.message);
  process.exit(1);
});
