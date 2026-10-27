# DisciplineFeed

A personal RSS reader for discipline, focus and self-improvement writing, plus a notebook (**My List**) for collecting snippets into short-form video scripts. Runs on Cloudflare Workers with a D1 database.

## Features

- Subscribe to any RSS/Atom feed or Substack (paste the site URL and the feed is found automatically). Feeds refresh every 30 minutes.
- Move subscriptions in or out with **Import / Export** (OPML, the format every RSS reader understands), next to the Subscriptions heading.
- Reader with reading progress, a **Continue Reading** list, saved articles, unread counts, search and mark-all-read.
- **Discover**: track topic keywords to surface the best-matching articles across your subscriptions, and find new Substacks for a topic.
- **My List**: select text while reading and tap **+ Add to my list**, or jot your own notes. Drag snippets into order, check the word count and estimated speaking time, then **Copy all** (or download as Markdown) to get a script draft with a sources list. **Clear** starts a fresh script, with Undo.
- **Teleprompter**: read your My List script on camera. It scrolls at a words-per-minute pace you set, with a 3-2-1 countdown, tap or Space to pause, mirror mode for teleprompter glass, and keeps the phone screen awake while running.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous article |
| `o` | Open original in a new tab |
| `s` | Save / unsave |
| `m` | Mark read / unread |
| `/` | Search |
| `r` | Refresh all feeds |
| `Shift` + `A` | Mark all as read |
| `g` then `a` / `u` / `s` / `l` / `d` | Go to All / Unread / Saved / My List / Discover |
| `?` | Show shortcuts |

In My List, focus a snippet's grip handle and press `↑` / `↓` to move it.

In the teleprompter: `Space` start/pause, `↑` / `↓` speed, `m` mirror, `r` back to the top, `Esc` close.

## Development

Requires Node 22.

```sh
npm install
npm run db:migrate:local   # creates the local D1 schema from schema.sql
npm run dev                # http://localhost:8787
```

Checks (CI runs the same three):

```sh
npm run typecheck
npm run check:client
npm test
```

## Deploying

```sh
npm run deploy
```

### Database migrations

A **new** database only needs `schema.sql` (`npm run db:migrate:remote`).

An **existing** database needs each migration it hasn't had yet, in order, run right before deploying the code that uses it:

```sh
npx wrangler d1 execute disciplinefeed-db --remote --file=./migrations/<file>.sql
```

| Migration | Adds |
| --- | --- |
| `0002_add_reading_progress.sql` | Reading progress |
| `0003_add_topics.sql` | Discover topics |
| `0004_add_progress_updated_at.sql` | Continue Reading ordering |
| `0005_sort_at_and_conditional_get.sql` | Publish-date ordering, cheaper feed refreshes |
| `0006_highlight_position.sql` | Reordering in My List |
| `0007_article_text.sql` | Full-text search (older articles are indexed in the background, 50 per refresh) |

These run with `d1 execute`, not `wrangler d1 migrations apply`, because the database predates migration tracking. Running one twice is harmless: it either does nothing or stops with a "duplicate column" error.

## Project layout

```
src/index.ts            API routes (Hono) and the scheduled refresh
src/feeds.ts            Fetching, autodiscovery, conditional GET, storing articles
src/parse.ts            RSS/Atom parsing and HTML sanitizing
src/discover.ts         Topic scoring for Discover
src/discoverSources.ts  Finding Substacks for a topic
src/pagination.ts       Article list cursors
public/                 The web app (plain HTML/CSS/JS, no build step)
test/                   Unit tests (node:test)
```

## Privacy

There's no login: anyone who has the app's URL can use it. Keep the URL to yourself.
