import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserManager } from '../browser-manager.js';
import { takeSnapshot, diffSnapshot, annotateScreenshot } from '../snapshot.js';
import { wrapError } from '../errors.js';
import * as fs from 'fs';

export function registerSnapshotTools(server: McpServer, bm: BrowserManager) {
  server.tool(
    'pilot_snapshot',
    'Get accessibility tree snapshot with @eN refs for element selection. Use refs in click/fill/hover/etc. Use include_cursor_interactive to find non-ARIA clickable elements (@cN refs).',
    {
      selector: z.string().optional().describe('CSS selector to scope the snapshot'),
      interactive_only: z.boolean().optional().describe('Only show interactive elements (buttons, links, inputs)'),
      compact: z.boolean().optional().describe('Remove empty structural nodes'),
      depth: z.number().optional().describe('Limit tree depth (0 = root only)'),
      include_cursor_interactive: z.boolean().optional().describe('Scan for cursor:pointer/onclick/tabindex elements not in ARIA tree'),
    },
    async ({ selector, interactive_only, compact, depth, include_cursor_interactive }) => {
      await bm.ensureBrowser();
      try {
        const result = await takeSnapshot(bm, {
          selector,
          interactive: interactive_only,
          compact,
          depth,
          cursorInteractive: include_cursor_interactive,
        });
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_snapshot_diff',
    'Compare current page state against the last snapshot. Returns unified diff showing what changed. First call stores baseline.',
    {
      selector: z.string().optional().describe('CSS selector to scope the snapshot'),
      interactive_only: z.boolean().optional().describe('Only show interactive elements'),
    },
    async ({ selector, interactive_only }) => {
      await bm.ensureBrowser();
      try {
        const result = await diffSnapshot(bm, {
          selector,
          interactive: interactive_only,
        });
        bm.resetFailures();
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );

  server.tool(
    'pilot_annotated_screenshot',
    'Take a screenshot with red overlay boxes and ref labels at each @eN/@cN position. Requires a prior pilot_snapshot call.',
    {
      output_path: z.string().optional().describe('Output file path for the screenshot'),
    },
    async ({ output_path }) => {
      await bm.ensureBrowser();
      try {
        const screenshotPath = await annotateScreenshot(bm, output_path);
        bm.resetFailures();

        // Read the image and return as base64
        const imageData = fs.readFileSync(screenshotPath);
        const base64 = imageData.toString('base64');

        return {
          content: [
            { type: 'text' as const, text: `Annotated screenshot saved: ${screenshotPath}` },
            { type: 'image' as const, data: base64, mimeType: 'image/png' },
          ],
        };
      } catch (err) {
        bm.incrementFailures();
        return { content: [{ type: 'text' as const, text: wrapError(err) }], isError: true };
      }
    }
  );
}
