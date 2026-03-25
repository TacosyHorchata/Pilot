import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { wrapError } from '../errors.js';

async function getCleanText(page: import('playwright').Page): Promise<string> {
  return await page.evaluate(() => {
    const body = document.body;
    if (!body) return '';
    const clone = body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
    return clone.innerText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');
  });
}

export function registerPageTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_page_text',
    'Extract clean text from the page (strips script/style/noscript/svg).',
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const text = await getCleanText(bm.getPage());
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_page_html',
    'Get innerHTML of a selector/ref, or full page HTML if none provided.',
    { ref: z.string().optional().describe('Element ref or CSS selector') },
    async ({ ref }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        if (ref) {
          const resolved = await bm.resolveRef(ref);
          if ('locator' in resolved) {
            const html = await resolved.locator.innerHTML({ timeout: 5000 });
            return { content: [{ type: 'text' as const, text: html }] };
          }
          const html = await page.innerHTML(resolved.selector);
          return { content: [{ type: 'text' as const, text: html }] };
        }
        const html = await page.content();
        return { content: [{ type: 'text' as const, text: html }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_page_links',
    'Get all links on the page as text + href pairs.',
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const links = await bm.getPage().evaluate(() =>
          [...document.querySelectorAll('a[href]')].map(a => ({
            text: a.textContent?.trim().slice(0, 120) || '',
            href: (a as HTMLAnchorElement).href,
          })).filter(l => l.text && l.href)
        );
        const result = links.map(l => `${l.text} → ${l.href}`).join('\n');
        return { content: [{ type: 'text' as const, text: result || '(no links found)' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_page_forms',
    'Get all form fields on the page as structured JSON.',
    {},
    async () => {
      await bm.ensureBrowser();
      try {
        const forms = await bm.getPage().evaluate(() => {
          return [...document.querySelectorAll('form')].map((form, i) => {
            const fields = [...form.querySelectorAll('input, select, textarea')].map(el => {
              const input = el as HTMLInputElement;
              return {
                tag: el.tagName.toLowerCase(),
                type: input.type || undefined,
                name: input.name || undefined,
                id: input.id || undefined,
                placeholder: input.placeholder || undefined,
                required: input.required || undefined,
                value: input.type === 'password' ? '[redacted]' : (input.value || undefined),
              };
            });
            return { index: i, action: form.action || undefined, method: form.method || 'get', id: form.id || undefined, fields };
          });
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(forms, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_page_attrs',
    'Get all attributes of an element as JSON.',
    { ref: z.string().describe('Element ref or CSS selector') },
    async ({ ref }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        const resolved = await bm.resolveRef(ref);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
        const attrs = await locator.evaluate((el) => {
          const result: Record<string, string> = {};
          for (const attr of el.attributes) {
            result[attr.name] = attr.value;
          }
          return result;
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(attrs, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_page_css',
    'Get computed CSS property value for an element.',
    {
      ref: z.string().describe('Element ref or CSS selector'),
      property: z.string().describe('CSS property name (e.g. color, font-size)'),
    },
    async ({ ref, property }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        const resolved = await bm.resolveRef(ref);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
        const value = await locator.evaluate(
          (el, prop) => getComputedStyle(el).getPropertyValue(prop),
          property
        );
        return { content: [{ type: 'text' as const, text: value }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_element_state',
    'Check element state: visible, hidden, enabled, disabled, checked, editable, focused.',
    {
      ref: z.string().describe('Element ref or CSS selector'),
      property: z.enum(['visible', 'hidden', 'enabled', 'disabled', 'checked', 'editable', 'focused']).describe('State to check'),
    },
    async ({ ref, property }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        const resolved = await bm.resolveRef(ref);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);

        let result: boolean;
        switch (property) {
          case 'visible':  result = await locator.isVisible(); break;
          case 'hidden':   result = await locator.isHidden(); break;
          case 'enabled':  result = await locator.isEnabled(); break;
          case 'disabled': result = await locator.isDisabled(); break;
          case 'checked':  result = await locator.isChecked(); break;
          case 'editable': result = await locator.isEditable(); break;
          case 'focused':  result = await locator.evaluate((el) => el === document.activeElement); break;
        }
        return { content: [{ type: 'text' as const, text: String(result) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
