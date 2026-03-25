# pilot

> Browser automation for AI agents. 20x faster than the alternatives.

**pilot** is an MCP server that gives your AI agent a fast, persistent browser. Built on Playwright, it runs Chromium in-process over stdio — no HTTP server, no cold starts, no per-action overhead.

```
LLM Client → stdio (MCP) → pilot → Playwright → Chromium
                              in-process      persistent
First call: ~3s (launch)
Every call after: ~5-50ms
```

## Why pilot?

|  | pilot | @playwright/mcp | BrowserMCP |
|---|---|---|---|
| **Latency/action** | ~5-50ms | ~100-200ms | ~150-300ms |
| **Architecture** | In-process stdio | Separate process | Chrome extension |
| **Persistent browser** | Yes | Per-session | Yes |
| **Tools** | 48 | 25+ | ~20 |
| **Cookie import** | Chrome, Arc, Brave, Edge, Comet | No | No |
| **Snapshot diffing** | Track page changes between actions | No | No |
| **Handoff/Resume** | Open headed Chrome, interact manually, resume | No | No |
| **Annotated screenshots** | Ref labels overlaid on screenshot | No | No |

Speed matters when your agent makes hundreds of browser calls in a session. At 100 actions, that's **5 seconds** with pilot vs **20 seconds** with alternatives.

## Quick Start

```bash
npm install -g pilot
npx playwright install chromium
```

Add to your Claude Code config (`.mcp.json`):

```json
{
  "mcpServers": {
    "interact": {
      "command": "npx",
      "args": ["-y", "pilot"]
    }
  }
}
```

For Cursor, add the same config to your Cursor MCP settings.

That's it. Your AI agent now has a browser.

## How It Works

Snapshot once, interact by ref. No CSS selectors needed.

```
pilot_snapshot → @e1 [button] "Submit", @e2 [textbox] "Email", ...
pilot_fill    → { ref: "@e2", value: "user@example.com" }
pilot_click   → { ref: "@e1" }
```

The ref system gives LLMs a simple, reliable way to interact with pages. Stale refs are auto-detected with clear error messages.

## Tools (48)

### Navigation
| Tool | Description |
|------|-------------|
| `pilot_navigate` | Navigate to a URL |
| `pilot_back` | Go back in browser history |
| `pilot_forward` | Go forward in browser history |
| `pilot_reload` | Reload the current page |

### Snapshots
| Tool | Description |
|------|-------------|
| `pilot_snapshot` | Accessibility tree with `@eN` refs for element selection. Use `include_cursor_interactive` for non-ARIA clickable elements (`@cN` refs). |
| `pilot_snapshot_diff` | Unified diff showing what changed since last snapshot |
| `pilot_annotated_screenshot` | Screenshot with red overlay boxes at each `@ref` position |

### Interaction
| Tool | Description |
|------|-------------|
| `pilot_click` | Click by `@ref` or CSS selector (auto-routes `<option>` to selectOption) |
| `pilot_hover` | Hover over an element |
| `pilot_fill` | Clear and fill an input/textarea |
| `pilot_select_option` | Select a dropdown option by value, label, or text |
| `pilot_type` | Type text character by character |
| `pilot_press_key` | Press keyboard keys (Enter, Tab, Escape, etc.) |
| `pilot_drag` | Drag from one element to another |
| `pilot_scroll` | Scroll element into view or scroll page |
| `pilot_wait` | Wait for element visibility, network idle, or page load |
| `pilot_file_upload` | Upload files to a file input |

### Page Inspection
| Tool | Description |
|------|-------------|
| `pilot_page_text` | Clean text extraction (strips script/style/svg) |
| `pilot_page_html` | Get innerHTML of element or full page |
| `pilot_page_links` | All links as text + href pairs |
| `pilot_page_forms` | All form fields as structured JSON |
| `pilot_page_attrs` | All attributes of an element |
| `pilot_page_css` | Computed CSS property value |
| `pilot_element_state` | Check visible/hidden/enabled/disabled/checked/focused |
| `pilot_page_diff` | Text diff between two URLs (staging vs production, etc.) |

### Debugging
| Tool | Description |
|------|-------------|
| `pilot_console` | Console messages from circular buffer |
| `pilot_network` | Network requests from circular buffer |
| `pilot_dialog` | Captured alert/confirm/prompt messages |
| `pilot_evaluate` | Run JavaScript on the page (supports `await`) |
| `pilot_cookies` | Get all cookies as JSON |
| `pilot_storage` | Get localStorage/sessionStorage (sensitive values auto-redacted) |
| `pilot_perf` | Page load performance timings (DNS, TTFB, DOM parse, load) |

