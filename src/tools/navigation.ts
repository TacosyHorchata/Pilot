import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { wrapError } from '../errors.js';
import { validateNavigationUrl } from '../url-validation.js';

export function registerNavigationTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_navigate',
    'Navigate to a URL. Returns HTTP status code and final URL.',
    { url: z.string().describe('URL to navigate to') },
    async ({ url }) => {
      await bm.ensureBrowser();
      try {
        await validateNavigationUrl(url);
        const page = bm.getPage();
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const status = response?.status() || 'unknown';
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Navigated to ${url} (${status})` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_back',
    'Go back in browser history.',
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Back → ${page.url()}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_forward',
    'Go forward in browser history.',
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Forward → ${page.url()}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_reload',
    'Reload the current page.',
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Reloaded ${page.url()}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
