# Pilot CLI — Browser Automation

You have access to a persistent headless browser via `pilot-cli` shell commands.
The daemon starts automatically on first use — no setup needed.

## How it works

Commands return **short inline summaries + a file path** for the full snapshot.
Read the file with your Read tool only when you need element refs or more detail.
This keeps conversation history lean — paths accumulate, not 50K snapshots.

## Commands

```bash
# Navigate and get page content (preferred for read tasks)
# Returns: URL, title, first 400 chars of content, + path to full snapshot
pilot-cli get <url>

# Navigate to a URL
# Returns: "Navigated to <url> (200)\nSnapshot → /tmp/pilot-xxx.txt"
pilot-cli navigate <url>

# Get full page snapshot — always saves to file, returns path
# Read with Read tool when you need @eN refs to click/fill
pilot-cli snapshot

# Click an element — use @eN ref from snapshot file, or CSS selector
# Returns: "Clicked @e3 — snapshot → /tmp/pilot-xxx.txt"
pilot-cli click @e3
pilot-cli click "button[type=submit]"

# Fill an input
pilot-cli fill @e5 "search text"

# Type character by character (for inputs that reject fill)
pilot-cli type @e5 "search text"

# Press a key
pilot-cli press Enter
pilot-cli press Tab

# Scroll
pilot-cli scroll down 500
pilot-cli scroll up 300

# Current URL or title
pilot-cli url
pilot-cli title

# History
pilot-cli back
pilot-cli forward
```

## Typical workflows

**Read task** ("go to X and tell me Y"):
```bash
pilot-cli get https://news.ycombinator.com
# Returns title + first 400 chars — usually enough to answer directly
# If you need more: Read /tmp/pilot-xxx.txt (path returned above)
```

**Interaction task** ("search for X, click Y"):
```bash
pilot-cli navigate https://www.npmjs.com
# Returns: "Navigated to ... → /tmp/pilot-aaa.txt"

# Read the snapshot to find refs
# [Read /tmp/pilot-aaa.txt]
# → find the search input ref, e.g. @e4

pilot-cli fill @e4 "zod"
pilot-cli press Enter

# Navigate result returns new snapshot path
pilot-cli snapshot
# → /tmp/pilot-bbb.txt
# [Read /tmp/pilot-bbb.txt] — find the result link ref
pilot-cli click @e7
```

## Rules

- `pilot-cli get` over `navigate + Read` for read-only tasks — it returns a useful inline snippet
- After `navigate` or `click`, you get a new snapshot path — read it only if you need refs
- Never call `snapshot` right after `navigate` — navigate already saves a snapshot
- Use `@eN` refs from snapshot files — more reliable than CSS selectors on dynamic pages
