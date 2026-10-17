# Task Note Bridge

Todoist stays the alarm clock. Obsidian holds the thinking.

![Fuzzy-finding a task and opening its note](assets/fzf.gif)

## Install (desktop and Android)

### With BRAT (recommended, gets updates)
1. Settings → Community plugins → Browse → install and enable **BRAT**.
2. Run the command **BRAT: Add a beta plugin for testing** and enter
   `bobafouette/obsidian-todoist-fzf`.
3. Settings → Community plugins → enable **Task Note Bridge**, then paste your
   Todoist API token (see step 3 below).

BRAT installs the latest GitHub release and keeps it updated. It works on
Android too: do the same steps there, or let Obsidian Sync bring the plugin over.
BRAT needs the repository to be public; for a private repository it can use a
GitHub token (see the BRAT docs).

### Manual
1. Copy this folder to `<vault>/.obsidian/plugins/task-note-bridge/`
   (main.js, manifest.json, styles.css).
2. Settings → Community plugins → enable **Task Note Bridge**.
3. Paste your Todoist API token (Todoist → Settings → Integrations → Developer) and press **Test**.
4. On Android, let your sync bring the folder over, then enable the plugin there too
   (plugin enablement is per device unless you sync your config folder).

## Commands
- **Open task note (filtered tasks)**: picker over the tasks matching your filter
  (default `overdue | today`). 📝 marks tasks that already have a note.
  Choosing one creates or opens the note, writes the link back into the task,
  and logs a timestamped link in today's daily note (once per day).
  New notes are named after the task in lower case, with spaces and characters
  not allowed in file names replaced by the **File name separator** setting
  (default `-`, so "Fix the printer" becomes `fix-the-printer.md`; leave it
  empty to keep spaces).
- **Open task note (all tasks)**: same, over every active task.
- **Insert task inline (filtered / all tasks)**: for quick notes that don't
  deserve their own note. Inserts at the cursor:
  `- [Task title](todoist link) · due 2026-10-14 09:00 · [[task note]]`
  (the note link appears only if the task already has a note), then an indented
  bullet with the cursor ready for you to write. Optionally adds a
  "💬 Obsidian mention" link to the task, pointing at the note you wrote in;
  each new mention replaces the previous one, and the "📝 Obsidian note" link
  is never touched.
- **Create Todoist task from this note**: for drafts that become commitments.
  Type the due date in Todoist's natural language ("friday 14h", "every monday").
- **Open this note's task in Todoist**
- **Refresh all task notes from Todoist**: updates `due` and `todoist_status`
  (open / closed) in each note's properties. Also runs on startup by default.

## Note properties
`todoist_id`, `todoist_url`, `due`, `todoist_status`, `created`.
A Base (or Dataview) filtered on `todoist_status` = open and sorted by `due`
gives you a living view of your active work.

## Notes
- The plugin talks to the Todoist API (`api.todoist.com`) over the network,
  using your token. What it sends is task data plus the `obsidian://` links it
  writes into task descriptions (they contain your vault name and note path).
- The token is stored in plain text in `data.json`. If your vault is in Git,
  add `.obsidian/plugins/task-note-bridge/data.json` to `.gitignore`.
- "Closed" means completed or deleted in Todoist; the plugin doesn't distinguish.
- Daily-note logging uses the core Daily notes plugin's folder and format, and
  skips logging if today's note doesn't exist yet.
- Reminders stay entirely in Todoist. Tasks created from a note with a due time
  get Todoist's automatic reminder if you have that enabled in Todoist.

## Development
No build step: edit `main.js` directly. Run `node scripts/check.js` (syntax,
manifest, secrets) and `node --test 'test/*.test.js'` before committing.

## Releasing
1. Create the release, either way (tags have no `v` prefix):
   - **Web page:** Releases → Draft a new release → choose a tag → type
     `0.3.0`, target `main` → Publish release.
   - **Command line:** `git tag 0.3.0 && git push origin 0.3.0`.
2. The release workflow writes the tag version into `manifest.json` and
   `versions.json`, runs the checks and tests, and attaches `main.js`,
   `manifest.json` and `styles.css` to the release (creating it if you pushed
   only a tag). It refuses a tag lower than the version in `manifest.json`.
3. Optional, to keep the repository's own `manifest.json` current (and needed
   to change `minAppVersion`): `node scripts/bump-version.js 0.3.0 [minAppVersion]`
   and merge it to `main` before tagging. Don't edit the version in
   `manifest.json` by hand: CI fails unless `versions.json` has a matching
   entry, and the script updates both.
4. BRAT picks up the new release on its next update check.