### Visual
| Tool | Description |
|------|-------------|
| `pilot_screenshot` | Screenshot of page or specific element |
| `pilot_pdf` | Save page as PDF |
| `pilot_responsive` | Screenshots at mobile (375), tablet (768), and desktop (1280) |

### Tabs
| Tool | Description |
|------|-------------|
| `pilot_tabs` | List open tabs |
| `pilot_tab_new` | Open a new tab |
| `pilot_tab_close` | Close a tab |
| `pilot_tab_select` | Switch to a tab |

### Settings & Session
| Tool | Description |
|------|-------------|
| `pilot_resize` | Set viewport size |
| `pilot_set_cookie` | Set a cookie |
| `pilot_import_cookies` | Import cookies from Chrome, Arc, Brave, Edge, Comet |
| `pilot_set_header` | Set custom request headers (sensitive values auto-redacted) |
| `pilot_set_useragent` | Set user agent string |
| `pilot_handle_dialog` | Configure dialog auto-accept/dismiss |
| `pilot_handoff` | Open headed Chrome with full state for manual interaction |
| `pilot_resume` | Resume automation after manual handoff |
| `pilot_close` | Close browser and clean up |

## Key Features

### Cookie Import

Import cookies from your real browser into the headless session. Decrypts from the browser's SQLite cookie database using platform-specific safe storage keys (macOS Keychain).

```
pilot_import_cookies({ browser: "chrome", domains: [".github.com"] })
```

Supports Chrome, Arc, Brave, Edge, and Comet. Use `list_browsers`, `list_profiles`, and `list_domains` to discover what's available.

### Handoff / Resume

When headless mode hits a CAPTCHA, bot detection, or complex auth flow:

1. Call `pilot_handoff` — opens a visible Chrome window with all your cookies, tabs, and localStorage
2. Solve the challenge manually
3. Call `pilot_resume` — automation continues with the updated state

### Snapshot Diffing

Call `pilot_snapshot_diff` after an action to see exactly what changed on the page. Returns a unified diff. Useful for verifying actions worked, monitoring dynamic content, or debugging.

### AI-Friendly Errors

Playwright errors are translated into actionable guidance:
- Timeout → "Element not found. Run pilot_snapshot for fresh refs."
- Multiple matches → "Selector matched multiple elements. Use @refs from pilot_snapshot."
- Stale ref → "Ref is stale. Run pilot_snapshot for fresh refs."

### Circular Buffers

Console, network, and dialog events are captured in O(1) ring buffers (50K capacity). Query with `pilot_console`, `pilot_network`, `pilot_dialog`. Never grows unbounded.

## Architecture

pilot runs Playwright **in the same process** as the MCP server. No HTTP layer, no subprocess — direct function calls to the Playwright API over a persistent Chromium instance.

```
┌─────────────────────────────────────────────────┐
│  Your AI Agent (Claude Code, Cursor, etc.)      │
│                                                 │
│  ┌──────────────┐    stdio     ┌─────────────┐ │
│  │  MCP Client  │◄───────────►│ pilot │ │
│  └──────────────┘              │              │ │
│                                │  Playwright  │ │
│                                │  (in-proc)   │ │
│                                │      │       │ │
│                                │      ▼       │ │
│                                │  Chromium    │ │
│                                │  (persistent)│ │
│                                └─────────────┘ │
└─────────────────────────────────────────────────┘
```

This is why it's fast. No network hops, no serialization overhead, no process spawning per action.

## Requirements

- Node.js >= 18
- Chromium (installed via `npx playwright install chromium`)

## Credits

The core browser automation architecture — ref-based element selection, snapshot diffing, cursor-interactive scanning, annotated screenshots, circular buffers, and AI-friendly error translation — is ported from **[gstack](https://github.com/garrytan/gstack)** by [Garry Tan](https://github.com/garrytan).

Built on [Playwright](https://playwright.dev/) by Microsoft and the [Model Context Protocol](https://modelcontextprotocol.io/) SDK by Anthropic.

## License

MIT

---

If pilot is useful to you, [star the repo](https://github.com/TacosyHorchata/pilot) — it helps others find it.
