import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserManager } from '../browser-manager.js';
import { registerNavigationTools } from './navigation.js';
import { registerSnapshotTools } from './snapshot-tools.js';
import { registerInteractionTools } from './interaction.js';
import { registerPageTools } from './page.js';
import { registerInspectionTools } from './inspection.js';
import { registerVisualTools } from './visual.js';
import { registerTabTools } from './tabs.js';
import { registerSettingsTools } from './settings.js';

export function registerAllTools(server: McpServer, bm: BrowserManager): void {
  registerNavigationTools(server, bm);
  registerSnapshotTools(server, bm);
  registerInteractionTools(server, bm);
  registerPageTools(server, bm);
  registerInspectionTools(server, bm);
  registerVisualTools(server, bm);
  registerTabTools(server, bm);
  registerSettingsTools(server, bm);
}
