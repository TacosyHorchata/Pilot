import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { wrapError } from '../errors.js';
import * as fs from 'fs';

export function registerInteractionTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_click',
    'Click an element by @ref (from snapshot) or CSS selector. Auto-routes <option> clicks to selectOption.',
    {
      ref: z.string().describe('Element ref (@e3) or CSS selector'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button'),
      double_click: z.boolean().optional().describe('Double-click instead of single click'),
    },
    async ({ ref, button, double_click }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();

        // Auto-route: if ref points to a <option>, use selectOption
        const role = bm.getRefRole(ref);
        if (role === 'option') {
          const resolved = await bm.resolveRef(ref);
          if ('locator' in resolved) {
            const optionInfo = await resolved.locator.evaluate(el => {
              if (el.tagName !== 'OPTION') return null;
              const option = el as HTMLOptionElement;
              const select = option.closest('select');
              if (!select) return null;
              return { value: option.value, text: option.text };
            });
            if (optionInfo) {
              await resolved.locator.locator('xpath=ancestor::select').selectOption(optionInfo.value, { timeout: 5000 });
              bm.resetFailures();
              return { content: [{ type: 'text' as const, text: `Selected "${optionInfo.text}" (auto-routed from click on <option>) → now at ${page.url()}` }] };
            }
          }
        }

        const resolved = await bm.resolveRef(ref);
        const clickOptions: any = { timeout: 5000 };
        if (button) clickOptions.button = button;
        if (double_click) clickOptions.clickCount = 2;

        if ('locator' in resolved) {
          await resolved.locator.click(clickOptions);
        } else {
          await page.click(resolved.selector, clickOptions);
        }
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Clicked ${ref} → now at ${page.url()}` }] };
      } catch (err) {
        bm.incrementFailures();
        const hint = bm.getFailureHint();
        let msg = wrapError(err);
        if (hint) msg += '\n' + hint;
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_hover',
    'Hover over an element by @ref or CSS selector.',
    { ref: z.string().describe('Element ref (@e3) or CSS selector') },
    async ({ ref }) => {
      await bm.ensureBrowser();
      try {
        const resolved = await bm.resolveRef(ref);
        if ('locator' in resolved) {
          await resolved.locator.hover({ timeout: 5000 });
        } else {
          await bm.getPage().hover(resolved.selector, { timeout: 5000 });
        }
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Hovered ${ref}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_fill',
    'Clear and fill an input/textarea by @ref or CSS selector.',
    {
      ref: z.string().describe('Element ref (@e3) or CSS selector'),
      value: z.string().describe('Value to fill'),
    },
    async ({ ref, value }) => {
      await bm.ensureBrowser();
      try {
        const resolved = await bm.resolveRef(ref);
        if ('locator' in resolved) {
          await resolved.locator.fill(value, { timeout: 5000 });
        } else {
          await bm.getPage().fill(resolved.selector, value, { timeout: 5000 });
        }
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Filled ${ref}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_select_option',
    'Select a dropdown option by value, label, or visible text.',
    {
      ref: z.string().describe('Select element ref (@e3) or CSS selector'),
      value: z.string().describe('Option value, label, or text to select'),
    },
    async ({ ref, value }) => {
      await bm.ensureBrowser();
      try {
        const resolved = await bm.resolveRef(ref);
        if ('locator' in resolved) {
          await resolved.locator.selectOption(value, { timeout: 5000 });
        } else {
          await bm.getPage().selectOption(resolved.selector, value, { timeout: 5000 });
        }
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Selected "${value}" in ${ref}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_type',
    'Type text into the currently focused element (character by character).',
    {
      text: z.string().describe('Text to type'),
      submit: z.boolean().optional().describe('Press Enter after typing'),
    },
    async ({ text, submit }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        await page.keyboard.type(text);
        if (submit) await page.keyboard.press('Enter');
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Typed ${text.length} characters${submit ? ' + Enter' : ''}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_press_key',
    'Press a keyboard key (Enter, Tab, Escape, ArrowDown, Backspace, etc.).',
    { key: z.string().describe('Key name (e.g. Enter, Tab, Escape, ArrowDown, Shift+Enter)') },
    async ({ key }) => {
      await bm.ensureBrowser();
      try {
        await bm.getPage().keyboard.press(key);
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Pressed ${key}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_drag',
    'Drag from one element to another.',
    {
      start_ref: z.string().describe('Source element ref or CSS selector'),
      end_ref: z.string().describe('Target element ref or CSS selector'),
    },
    async ({ start_ref, end_ref }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        const startResolved = await bm.resolveRef(start_ref);
        const endResolved = await bm.resolveRef(end_ref);

        const startLocator = 'locator' in startResolved ? startResolved.locator : page.locator(startResolved.selector);
        const endLocator = 'locator' in endResolved ? endResolved.locator : page.locator(endResolved.selector);

        await startLocator.dragTo(endLocator, { timeout: 5000 });
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Dragged ${start_ref} → ${end_ref}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_scroll',
    'Scroll element into view, or scroll to page bottom if no ref provided.',
    {
      ref: z.string().optional().describe('Element ref or CSS selector to scroll into view'),
      direction: z.enum(['up', 'down', 'top', 'bottom']).optional().describe('Scroll direction (when no ref)'),
    },
    async ({ ref, direction }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        if (ref) {
          const resolved = await bm.resolveRef(ref);
          if ('locator' in resolved) {
            await resolved.locator.scrollIntoViewIfNeeded({ timeout: 5000 });
          } else {
            await page.locator(resolved.selector).scrollIntoViewIfNeeded({ timeout: 5000 });
          }
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `Scrolled ${ref} into view` }] };
        }
        const scrollMap: Record<string, string> = {
          up: 'window.scrollBy(0, -window.innerHeight)',
          down: 'window.scrollBy(0, window.innerHeight)',
          top: 'window.scrollTo(0, 0)',
          bottom: 'window.scrollTo(0, document.body.scrollHeight)',
        };
        await page.evaluate(scrollMap[direction || 'bottom']);
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Scrolled ${direction || 'bottom'}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_wait',
    'Wait for element visibility, network idle, or page load.',
    {
      ref: z.string().optional().describe('Element ref or CSS selector to wait for'),
      state: z.enum(['visible', 'hidden', 'networkidle', 'load']).optional().describe('What to wait for'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default: 15000)'),
    },
    async ({ ref, state, timeout }) => {
      await bm.ensureBrowser();
      try {
        const page = bm.getPage();
        const ms = timeout || 15000;

        if (state === 'networkidle') {
          await page.waitForLoadState('networkidle', { timeout: ms });
          return { content: [{ type: 'text' as const, text: 'Network idle' }] };
        }
        if (state === 'load') {
          await page.waitForLoadState('load', { timeout: ms });
          return { content: [{ type: 'text' as const, text: 'Page loaded' }] };
        }
        if (ref) {
          const resolved = await bm.resolveRef(ref);
          if ('locator' in resolved) {
            await resolved.locator.waitFor({ state: (state || 'visible') as any, timeout: ms });
          } else {
            await page.waitForSelector(resolved.selector, { state: (state || 'visible') as any, timeout: ms });
          }
          bm.resetFailures();
          return { content: [{ type: 'text' as const, text: `Element ${ref} is ${state || 'visible'}` }] };
        }
        return { content: [{ type: 'text' as const, text: 'Nothing to wait for — provide ref or state' }], isError: true };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_file_upload',
    'Upload file(s) to a file input element.',
    {
      ref: z.string().describe('File input element ref or CSS selector'),
      paths: z.array(z.string()).describe('File paths to upload'),
    },
    async ({ ref, paths }) => {
      await bm.ensureBrowser();
      try {
        for (const fp of paths) {
          if (!fs.existsSync(fp)) throw new Error(`File not found: ${fp}`);
        }
        const page = bm.getPage();
        const resolved = await bm.resolveRef(ref);
        if ('locator' in resolved) {
          await resolved.locator.setInputFiles(paths);
        } else {
          await page.locator(resolved.selector).setInputFiles(paths);
        }
        const fileInfo = paths.map(fp => {
          const stat = fs.statSync(fp);
          return `${require('path').basename(fp)} (${stat.size}B)`;
        }).join(', ');
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: `Uploaded: ${fileInfo}` }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
