import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { wrapError } from '../errors.js';

export function registerTabTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_tabs',
    'List all open browser tabs with URLs, titles, and active status.',
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const tabs = await bm.getTabListWithTitles();
        const text = tabs.map(t =>
          `${t.active ? '→ ' : '  '}[${t.id}] ${t.title || '(untitled)'} — ${t.url}`
        ).join('\n');
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_tab_new',
    'Open a new browser tab, optionally navigating to a URL.',
    { url: z.string().optional().describe('URL to navigate to in the new tab') },
    async ({ url }) => {
      await bm.ensureBrowser();
      try {
        const id = await bm.newTab(url);
        return { content: [{ type: 'text' as const, text: `Opened tab ${id}${url ? ` → ${url}` : ''}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_tab_close',
    'Close a browser tab by ID (or current tab if none specified).',
    { id: z.number().optional().describe('Tab ID to close') },
    async ({ id }) => {
      await bm.ensureBrowser();
      try {
        await bm.closeTab(id);
        return { content: [{ type: 'text' as const, text: `Closed tab${id ? ` ${id}` : ''}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_tab_select',
    'Switch to a specific browser tab by ID.',
    { id: z.number().describe('Tab ID to switch to') },
    async ({ id }) => {
      await bm.ensureBrowser();
      try {
        bm.switchTab(id);
        return { content: [{ type: 'text' as const, text: `Switched to tab ${id}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
