# Task Note Bridge — project context

## Why this exists
For people who use Todoist for dates and reminders and Obsidian for thinking. Without a
bridge the two collide: work gets entered twice (a task in Todoist, then copied into the
daily log), and context ends up in Todoist's comment editor, which is a poor place to
write. This plugin lets a task reach its note (and a note reach its task) without retyping.

## Design principle (agreed, don't drift from it)
- **Todoist = "when"**: the alarm clock. A task is a title, a due date, reminders and
  a link to a note. No context lives in Todoist.
- **Obsidian = "what and why"**: all thinking and context.
- Only tasks that need thought get a dedicated note, created on demand.
  Do NOT mirror every Todoist task into the vault (rejected: that recreates the collision).
- The daily log has an automatic "facts" part and a hand-written narrative part.
  The facts part (completed tasks) is handled by the separate community plugin
  "Todoist Completed Tasks"; this plugin doesn't duplicate it.
- Reminders stay entirely in Todoist (Obsidian can't notify reliably on Android).

## Existing alternatives already evaluated (Oct 2026)
- Todoist Sync (jamiebrynes7): renders queries, can't create a note from a task.
- Todoist Task Notes: one note per task with two-way sync. Rejected (mirrors everything, very young).
- Todoist-Plug: note → task only (reverse direction).
- QuickAdd's Todoist example script: picker that inserts checkboxes (and completes tasks by default).

## What the plugin does (v0.2.0)
- **Open task note** (filtered / all): picker → create or open `Tasks/<title>.md` (lower-cased; spaces and forbidden
  characters replaced by the `fileNameSeparator` setting, default `-`) with
  frontmatter `todoist_id`, `todoist_url`, `due`, `todoist_status` (open|closed), `created`;
  writes `[📝 Obsidian note](obsidian://…)` into the task description; logs
  `- HH:mm [[note]]` under a heading in today's daily note (once per day).
- **Insert task inline** (filtered / all): inserts at the cursor
  `[title](todoist url) · due … · [[note if any]]` as plain text (no list marker, no child bullet),
  for quick notes that don't need a dedicated note. Optionally writes
  `[💬 Obsidian mention](obsidian://…)` into the task (replacing the previous mention only).
- **Create Todoist task from this note** (natural-language due string + due_lang).
- **Open this note's task in Todoist**.
- **Refresh all task notes**: updates due/status; also runs on startup. Writes only
  when values change, to avoid churning Obsidian Sync.
- On rename/move of a task note, fixes the 📝 link in Todoist (only if present).

## Technical constraints
- Plain CommonJS JavaScript in `main.js`, no build step. Keep it that way unless the
  owner asks for TypeScript.
- Must work on Obsidian mobile (Android): use `requestUrl`, no Node/Electron APIs,
  `isDesktopOnly: false`.
- Todoist **unified API v1**, base `https://api.todoist.com/api/v1`:
  - `GET /tasks/filter?query=…` and `GET /tasks`, cursor-paginated (`results`, `next_cursor`, limit ≤ 200)
  - `GET /tasks/{id}`, `POST /tasks/{id}` (update), `POST /tasks` (create)
  - Task web URL: `https://app.todoist.com/app/task/{id}`
- `obsidian://` URIs: encode `(` and `)` too, or the markdown links break.
- Daily note path comes from the core Daily notes plugin settings.
- Token stored in plain text in `data.json`. Never commit it (see .gitignore).

## Status / known gaps
- Pure helpers are unit-tested with a stubbed `obsidian` module (`TaskNoteBridge._test`),
  in `test/` (`node --test 'test/*.test.js'`, Node built-ins only, no package.json).
- CI (`.github/workflows/ci.yml`) runs `node scripts/check.js` (syntax, mobile-safety,
  manifest/versions.json, secrets) and the tests. Publishing a release (web page) or pushing a tag `X.Y.Z` (no `v`) runs
  `release.yml`, which writes the tag version into manifest.json/versions.json and publishes
  main.js/manifest.json/styles.css for BRAT installs. `node scripts/bump-version.js X.Y.Z` is optional
  (keeps the repo's manifest current; needed to change minAppVersion). Never hand-edit
  the manifest version: check.js fails unless versions.json has a matching entry.
  Nothing has been tested yet inside real Obsidian or against the live API.
  Verify against the real environment first.
- "Closed" doesn't distinguish completed from deleted.
- No override yet for Periodic Notes folder/format.
- Inline mentions are snapshots: their due dates don't refresh.
