# cdp-browser-access

[简体中文](README.md) | **English**

A skill that lets an agent drive **your everyday browser over CDP**. It reuses the login sessions already in that browser to reach gated or anti-scraping sites, and handles JS-rendered content, page interaction, screenshots, and video frame capture.

Forked from [eze-is/web-access](https://github.com/eze-is/web-access) (MIT, by 一泽Eze). This fork is deliberately narrower: **it covers only the browser layer**. General search and static fetching are left to the harness's own tools.

## What it covers

| Scenario | Use this skill | Notes |
|---|---|---|
| Content behind a login | ✅ | Reuses your browser session; no cookies to configure |
| Anti-scraping platforms (Xiaohongshu, WeChat articles, Weibo, Zhihu, …) | ✅ | Static fetching fails; go through a real browser |
| JS-rendered content | ✅ | Wait until the target content actually appears in the DOM |
| Click / fill forms / upload / infinite scroll / pagination | ✅ | |
| Page screenshots, video frame capture | ✅ | |
| Locating a URL from your own bookmarks / history | ✅ | "that page I looked at earlier", internal systems |
| General search, fetching a known URL's text, reading docs | ❌ | **Use the harness's own search / fetch tools** — faster and more reliable |

## Requirements

- **Node.js 22+** (uses the native WebSocket)
- A Chromium-based browser installed (Chrome / Edge / Chromium / Chrome Canary)
- **Turn on the remote debugging toggle once** (required; cannot be automated):
  visit `chrome://inspect/#remote-debugging`
  (`edge://inspect/#remote-debugging` on Edge) and check
  `Allow remote debugging for this browser instance`.
  An authorization prompt may appear on first connect — click "Allow".
- On macOS, a working `sqlite3` (system, conda, or Homebrew are all fine) for reading browser history

## Installation

A skill is just a directory — drop it into the relevant harness's **skills root**.

| Harness | Where |
|---|---|
| **Claude Code** | `~/.claude/skills/cdp-browser-access/` (project scope: `<repo>/.claude/skills/`) |
| **OpenAI Codex** | `~/.agents/skills/cdp-browser-access/` or `~/.codex/skills/cdp-browser-access/` |
| **DeepSeek Harness** | `~/.agents/skills/cdp-browser-access/` or `~/.dsh/skills/cdp-browser-access/` |

`~/.agents/skills/` is the **cross-harness convention outside Claude Code** — both Codex and DeepSeek Harness read it.

```bash
git clone https://github.com/CharlesXu-HQ/cdp-browser-access.git /tmp/cdp-browser-access
mkdir -p ~/.agents/skills
cp -R /tmp/cdp-browser-access ~/.agents/skills/cdp-browser-access
rm -rf /tmp/cdp-browser-access

# Claude Code needs its own copy; a symlink keeps a single source of truth
mkdir -p ~/.claude/skills
ln -s ~/.agents/skills/cdp-browser-access ~/.claude/skills/cdp-browser-access
```

> **Claude Code does not read `~/.agents/skills/` automatically.** It only treats that directory as an import source for `/import`.
> Measured skill search paths: `managed` + `~/.claude/skills` + `<project>/.claude/skills`.

If your harness supports a skills CLI (e.g. `npx skills add`), you can point it at this repo directly.

## Usage

Just ask normally after installing — the harness decides whether to trigger based on the `description` in `SKILL.md`. Full usage, the Proxy API, and the site-experience mechanism are documented in [`SKILL.md`](./SKILL.md).

## Diagnostics

If it can't reach the browser, run this first:

```bash
node scripts/cdp-proxy.mjs --probe-only 9222
```

It performs a **real WebSocket handshake** against each candidate path on the given debug port and prints the results, without starting the service.

## Security notes

- **This skill operates your real browser**, so it carries all of your login sessions. Only use it on machines you trust.
- Some sites scrutinize automation heavily; **there is a risk of account suspension**.
- The local proxy listens on `127.0.0.1:3456` and is **not exposed to the network**, but it currently has **no authentication and no Origin check** — other processes on your machine can call its API to drive your browser. Add a token or a firewall rule if that matters to you.
- Bookmark / history lookups require keywords; **calling it without keywords is forbidden**, because it would dump your entire recent browsing history.

## Repository layout

```
SKILL.md                     Usage instructions (what the agent reads on trigger)
README.md                    Chinese README (default)
README.en.md                 This file
NOTICE.md                    Upstream attribution, change list, fix records
LICENSE                      MIT
config.env                   Runtime browser preference (gitignored)
scripts/
  check-deps.mjs             Preflight + start/reuse the CDP proxy
  cdp-proxy.mjs              The CDP proxy itself (browser connection, HTTP API)
  browser-discovery.mjs      Debug port discovery and browser selection (shared)
  find-url.mjs               Search local browser bookmarks / history
  match-site.mjs             Match site-experience files from user input (upstream leftover; not referenced by SKILL.md)
references/
  cdp-api.md                 CDP API and JS extraction patterns
  migration-2.5.3.md         Migration guide for `/new` and `/navigate` moving to POST body
  site-patterns/             Per-domain site experience (generated at runtime, gitignored)
templates/
  config.env.template        Template for config.env
```

## Differences from upstream

See [`NOTICE.md`](./NOTICE.md).

## License

MIT. Original copyright belongs to 一泽Eze ([eze-is/web-access](https://github.com/eze-is/web-access));
modifications in this fork belong to Charles xu. See [`LICENSE`](./LICENSE).
