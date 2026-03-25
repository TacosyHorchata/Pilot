import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { wrapError } from '../errors.js';
import {
  findInstalledBrowsers,
  importCookies,
  listSupportedBrowserNames,
  listProfiles,
  listDomains,
} from '../cookie-import.js';
import * as fs from 'fs';

export function registerSettingsTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_resize',
    'Set the browser viewport size.',
    {
      width: z.number().describe('Viewport width in pixels'),
      height: z.number().describe('Viewport height in pixels'),
    },
    async ({ width, height }) => {
      await bm.ensureBrowser();
      try {
        await bm.setViewport(width, height);
        return { content: [{ type: 'text' as const, text: `Viewport set to ${width}x${height}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_set_cookie',
    'Set a cookie on the current page domain.',
    {
      name: z.string().describe('Cookie name'),
      value: z.string().describe('Cookie value'),
    },
    async ({ name, value }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        const url = new URL(page.url());
        await page.context().addCookies([{
          name,
          value,
          domain: url.hostname,
          path: '/',
        }]);
        return { content: [{ type: 'text' as const, text: `Cookie set: ${name}=****` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_import_cookies',
    'Import cookies from a real Chromium browser (Chrome, Arc, Brave, Edge, Comet). Decrypts from browser cookie database and adds to the headless browser session.',
    {
      browser: z.string().optional().describe('Browser name (chrome, arc, brave, edge, comet). Auto-detects if omitted.'),
      domains: z.array(z.string()).describe('Cookie domains to import (e.g. [".github.com", ".google.com"])'),
      profile: z.string().optional().describe('Browser profile name (default: "Default")'),
      list_browsers: z.boolean().optional().describe('List installed browsers instead of importing'),
      list_profiles: z.boolean().optional().describe('List available profiles for the specified browser'),
      list_domains: z.boolean().optional().describe('List cookie domains available in the browser'),
    },
    async ({ browser, domains, profile, list_browsers, list_profiles, list_domains: listDom }) => {
      try {
        if (list_browsers) {
          const installed = findInstalledBrowsers();
          if (installed.length === 0) {
            return { content: [{ type: 'text' as const, text: `No Chromium browsers found. Supported: ${listSupportedBrowserNames().join(', ')}` }] };
          }
          return { content: [{ type: 'text' as const, text: `Installed browsers:\n${installed.map(b => `  - ${b.name}`).join('\n')}` }] };
        }

        if (list_profiles && browser) {
          const profiles = listProfiles(browser);
          if (profiles.length === 0) {
            return { content: [{ type: 'text' as const, text: `No profiles found for ${browser}` }] };
          }
          return { content: [{ type: 'text' as const, text: `Profiles for ${browser}:\n${profiles.map(p => `  - ${p.name} (${p.displayName})`).join('\n')}` }] };
        }

        if (listDom && browser) {
          const result = listDomains(browser, profile || 'Default');
          const top = result.domains.slice(0, 50);
          return { content: [{ type: 'text' as const, text: `Cookie domains in ${result.browser} (top ${top.length}):\n${top.map(d => `  ${d.domain} (${d.count} cookies)`).join('\n')}` }] };
        }

        // Import mode
        await bm.ensureBrowser();
        const browserName = browser || 'chrome';
        const result = await importCookies(browserName, domains, profile || 'Default');

        if (result.cookies.length > 0) {
          await bm.getContext().addCookies(result.cookies as any);
        }

        const msg = [`Imported ${result.count} cookies from ${browserName}`];
        if (result.failed > 0) msg.push(`(${result.failed} failed to decrypt)`);
        if (Object.keys(result.domainCounts).length > 0) {
          msg.push('\nPer domain:');
          for (const [domain, count] of Object.entries(result.domainCounts)) {
            msg.push(`  ${domain}: ${count}`);
          }
        }
        return { content: [{ type: 'text' as const, text: msg.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_set_header',
    'Set a custom request header. Sensitive values are auto-redacted in the response.',
    {
      name: z.string().describe('Header name'),
      value: z.string().describe('Header value'),
    },
    async ({ name, value }) => {
      await bm.ensureBrowser();
      try {
        await bm.setExtraHeader(name, value);
        const sensitiveHeaders = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'];
        const redactedValue = sensitiveHeaders.includes(name.toLowerCase()) ? '****' : value;
        return { content: [{ type: 'text' as const, text: `Header set: ${name}: ${redactedValue}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_set_useragent',
    'Set the browser user agent string. Recreates the browser context, preserving cookies and state.',
    { useragent: z.string().describe('User agent string') },
    async ({ useragent }) => {
      await bm.ensureBrowser();
      try {
        bm.setUserAgent(useragent);
        const error = await bm.recreateContext();
        if (error) {
          return { content: [{ type: 'text' as const, text: `User agent set to "${useragent}" but: ${error}` }] };
        }
        return { content: [{ type: 'text' as const, text: `User agent set: ${useragent}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_handle_dialog',
    'Configure how dialogs (alert/confirm/prompt) are handled.',
    {
      accept: z.boolean().describe('true to auto-accept, false to auto-dismiss'),
      prompt_text: z.string().optional().describe('Text to provide for prompt dialogs'),
    },
    async ({ accept, prompt_text }) => {
      await bm.ensureBrowser();
      bm.setDialogAutoAccept(accept);
      bm.setDialogPromptText(prompt_text || null);
      const msg = accept
        ? (prompt_text ? `Dialogs will be accepted with text: "${prompt_text}"` : 'Dialogs will be accepted')
        : 'Dialogs will be dismissed';
      return { content: [{ type: 'text' as const, text: msg }] };
    }
  );

  server.tool(
    'pilot_handoff',
    'Open a visible (headed) Chrome window with all current state — cookies, tabs, localStorage. Use when headless mode is blocked by CAPTCHAs, bot detection, or complex auth. The user can solve it manually, then call pilot_resume to continue.',
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const result = await bm.handoff();
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_resume',
    'Resume control after user handoff. Takes a fresh snapshot of the current page state.',
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        await bm.resume();
        const { takeSnapshot } = await import('../snapshot.js');
        const snapshot = await takeSnapshot(bm, { interactive: true });
        return { content: [{ type: 'text' as const, text: `RESUMED\n${snapshot}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_close',
    'Close the browser and clean up all resources.',
    {},
    async () => {
      try {
        await bm.close();
        return { content: [{ type: 'text' as const, text: 'Browser closed.' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
