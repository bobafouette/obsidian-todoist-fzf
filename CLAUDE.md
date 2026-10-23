# Todoist fzf — project context

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
  The facts part (completed tasks) is left to the separate community plugin
  "Todoist Completed Tasks"; this plugin doesn't duplicate it.
- Reminders stay entirely in Todoist (Obsidian can't notify reliably on mobile).

## Existing alternatives already evaluated (Oct 2026)
- Todoist Sync (jamiebrynes7): renders queries, can't create a note from a task.
- Todoist Task Notes: one note per task with two-way sync. Rejected (mirrors everything, very young).
- Todoist-Plug: note → task only (reverse direction).
- QuickAdd's Todoist example script: picker that inserts checkboxes (and completes tasks by default).

## What the plugin does (v0.3.0)
Plugin name "Todoist fzf"; the id stays `task-note-bridge` and the command ids are fixed
(users' hotkeys): `open-task-note`, `open-task-note-all`, `insert-task-inline`,
`insert-task-inline-all`, `create-task-from-note`, `open-in-todoist`, `refresh-task-notes`.
- **Open task note** (filtered / all): picker (sorted by due, due on a second line,
  📝 marks tasks with a note) → open the note, or create `<folder>/<title>.md`
  (lower-cased; spaces and forbidden characters replaced by the `fileNameSeparator`
  setting, default `-`; whole-character truncation at 100; collisions get `<sep>2`, `<sep>3`…).
  Frontmatter: `todoist_id`, `todoist_url`, `todoist_title`, `due`,
  `todoist_status` (open|closed|missing), `created`. Writes
  `[📝 Obsidian note](obsidian://…)` into the task description. On creation only, logs
  `- HH:mm [[note]]` under a heading in today's daily note, deduped within that section.
  The back-link and the log are independent: one failing doesn't skip the other.
- **Templates**: placeholders `{{title}} {{description}} {{due}} {{url}} {{id}} {{date}}`,
  also inside the template's frontmatter. The file is created from the rendered template,
  then `processFrontMatter` merges the plugin's keys (same-named keys overwritten, others
  kept, `created` kept if set). If the rendered frontmatter isn't valid YAML it is dropped
  with a notice and the plugin's keys are written alone. A missing template gives a notice
  and the default body.
- **Insert task inline** (filtered / all): inserts at the cursor
  `[title](todoist url) · due … · [[note if any]]` as plain text (no list marker, no child bullet).
  Optionally writes `[💬 Obsidian mention](obsidian://…)` into the task (replacing the previous mention only).
- **Create Todoist task from this note** (natural-language due string + due_lang).
- **Open this note's task in Todoist**.
- **Refresh all task notes**: also on startup (silent, errors caught). Lists active tasks
  (cap 500); a note whose task isn't listed and isn't already `closed`/`missing` gets one
  `GET /tasks/{id}`: 200 with `checked` → `closed`, 404 or `is_deleted` → `missing` (only the
  status changes), 200 unchecked → `open`. Every duplicate note of an id is updated. Writes
  only changed values (`noteProps` + `propsDiff`). Errors are isolated per task and per file.
- On rename/move of a task note, fixes the 📝 link in Todoist (only if present, task open).

## Code layout (main.js)
Pure helpers (`sanitizeTitle`, `noteProps`, `propsDiff`, `applyProps`, `indexNotes`,
`dailyNotePath`, `sectionContains`, `insertUnderHeading`, `renderTemplate`, …),
`TodoistClient` (injectable `request`, `TodoistError` with `status`, pure `paginate`,
friendly 401/403/offline messages), modals, the plugin, the settings tab
(`text()`/`toggle()` helpers). User-facing messages are `MSG_*` constants; `fail()` logs
to the console and shows an 8 s notice prefixed with the plugin name.

## Technical constraints
- Plain CommonJS JavaScript in a single `main.js`, no build step, no `package.json`, no
  dependencies. Keep it that way unless the owner asks for TypeScript.
- Must work on Obsidian mobile: network only via `requestUrl`; no `require` other than
  `obsidian`, no `fetch`/`XMLHttpRequest`/Node/Electron APIs; `isDesktopOnly: false`.
- Todoist **unified API v1**, base `https://api.todoist.com/api/v1`:
  - `GET /tasks/filter?query=…` and `GET /tasks`, cursor-paginated (`results`, `next_cursor`, limit ≤ 200)
  - `GET /tasks/{id}`, `POST /tasks/{id}` (update), `POST /tasks` (create)
  - Task web URL: `https://app.todoist.com/app/task/{id}`
- `obsidian://` URIs: encode `(` and `)` too, or the markdown links break.
- Daily note path comes from the core Daily notes plugin settings.
- Token stored in plain text in `data.json`. Never commit it (see .gitignore).
- No personal details in the repo other than the GitHub handle `bobafouette`.

## Tests, CI, release
- `test/`: `node --test 'test/*.test.js'` (Node built-ins only). A recording `obsidian`
  stub plus an in-memory fake app (`plugin.test.js`) cover commands (ids pinned), refresh,
  daily log, templates and settings; `client.test.js` covers `TodoistClient`;
  `helpers.test.js` the pure helpers (`TaskNoteBridge._test`).
- `node scripts/check.js`: syntax, mobile safety, manifest/versions.json consistency, secrets.
- CI (`.github/workflows/ci.yml`) runs both. Publishing a release (web page) or pushing a
  tag `X.Y.Z` (no `v`) runs `release.yml`, which writes the tag version into
  manifest.json/versions.json and publishes main.js/manifest.json/styles.css for BRAT
  installs. `node scripts/bump-version.js X.Y.Z` is optional (keeps the repo's manifest
  current; needed to change minAppVersion). Never hand-edit the manifest version:
  check.js fails unless versions.json has a matching entry.

## Status / known gaps
- Nothing has been tested yet inside real Obsidian or against the live API. Verify there first.
- Completed vs deleted: the code assumes `GET /tasks/{id}` returns 200 with `checked: true`
  for a completed task and 404 (or `is_deleted: true`) for a deleted one. Unverified against
  the live API: if completed tasks also answer 404, they would show as `missing`.
- Notes already `closed` or `missing` are not looked up again (a closed task deleted later
  stays `closed`); notes marked `closed` by v0.2.x may be deleted tasks.
- No override yet for Periodic Notes folder/format.
- Inline mentions are snapshots: their due dates don't refresh.
