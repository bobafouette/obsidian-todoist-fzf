# Task Note Bridge

Todoist stays the alarm clock. Obsidian holds the thinking.

## Install (desktop and Android)
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
- The token is stored in plain text in `data.json`. If your vault is in Git,
  add `.obsidian/plugins/task-note-bridge/data.json` to `.gitignore`.
- "Closed" means completed or deleted in Todoist; the plugin doesn't distinguish.
- Daily-note logging uses the core Daily notes plugin's folder and format, and
  skips logging if today's note doesn't exist yet.
- Reminders stay entirely in Todoist. Tasks created from a note with a due time
  get Todoist's automatic reminder if you have that enabled in Todoist.
