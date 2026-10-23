# Todoist fzf

Todoist stays the alarm clock. Obsidian holds the thinking.

![Fuzzy-finding a task and opening its note](assets/fzf.gif)

Pick a Todoist task from inside Obsidian and either open it as a note (created on demand) or drop a one-line link to it into whatever you are writing. A task in Todoist stays a title, a due date, reminders and a link to its note; the context lives in the note. Task notes keep their Todoist facts (title, due date, status) up to date; everything else in the note is yours.

## Install (desktop and Android)

### With BRAT (recommended, gets updates)
1. Settings → Community plugins → Browse → install and enable **BRAT**.
2. Run the command **BRAT: Add a beta plugin for testing** and enter
   `bobafouette/obsidian-todoist-fzf`.
3. Settings → Community plugins → enable **Todoist fzf**, then set it up (below).

BRAT installs the latest GitHub release and keeps it updated. It works on
Android too: do the same steps there, or let Obsidian Sync bring the plugin over.
BRAT needs the repository to be public; for a private repository it can use a
GitHub token (see the BRAT docs).

### Manual
1. Download `main.js`, `manifest.json` and `styles.css` from the latest release
   into `<vault>/.obsidian/plugins/task-note-bridge/`.
2. Settings → Community plugins → enable **Todoist fzf**.
3. On Android, let your sync bring the folder over, then enable the plugin there too
   (plugin enablement is per device unless you sync your config folder).

## Set up

1. Copy your API token from Todoist → Settings → Integrations → Developer.
2. Paste it in the plugin settings and press **Test**. You should see "Connected to Todoist ✔".

Other settings: the filter for the "filtered tasks" commands (default `overdue | today`),
the notes folder (`Tasks`), the file name separator (`-`), an optional template note,
writing the 📝 note link and the 💬 mention link back into tasks (on), fixing the 📝 link
when a note is renamed or moved (on), logging new notes to the daily note (on), the daily
note heading (`## Log`), refreshing on startup (on), and the language of the due dates
you type (`en`).

## Commands

| Command | What it does |
|---|---|
| Open task note (filtered tasks) | Picker over the tasks matching your filter, sorted by due date, with the due date on a second line. 📝 marks tasks that already have a note. Opens the note, or creates it and logs it in today's daily note. Also writes a `📝 Obsidian note` link into the task description. |
| Open task note (all tasks) | Same, over every active task (up to 500). |
| Insert task inline (filtered tasks) | Inserts `[Task title](todoist link) · due 2026-10-14 09:00 · [[task note]]` at the cursor, as plain text with no list marker or extra lines. The due date and the note link appear only when they exist. Optionally writes a `💬 Obsidian mention` link into the task, pointing at the note you wrote in; each new mention replaces the previous one. |
| Insert task inline (all tasks) | Same, over every active task. |
| Create Todoist task from this note | For drafts that become commitments. Type the due date in Todoist's natural language ("friday 14h", "every monday"). The task gets a 📝 link to the note, and the note gets the properties below. |
| Open this note's task in Todoist | Available only on notes that have `todoist_id`. |
| Refresh all task notes from Todoist | Updates the properties of every note that has `todoist_id`. Also runs on startup. |

A new note is named after the task in lower case, with spaces and characters not
allowed in file names replaced by the separator (`Fix the printer` becomes
`fix-the-printer.md`; on a name collision, `fix-the-printer-2.md`). Notes are never
renamed afterwards.

Logging to the daily note happens only when a note is created, as `- HH:mm [[note]]`
at the end of the configured section, and never twice in the same section. If writing
the 📝 link into Todoist fails, the note is still created, opened and logged.

## Note properties

| Property | Value | Written |
|---|---|---|
| `todoist_id` | Task id | creation |
| `todoist_url` | `https://app.todoist.com/app/task/<id>` | creation |
| `todoist_title` | Task title | creation, refresh |
| `due` | `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm:ss` in local time; removed when the task has no due date | creation, refresh |
| `todoist_status` | `open`, `closed` (completed) or `missing` (deleted, or not visible to you) | creation, refresh |
| `created` | Local `YYYY-MM-DD` | creation only (kept if the template sets it) |

A Base (or Dataview) filtered on `todoist_status` = open and sorted by `due`
gives you a living view of your active work.

## Template

Set a template note in the settings to control new task notes. Placeholders:
`{{title}}`, `{{description}}` (without the plugin's 📝 and 💬 links), `{{due}}`,
`{{url}}`, `{{id}}`, `{{date}}` (today, `YYYY-MM-DD`). Unknown placeholders are left
as they are. Placeholders work in the template's frontmatter too.

The template's own properties are kept and merged with the plugin's into a single
frontmatter block; a property with the same name as one of the plugin's is overwritten.
If a filled-in placeholder makes the template's frontmatter invalid YAML (a title with
`: ` in it, for example), its properties are dropped with a notice; quote such values
(`title: "{{title}}"`) to avoid it. Without a template the body is the title, the task
description as a quote, and empty "Context" and "Notes" sections.

## How refresh works

- It runs when Obsidian starts (if enabled, silently) and on demand with the refresh command.
- Active tasks are fetched in one listing (up to 500). A note is written only when a value
  actually changed, to avoid needless sync churn. Every note carrying the same
  `todoist_id` is updated.
- A note whose task is no longer active is looked up on its own, once: a completed task
  sets `todoist_status: closed`; a task Todoist answers 404 for (or reports as deleted)
  sets `todoist_status: missing`, leaving the other properties alone. Notes already
  `closed` or `missing` are not looked up again; a reopened task comes back to `open`
  through the listing.
- One failing note or task doesn't stop the others; the manual refresh reports how many failed.

## Privacy

- The plugin talks only to the Todoist API (`api.todoist.com`), using your token.
  It reads your tasks and writes only task descriptions: the `📝 Obsidian note` and
  `💬 Obsidian mention` links (they contain your vault name and the note's path), and
  the title, due date and link of tasks you create from a note.
- Your API token is stored in plain text in the plugin's `data.json`. If your vault is
  in Git, add `.obsidian/plugins/task-note-bridge/data.json` to `.gitignore`.

## Limitations

- Reminders stay entirely in Todoist. Tasks created from a note with a due time get
  Todoist's automatic reminder if you have that enabled in Todoist.
- Inline lines are snapshots; their due dates are not refreshed.
- Pickers and refresh read at most 500 active tasks; notes for tasks beyond that are
  looked up one by one.
- The daily log uses the core Daily notes settings (no Periodic Notes override), and is
  skipped (with a notice) if today's note does not exist yet.
- Not yet tested inside real Obsidian against the live API.

## Development

No build step and no dependencies: edit `main.js` directly. Before committing:

```
node scripts/check.js
node --test 'test/*.test.js'
```

`scripts/check.js` checks that `main.js` parses, that it is mobile-safe (no `require`
other than `obsidian`, no `fetch`/`XMLHttpRequest`, no Node or Electron APIs), that
`manifest.json` and `versions.json` agree, and that no Todoist token is committed.

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
