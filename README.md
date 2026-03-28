# pilot — Your AI Agent, Inside Your Real Browser

[![npm](https://img.shields.io/npm/v/pilot-mcp)](https://www.npmjs.com/package/pilot-mcp)
[![license](https://img.shields.io/github/license/TacosyHorchata/Pilot)](https://github.com/TacosyHorchata/Pilot/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/TacosyHorchata/Pilot)](https://github.com/TacosyHorchata/Pilot)

> Your AI agent controls a tab in your real Chrome — already logged in, no bots blocked, no CAPTCHAs.

![pilot demo](pilot-demo.gif)

Other browser tools launch a separate headless browser. Your agent starts anonymous, gets blocked by Cloudflare, can't access anything behind login.

pilot takes a different approach: **it controls a tab in the browser you're already using.** Your agent sees what you see — logged into GitHub, Linear, Notion, your internal tools. No cookie hacks. No re-authentication. No bot detection.

---

## Quick Start

### 1. Install pilot

```bash
npx pilot-mcp
npx playwright install chromium
```

Add to `.mcp.json` (Claude Code) or MCP settings (Cursor):

```json
{
  "mcpServers": {
    "pilot": {
      "command": "npx",
      "args": ["-y", "pilot-mcp"]
    }
  }
}
```

### 2. Install the Chrome extension

```bash
npx pilot-mcp --install-extension
```

This opens Chrome's extensions page and shows the folder path. Click **Load unpacked** → paste the path. You'll see the ✈️ Pilot icon — badge shows **ON** when connected.

### 3. Use it

Tell your agent:

> "Go to my GitHub notifications and summarize them"

The agent navigates in a real Chrome tab — already logged in as you. No setup. No cookies. No Cloudflare blocks.

---

## Two Modes

### Extension Mode — your real browser

The Pilot Chrome extension connects to the MCP server via WebSocket. Your agent gets its own tab in your real browser — with all your sessions, cookies, and logged-in state already there.

```
AI Agent → MCP (stdio) → pilot → WebSocket → Chrome Extension → Your Browser Tab
```

- No Cloudflare blocks (real browser fingerprint)
- Already authenticated everywhere
- Multiple agents get separate tabs (multiplexed)
- You can watch the agent work in real-time

This is how pilot is meant to be used.

### Headed Mode — visible Chromium

When the extension isn't connected, pilot opens a **visible** Chromium window. You can see everything the agent does and intervene when needed.

Import cookies from your real browser to authenticate:

```
pilot_import_cookies({ browser: "chrome", domains: [".github.com", ".linear.app"] })
```

Supports **Chrome, Arc, Brave, Edge, Comet** via macOS Keychain / Linux libsecret.

When the agent hits a CAPTCHA or bot wall, it hands control to you:

1. `pilot_handoff` — pauses automation, you solve the challenge
2. `pilot_resume` — agent continues where it left off

---

## Lean Snapshots

Large page snapshots eat context windows. pilot is opinionated about keeping things small:

- **Navigate** returns a ~2K char preview, not a 50K+ page dump
- **Snapshot** supports `max_elements`, `interactive_only`, `lean`, `structure_only`
- **Snapshot diff** shows only what changed — no redundant re-reads

```
Other tools:   navigate(58K) → navigate(58K) → answer        = 116K chars
pilot:         navigate(2K)  → navigate(2K)  → snapshot(9K)  =  13K chars
```

Less context = faster inference, cheaper API calls, fewer failures.

---

## pilot vs @playwright/mcp

Both are solid tools. Here's what's actually different:

| | pilot | @playwright/mcp |
|---|---|---|
| **Real browser control** | Extension controls a tab in your Chrome | Extension for session reuse (no DOM control) |
| **Bot detection** | Not an issue (real browser) + handoff/resume | ❌ blocked by Cloudflare |
| **Cookie import** | Decrypt from Chrome, Arc, Brave, Edge, Comet | ❌ (manual `--storage-state` JSON) |
| **Default snapshot size** | ~2K on navigate, ~9K full snapshot | ~50-60K on navigate |
| **Snapshot diffing** | `pilot_snapshot_diff` | ❌ |
| **Token control** | `max_elements`, `interactive_only`, `lean`, `structure_only` | `--snapshot-mode` (incremental/full/none) |
| **Iframe support** | `pilot_frames`, `pilot_frame_select`, `pilot_frame_reset` | ❌ |
| **Ad blocking** | `pilot_block` with `ads` preset | `--blocked-origins` (manual) |
| **Tool profiles** | `core` (9) / `standard` (30) / `full` (61) | Capability groups via `--caps` |
| **Transport** | stdio | stdio, HTTP, SSE |
| **Persistent sessions** | `pilot_auth` + cookie import | `--user-data-dir`, `--storage-state` |
| **Network interception** | `pilot_intercept` | `browser_route` |
| **Assertions** | `pilot_assert` | Verify tools via `--caps=testing` |

**Use pilot when:** You need your agent to work on authenticated sites, you want lean context, or you're tired of Cloudflare blocks.

**Use @playwright/mcp when:** You need HTTP/SSE transport, Windows auth support, or you prefer Microsoft's ecosystem.

---

## Tool Profiles

61 tools is too many for most LLMs — research shows degradation past ~30. Load only what you need:

| Profile | Tools | Use case |
|---|---|---|
| `core` | 9 | Simple automation — navigate, snapshot, click, fill, type, press_key, wait, screenshot |
| `standard` | 30 | Common workflows — core + tabs, scroll, hover, drag, iframes, auth, block, find |
| `full` | 61 | Everything, including network mocking, assertions, clipboard, geolocation |

```json
{
  "mcpServers": {
    "pilot": {
      "command": "npx",
      "args": ["-y", "pilot-mcp"],
      "env": { "PILOT_PROFILE": "standard" }
    }
  }
}
```

Default is `standard` (30 tools).

---

## All Tools (61)

### Navigation
| Tool | Description |
|------|-------------|
| `pilot_get` | Navigate and return full readable content + interactive elements in one call |
| `pilot_navigate` | Navigate to a URL. Returns content preview + interactive elements (~2K chars) |
| `pilot_back` | Go back in browser history |
| `pilot_forward` | Go forward in browser history |
| `pilot_reload` | Reload the current page |

### Snapshots
| Tool | Description |
|------|-------------|
| `pilot_snapshot` | Accessibility tree with `@eN` refs. Supports `max_elements`, `structure_only`, `interactive_only`, `lean`, `compact`, `depth` |
| `pilot_snapshot_diff` | Unified diff showing what changed since last snapshot |
| `pilot_find` | Find element by visible text, label, or role — returns a ref without a full snapshot |
| `pilot_annotated_screenshot` | Screenshot with red boxes at each `@ref` position |

### Interaction
| Tool | Description |
|------|-------------|
| `pilot_click` | Click by `@ref` or CSS selector |
| `pilot_hover` | Hover over an element |
| `pilot_fill` | Clear and fill an input/textarea |
| `pilot_select_option` | Select a dropdown option |
| `pilot_type` | Type text character by character |
| `pilot_press_key` | Press keyboard keys |
| `pilot_drag` | Drag from one element to another |
| `pilot_scroll` | Scroll element or page |
| `pilot_wait` | Wait for element, network idle, or page load |
| `pilot_file_upload` | Upload files to a file input |

### Iframes
| Tool | Description |
|------|-------------|
| `pilot_frames` | List all iframes |
| `pilot_frame_select` | Switch context into an iframe |
| `pilot_frame_reset` | Switch back to main frame |

### Page Inspection
| Tool | Description |
|------|-------------|
| `pilot_page_text` | Clean text extraction |
| `pilot_page_html` | Get innerHTML of element or full page |
| `pilot_page_links` | All links as text + href pairs |
| `pilot_page_forms` | All form fields as structured JSON |
| `pilot_page_attrs` | All attributes of an element |
| `pilot_page_css` | Computed CSS property value |
| `pilot_element_state` | Check visible/hidden/enabled/disabled/checked/focused |
| `pilot_page_diff` | Text diff between two URLs |

### Debugging
| Tool | Description |
|------|-------------|
| `pilot_console` | Console messages from circular buffer |
| `pilot_network` | Network requests from circular buffer |
| `pilot_dialog` | Captured alert/confirm/prompt messages |
| `pilot_evaluate` | Run JavaScript on the page |
| `pilot_cookies` | Get all cookies as JSON |
| `pilot_storage` | Get localStorage/sessionStorage |
| `pilot_perf` | Page load performance timings |

### Visual
| Tool | Description |
|------|-------------|
| `pilot_screenshot` | Screenshot of page or element |
| `pilot_pdf` | Save page as PDF |
| `pilot_responsive` | Screenshots at mobile, tablet, desktop |

### Tabs
| Tool | Description |
|------|-------------|
| `pilot_tabs` | List open tabs |
| `pilot_tab_new` | Open a new tab |
| `pilot_tab_close` | Close a tab |
| `pilot_tab_select` | Switch to a tab |

### Session & Auth
| Tool | Description |
|------|-------------|
| `pilot_import_cookies` | Import cookies from Chrome, Arc, Brave, Edge, Comet via Keychain decryption |
| `pilot_auth` | Save/load/clear full session state (cookies + localStorage + sessionStorage) |
| `pilot_set_cookie` | Set a cookie manually |
| `pilot_set_header` | Set custom request headers |
| `pilot_set_useragent` | Set user agent string |
| `pilot_handle_dialog` | Configure dialog auto-accept/dismiss |
| `pilot_resize` | Set viewport size |
| `pilot_block` | Block requests by URL pattern or `ads` preset |
| `pilot_geolocation` | Set fake GPS coordinates |
| `pilot_cdp` | Connect to a real Chrome instance via CDP |
| `pilot_extension_status` | Check Chrome extension connection status |
| `pilot_handoff` | Open headed Chrome for manual interaction (CAPTCHA, auth) |
| `pilot_resume` | Resume automation after handoff |
| `pilot_close` | Close browser and clean up |

### Automation (full profile)
| Tool | Description |
|------|-------------|
| `pilot_intercept` | Intercept requests and return custom responses |
| `pilot_assert` | Assert URL, text, element state, or value |
| `pilot_clipboard` | Read or write clipboard content |

---

## Extension Architecture

The Pilot extension uses a broker/client model — multiple AI sessions share one extension, each getting its own tab:

```
Claude Code Session A ──┐
                        ├→ pilot broker (ws://127.0.0.1:3131) → Chrome Extension → Tab 1
Claude Code Session B ──┘                                                       → Tab 2
```

Each session's tab is color-grouped in Chrome so you can see which tab belongs to which agent.

---

## Requirements

- Node.js >= 18
- Chrome + Pilot extension (recommended)
- macOS or Linux (for cookie import in headed mode)
- Chromium: `npx playwright install chromium` (for headed mode)

## Security

| Variable | Default | Description |
|---|---|---|
| `PILOT_PROFILE` | `standard` | Tool set: `core` (9), `standard` (30), or `full` (61) |
| `PILOT_OUTPUT_DIR` | System temp | Restricts where screenshots/PDFs can be written |

- Extension communicates over localhost WebSocket only (127.0.0.1)
- Output path validation prevents writing outside `PILOT_OUTPUT_DIR`
- Path traversal protection on all file operations
- Expression size limit (50KB) on `pilot_evaluate`

## Development

```bash
npm test   # unit tests via vitest
```

---

## Credits

The core browser automation architecture — ref-based element selection, snapshot diffing, cursor-interactive scanning, annotated screenshots, circular buffers, and AI-friendly error translation — is ported from **[gstack](https://github.com/garrytan/gstack)** by [Garry Tan](https://github.com/garrytan).

Built on [Playwright](https://playwright.dev/) by Microsoft and the [Model Context Protocol](https://modelcontextprotocol.io/) SDK by Anthropic.

---

If pilot is useful to you, [star the repo](https://github.com/TacosyHorchata/Pilot) — it helps others find it.

<!-- Keywords: MCP browser automation, Playwright MCP alternative, pilot-mcp, Claude Code browser, Cursor browser automation, MCP server, AI browser automation, web automation AI agent, browser automation for LLMs, cookie import MCP, Model Context Protocol browser, npx pilot-mcp, Chrome extension MCP, real browser AI agent, authenticated browser agent, Cloudflare bypass MCP -->
