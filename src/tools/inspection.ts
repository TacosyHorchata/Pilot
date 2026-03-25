import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { consoleBuffer, networkBuffer, dialogBuffer } from '../buffers.js';
import { wrapError } from '../errors.js';

function hasAwait(code: string): boolean {
  const stripped = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return /\bawait\b/.test(stripped);
}

function needsBlockWrapper(code: string): boolean {
  const trimmed = code.trim();
  if (trimmed.split('\n').length > 1) return true;
  if (/\b(const|let|var|function|class|return|throw|if|for|while|switch|try)\b/.test(trimmed)) return true;
  if (trimmed.includes(';')) return true;
  return false;
}

function wrapForEvaluate(code: string): string {
  if (!hasAwait(code)) return code;
  const trimmed = code.trim();
  return needsBlockWrapper(trimmed)
    ? `(async()=>{\n${code}\n})()`
    : `(async()=>(${trimmed}))()`;
}

export function registerInspectionTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_console',
    'Get console messages from the circular buffer.',
    {
      level: z.enum(['error', 'warning', 'info', 'all']).optional().describe('Filter by log level'),
      clear: z.boolean().optional().describe('Clear the buffer after reading'),
    },
    async ({ level, clear }) => {
      await bm.ensureBrowser();
      let entries = consoleBuffer.toArray();
      if (level && level !== 'all') {
        if (level === 'error') {
          entries = entries.filter(e => e.level === 'error' || e.level === 'warning');
        } else {
          entries = entries.filter(e => e.level === level);
        }
      }
      if (clear) consoleBuffer.clear();
      if (entries.length === 0) return { content: [{ type: 'text' as const, text: '(no console messages)' }] };
      const text = entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
      ).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'pilot_network',
    'Get network requests from the circular buffer.',
    { clear: z.boolean().optional().describe('Clear the buffer after reading') },
    async ({ clear }) => {
      await bm.ensureBrowser();
      if (clear) { networkBuffer.clear(); return { content: [{ type: 'text' as const, text: 'Network buffer cleared.' }] }; }
      if (networkBuffer.length === 0) return { content: [{ type: 'text' as const, text: '(no network requests)' }] };
      const text = networkBuffer.toArray().map(e =>
        `${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
      ).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'pilot_dialog',
    'Get captured dialog (alert/confirm/prompt) messages.',
    { clear: z.boolean().optional().describe('Clear the buffer after reading') },
    async ({ clear }) => {
      await bm.ensureBrowser();
      if (clear) { dialogBuffer.clear(); return { content: [{ type: 'text' as const, text: 'Dialog buffer cleared.' }] }; }
      if (dialogBuffer.length === 0) return { content: [{ type: 'text' as const, text: '(no dialogs captured)' }] };
      const text = dialogBuffer.toArray().map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.type}] "${e.message}" → ${e.action}${e.response ? ` "${e.response}"` : ''}`
      ).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'pilot_evaluate',
    'Run a JavaScript expression on the page and return the result. Supports await.',
    { expression: z.string().describe('JavaScript expression to evaluate') },
    async ({ expression }) => {
      await bm.ensureBrowser();
      try {
        const wrapped = wrapForEvaluate(expression);
        const result = await bm.getPage().evaluate(wrapped);
        const text = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? '');
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_cookies',
    'Get all cookies as JSON.',
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const cookies = await bm.getPage().context().cookies();
        return { content: [{ type: 'text' as const, text: JSON.stringify(cookies, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_storage',
    'Get localStorage + sessionStorage as JSON (sensitive values redacted). Optionally set a localStorage key.',
    {
      set_key: z.string().optional().describe('Key to set in localStorage'),
      set_value: z.string().optional().describe('Value to set'),
    },
    async ({ set_key, set_value }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        if (set_key) {
          await page.evaluate(([k, v]) => localStorage.setItem(k, v), [set_key, set_value || '']);
          return { content: [{ type: 'text' as const, text: `Set localStorage["${set_key}"]` }] };
        }
        const storage = await page.evaluate(() => ({
          localStorage: { ...localStorage },
          sessionStorage: { ...sessionStorage },
        }));
        // Redact sensitive values
        const SENSITIVE_KEY = /(^|[_.-])(token|secret|key|password|credential|auth|jwt|session|csrf)($|[_.-])|api.?key/i;
        const SENSITIVE_VALUE = /^(eyJ|sk-|sk_live_|pk_live_|ghp_|gho_|github_pat_|xox[bpsa]-|AKIA|AIza|SG\.|Bearer\s|sbp_)/;
        const redacted = JSON.parse(JSON.stringify(storage));
        for (const storeType of ['localStorage', 'sessionStorage'] as const) {
          const store = redacted[storeType];
          if (!store) continue;
          for (const [key, value] of Object.entries(store)) {
            if (typeof value !== 'string') continue;
            if (SENSITIVE_KEY.test(key) || SENSITIVE_VALUE.test(value)) {
              store[key] = `[REDACTED — ${value.length} chars]`;
            }
          }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(redacted, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_perf',
    'Get page load performance timings (DNS, TCP, TTFB, DOM parse, load).',
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const timings = await bm.getPage().evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
          if (!nav) return 'No navigation timing data available.';
          return {
            dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
            tcp: Math.round(nav.connectEnd - nav.connectStart),
            ssl: Math.round(nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0),
            ttfb: Math.round(nav.responseStart - nav.requestStart),
            download: Math.round(nav.responseEnd - nav.responseStart),
            domParse: Math.round(nav.domInteractive - nav.responseEnd),
            domReady: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
            load: Math.round(nav.loadEventEnd - nav.startTime),
          };
        });
        if (typeof timings === 'string') return { content: [{ type: 'text' as const, text: timings }] };
        const text = Object.entries(timings).map(([k, v]) => `${k.padEnd(12)} ${v}ms`).join('\n');
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
