'use strict';
/*
 * Task Note Bridge — Todoist stays the alarm clock, Obsidian holds the thinking.
 * Plain JS (no build step). Works on desktop and mobile (uses requestUrl, no Node APIs).
 */
const {
  Plugin, PluginSettingTab, Setting, Notice, FuzzySuggestModal, Modal,
  TFile, normalizePath, requestUrl, moment,
} = require('obsidian');

const API = 'https://api.todoist.com/api/v1';
const LINK_LABEL = '📝 Obsidian note';
const LINK_RE = /\[📝 Obsidian note\]\(obsidian:\/\/[^)\s]*\)/;
const MENTION_LABEL = '💬 Obsidian mention';
const MENTION_RE = /\[💬 Obsidian mention\]\(obsidian:\/\/[^)\s]*\)/;

const DEFAULTS = {
  token: '',
  filter: 'overdue | today',
  folder: 'Tasks',
  fileNameSeparator: '-',
  template: '',
  writeBackLink: true,
  updateLinkOnRename: true,
  logToDaily: true,
  dailyHeading: '## Log',
  refreshOnStartup: true,
  dueLang: 'en',
  writeBackMention: true,
};

// ---------- pure helpers ----------

const FORBIDDEN_RE = /[\\/:*?"<>|#^[\]]/g;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Builds a note file name from a task title. `sep` replaces spaces and
// characters Obsidian can't use in file names; runs of separators collapse to one.
// The result is always lower case.
function sanitizeTitle(s, sep = ' ') {
  sep = String(sep == null ? ' ' : sep).replace(FORBIDDEN_RE, '');
  if (!sep || /^\s+$/.test(sep)) sep = ' ';
  let t = String(s || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links -> text
    .replace(FORBIDDEN_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .trim();
  const e = escapeRegExp(sep);
  if (sep !== ' ') t = t.replace(new RegExp(`(?:\\s|${e})+`, 'g'), sep);
  // No leading/trailing dots or separators: Obsidian hides dot-files (#2).
  t = t.replace(new RegExp(`^(?:\\.|\\s|${e})+|(?:\\.|\\s|${e})+$`, 'g'), '');
  return (t || `untitled${sep}task`).toLowerCase();
}

// Fixed-timezone tasks come back in UTC ("…Z"): convert to local time.
// Floating datetimes and plain dates are already local and kept as-is.
function dueOf(task) {
  const due = task && task.due ? (task.due.datetime || task.due.date || null) : null;
  return due && /Z$/i.test(due) ? moment(due).format('YYYY-MM-DDTHH:mm:ss') : due;
}

function taskUrl(id) {
  return `https://app.todoist.com/app/task/${id}`;
}

// encodeURIComponent leaves ( ) alone, which would break a markdown link.
function encodeUriPart(s) {
  return encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// Removes the first match of re (non-global, so exec keeps no lastIndex). A link alone on
// its line takes the line with it, and the gaps around it become one separator (a blank
// line if either gap had one).
function cutLink(desc, re) {
  const m = re.exec(desc);
  if (!m) return desc;
  const before = desc.slice(0, m.index);
  const after = desc.slice(m.index + m[0].length);
  if (!/(^|\n)[ \t]*$/.test(before) || !/^[ \t]*(\n|$)/.test(after)) return before + after;
  const gapBefore = before.match(/\s*$/)[0];
  const gapAfter = after.match(/^\s*/)[0];
  const b = before.slice(0, before.length - gapBefore.length);
  const a = after.slice(gapAfter.length);
  if (!b || !a) return b + a;
  return b + (/\n[ \t]*\n/.test(gapBefore) || /\n[ \t]*\n/.test(gapAfter) ? '\n\n' : '\n') + a;
}

function stripLink(desc) {
  let d = desc || '';
  for (const re of [LINK_RE, MENTION_RE]) {
    for (let prev; prev !== d;) { prev = d; d = cutLink(d, re); }
  }
  return d.trim();
}

// Replaces every existing match of `re`: the first becomes `link`, the others
// are removed together with the whitespace before them.
function withLink(desc, link, re = LINK_RE) {
  const d = desc || '';
  if (re.test(d)) {
    let first = true;
    return d.replace(new RegExp(`(\\s*)(?:${re.source})`, 'g'), (m, lead) => {
      if (!first) return '';
      first = false;
      return lead + link;
    });
  }
  return d.trim() ? `${d.trimEnd()}\n\n${link}` : link;
}

function insertUnderHeading(data, heading, line) {
  const h = (heading || '').trim();
  if (!data.trim()) return h ? `${h}\n${line}\n` : `${line}\n`;
  if (!h) return `${data.replace(/\s*$/, '')}\n${line}\n`;
  const lines = data.split('\n');
  const idx = lines.findIndex((l) => l.trim() === h);
  if (idx < 0) return `${data.replace(/\s*$/, '')}\n\n${h}\n${line}\n`;
  const level = (h.match(/^#+/) || ['##'])[0].length;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  let at = end;
  while (at > idx + 1 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, line);
  return lines.join('\n');
}

function formatDue(due) {
  return due ? due.replace('T', ' ').slice(0, 16) : '';
}

// Plain inline text: task title linking to Todoist, due date, and the task's note if it has one.
function inlineLine(task, noteLink) {
  const title = String(task.content || 'Untitled task')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/([[\]])/g, '\\$1')
    .replace(/\s+/g, ' ')
    .trim();
  let line = `[${title}](${taskUrl(task.id)})`;
  const due = dueOf(task);
  if (due) line += ` · due ${formatDue(due)}`;
  if (noteLink) line += ` · ${noteLink}`;
  return line;
}

function compareDue(a, b) {
  const da = dueOf(a), db = dueOf(b);
  if (da && db) return da < db ? -1 : da > db ? 1 : 0;
  if (da) return -1;
  if (db) return 1;
  return 0;
}

function renderTemplate(tpl, task) {
  const vals = {
    title: task.content || '',
    description: stripLink(task.description),
    due: dueOf(task) || '',
    url: taskUrl(task.id),
    id: String(task.id),
    date: moment().format('YYYY-MM-DD'),
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : m));
}

function defaultBody(task) {
  const desc = stripLink(task.description);
  const quoted = desc ? desc.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' : '';
  return `# ${task.content}\n\n${quoted}## Context\n\n\n## Notes\n\n`;
}

// ---------- modals ----------

class TaskPicker extends FuzzySuggestModal {
  constructor(app, tasks, notes, onChoose) {
    super(app);
    this.tasks = tasks;
    this.notes = notes;
    this.onChoose = onChoose;
    this.setPlaceholder('Pick a task to open as a note…');
  }
  getItems() { return this.tasks; }
  getItemText(t) { return t.content; }
  renderSuggestion(match, el) {
    const t = match.item;
    el.createDiv({ text: (this.notes.has(String(t.id)) ? '📝 ' : '') + t.content });
    const due = dueOf(t);
    if (due) el.createEl('small', { text: `Due ${formatDue(due)}`, cls: 'tnb-due' });
  }
  onChooseItem(t) { this.onChoose(t); }
}

class NewTaskModal extends Modal {
  constructor(app, title, onSubmit) {
    super(app);
    this.title = title;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('tnb-modal');
    contentEl.createEl('h3', { text: 'Create Todoist task' });
    contentEl.createEl('label', { text: 'Task' });
    const titleIn = contentEl.createEl('input', { type: 'text', value: this.title });
    contentEl.createEl('label', { text: "Due (Todoist's natural language, e.g. 'tomorrow 9am', 'every friday')" });
    const dueIn = contentEl.createEl('input', { type: 'text', placeholder: 'leave empty for no due date' });
    const submit = () => {
      const content = titleIn.value.trim();
      if (!content) return;
      this.close();
      this.onSubmit(content, dueIn.value.trim());
    };
    for (const input of [titleIn, dueIn]) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    }
    new Setting(contentEl).addButton((b) => b.setButtonText('Create').setCta().onClick(submit));
    dueIn.focus();
  }
  onClose() { this.contentEl.empty(); }
}

// ---------- plugin ----------

class TaskNoteBridge extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new BridgeSettingTab(this.app, this));

    const openNote = (t, notes) => this.openTaskNote(t, notes.get(String(t.id)));
    this.addCommand({ id: 'open-task-note', name: 'Open task note (filtered tasks)', callback: () => this.pickTask(false, openNote) });
    this.addCommand({ id: 'open-task-note-all', name: 'Open task note (all tasks)', callback: () => this.pickTask(true, openNote) });
    this.addCommand({
      id: 'insert-task-inline',
      name: 'Insert task inline (filtered tasks)',
      editorCallback: (editor, view) => this.pickTask(false, (t, notes) => this.insertInline(editor, view.file, t, notes)),
    });
    this.addCommand({
      id: 'insert-task-inline-all',
      name: 'Insert task inline (all tasks)',
      editorCallback: (editor, view) => this.pickTask(true, (t, notes) => this.insertInline(editor, view.file, t, notes)),
    });
    this.addCommand({
      id: 'create-task-from-note',
      name: 'Create Todoist task from this note',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md') return false;
        if (!checking) this.createTaskFromNote(f);
        return true;
      },
    });
    this.addCommand({
      id: 'open-in-todoist',
      name: "Open this note's task in Todoist",
      checkCallback: (checking) => {
        const id = this.taskIdOf(this.app.workspace.getActiveFile());
        if (!id) return false;
        if (!checking) window.open(taskUrl(id));
        return true;
      },
    });
    this.addCommand({ id: 'refresh-task-notes', name: 'Refresh all task notes from Todoist', callback: () => this.refreshAll(true) });

    this.addRibbonIcon('square-check', 'Open task note', () => this.pickTask(false, openNote));
    this.registerEvent(this.app.vault.on('rename', (file) => this.onRename(file)));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.refreshOnStartup && this.settings.token) this.refreshAll(false);
    });
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULTS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  // ----- Todoist API -----

  async api(method, path, body) {
    if (!this.settings.token) throw new Error('Set your Todoist API token in the plugin settings first.');
    const headers = { Authorization: `Bearer ${this.settings.token}` };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await requestUrl({
      url: API + path, method, headers,
      body: body ? JSON.stringify(body) : undefined,
      throw: false,
    });
    if (res.status >= 400) {
      const err = new Error(`Todoist API ${res.status}: ${(res.text || '').slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204 || !res.text) return null;
    return res.json;
  }

  async paginate(path, params) {
    const out = [];
    let cursor = null;
    do {
      const q = Object.entries(Object.assign({}, params, { limit: '200' }, cursor ? { cursor } : {}))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      const res = await this.api('GET', `${path}?${q}`);
      out.push(...((res && res.results) || []));
      cursor = res && res.next_cursor;
    } while (cursor);
    return out;
  }

  // ----- vault helpers -----

  taskIdOf(file) {
    if (!(file instanceof TFile)) return null;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return fm && fm.todoist_id != null ? String(fm.todoist_id) : null;
  }

  noteIndex() {
    const map = new Map();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const id = this.taskIdOf(f);
      if (id && !map.has(id)) map.set(id, f);
    }
    return map;
  }

  noteUri(file) {
    return `obsidian://open?vault=${encodeUriPart(this.app.vault.getName())}&file=${encodeUriPart(file.path)}`;
  }

  fail(e) {
    console.error('[Task Note Bridge]', e);
    new Notice(`Task Note Bridge: ${e.message}`, 8000);
  }

  // ----- main flow -----

  async pickTask(all, onChoose) {
    if (!this.settings.token) { new Notice('Set your Todoist API token in the plugin settings first.'); return; }
    const loading = new Notice('Loading Todoist tasks…', 0);
    let tasks;
    try {
      tasks = all
        ? await this.paginate('/tasks', {})
        : await this.paginate('/tasks/filter', { query: this.settings.filter || 'today' });
    } catch (e) {
      loading.hide();
      this.fail(e);
      return;
    }
    loading.hide();
    if (!tasks.length) { new Notice('No tasks match.'); return; }
    tasks.sort(compareDue);
    const notes = this.noteIndex();
    new TaskPicker(this.app, tasks, notes, (t) => onChoose(t, notes)).open();
  }

  async insertInline(editor, file, task, notes) {
    const note = notes.get(String(task.id));
    const noteLink = note && file ? this.app.fileManager.generateMarkdownLink(note, file.path) : '';
    editor.replaceSelection(inlineLine(task, noteLink));
    editor.focus();

    if (this.settings.writeBackMention && file) {
      try {
        const next = withLink(task.description, `[${MENTION_LABEL}](${this.noteUri(file)})`, MENTION_RE);
        if (next !== (task.description || '')) await this.api('POST', `/tasks/${task.id}`, { description: next });
      } catch (e) {
        this.fail(e);
      }
    }
  }

  async openTaskNote(task, existing) {
    try {
      let file = existing;
      if (!file) file = await this.createNote(task);
      else await this.syncFrontmatter(file, task);
      await this.app.workspace.getLeaf(false).openFile(file);
      if (this.settings.writeBackLink) await this.writeBackLink(task, file, false);
      if (this.settings.logToDaily) await this.logToDaily(file);
    } catch (e) {
      this.fail(e);
    }
  }

  async createNote(task) {
    const raw = normalizePath(this.settings.folder || '/');
    const prefix = raw && raw !== '/' ? `${raw}/` : '';
    if (prefix && !this.app.vault.getAbstractFileByPath(raw)) await this.app.vault.createFolder(raw);

    const sep = this.settings.fileNameSeparator;
    const base = sanitizeTitle(task.content, sep);
    let path = normalizePath(`${prefix}${base}.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) {
      path = normalizePath(`${prefix}${sanitizeTitle(`${base} ${i}`, sep)}.md`);
    }

    let body = defaultBody(task);
    if (this.settings.template) {
      const tplPath = normalizePath(this.settings.template.endsWith('.md') ? this.settings.template : `${this.settings.template}.md`);
      const tpl = this.app.vault.getAbstractFileByPath(tplPath);
      if (tpl instanceof TFile) body = renderTemplate(await this.app.vault.read(tpl), task);
      else new Notice(`Template not found: ${tplPath} — using the default layout.`);
    }

    const file = await this.app.vault.create(path, body);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.todoist_id = String(task.id);
      fm.todoist_url = taskUrl(task.id);
      const due = dueOf(task);
      if (due) fm.due = due; else delete fm.due;
      fm.todoist_status = 'open';
      if (!fm.created) fm.created = moment().format('YYYY-MM-DD');
    });
    return file;
  }

  // Only writes when something changed, so startup refreshes don't churn your sync/git.
  async syncFrontmatter(file, task) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const status = task ? 'open' : 'closed';
    const due = task ? dueOf(task) : (fm.due ?? null);
    const curDue = fm.due ?? null;
    if (fm.todoist_status === status && String(curDue) === String(due)) return false;
    await this.app.fileManager.processFrontMatter(file, (f) => {
      f.todoist_status = status;
      if (due) f.due = due; else delete f.due;
    });
    return true;
  }

  async writeBackLink(task, file, onlyIfPresent) {
    const desc = task.description || '';
    if (onlyIfPresent && !LINK_RE.test(desc)) return;
    const next = withLink(desc, `[${LINK_LABEL}](${this.noteUri(file)})`);
    if (next !== desc) await this.api('POST', `/tasks/${task.id}`, { description: next });
  }

  async onRename(file) {
    if (!this.settings.updateLinkOnRename || !this.settings.token) return;
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    const id = this.taskIdOf(file);
    if (!id) return;
    try {
      const task = await this.api('GET', `/tasks/${id}`);
      if (task && !task.checked) await this.writeBackLink(task, file, true);
    } catch (e) {
      if (e.status !== 404) console.warn('[Task Note Bridge] rename sync failed', e);
    }
  }

  async refreshAll(verbose) {
    const notes = this.noteIndex();
    if (!notes.size) { if (verbose) new Notice('No task notes found.'); return; }
    let tasks;
    try {
      tasks = await this.paginate('/tasks', {});
    } catch (e) {
      if (verbose) this.fail(e); else console.warn('[Task Note Bridge] refresh failed', e);
      return;
    }
    const byId = new Map(tasks.map((t) => [String(t.id), t]));
    let changed = 0;
    for (const [id, file] of notes) {
      if (await this.syncFrontmatter(file, byId.get(id) || null)) changed++;
    }
    if (verbose) new Notice(`Task notes refreshed (${changed} updated).`);
  }

  async createTaskFromNote(file) {
    if (this.taskIdOf(file)) { new Notice('This note is already linked to a Todoist task.'); return; }
    new NewTaskModal(this.app, file.basename, async (content, dueString) => {
      try {
        const body = { content, description: `[${LINK_LABEL}](${this.noteUri(file)})` };
        if (dueString) { body.due_string = dueString; body.due_lang = this.settings.dueLang || 'en'; }
        const task = await this.api('POST', '/tasks', body);
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          fm.todoist_id = String(task.id);
          fm.todoist_url = taskUrl(task.id);
          const due = dueOf(task);
          if (due) fm.due = due;
          fm.todoist_status = 'open';
        });
        const due = dueOf(task);
        new Notice(due ? `Task created, due ${due}.` : 'Task created (no due date).');
      } catch (e) {
        this.fail(e);
      }
    }).open();
  }

  async logToDaily(file) {
    const dn = this.app.internalPlugins?.getPluginById?.('daily-notes');
    const opts = dn?.instance?.options || {};
    const folder = (opts.folder || '').trim();
    const path = normalizePath(`${folder ? `${folder}/` : ''}${moment().format(opts.format || 'YYYY-MM-DD')}.md`);
    const daily = this.app.vault.getAbstractFileByPath(path);
    if (!(daily instanceof TFile)) {
      new Notice("Today's daily note doesn't exist yet, so this wasn't logged.");
      return;
    }
    if (daily.path === file.path) return;
    const link = this.app.fileManager.generateMarkdownLink(file, daily.path);
    await this.app.vault.process(daily, (data) =>
      data.includes(link) ? data : insertUnderHeading(data, this.settings.dailyHeading, `- ${moment().format('HH:mm')} ${link}`));
  }
}

// ---------- settings ----------

class BridgeSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();

    new Setting(containerEl)
      .setName('Todoist API token')
      .setDesc('Todoist → Settings → Integrations → Developer. Stored in this plugin\'s data.json.')
      .addText((t) => { t.inputEl.type = 'password'; t.setValue(s.token).onChange(async (v) => { s.token = v.trim(); await save(); }); })
      .addButton((b) => b.setButtonText('Test').onClick(async () => {
        try { await this.plugin.api('GET', '/tasks/filter?query=today&limit=1'); new Notice('Connected to Todoist ✔'); }
        catch (e) { this.plugin.fail(e); }
      }));

    new Setting(containerEl).setName('Task filter')
      .setDesc('Todoist filter used by "Open task note (filtered tasks)". Examples: "overdue | today", "7 days | overdue".')
      .addText((t) => t.setValue(s.filter).onChange(async (v) => { s.filter = v; await save(); }));

    new Setting(containerEl).setName('Task notes folder')
      .addText((t) => t.setValue(s.folder).onChange(async (v) => { s.folder = v.trim(); await save(); }));

    new Setting(containerEl).setName('File name separator')
      .setDesc('Replaces spaces and characters not allowed in file names when naming a new task note (e.g. "-" gives "fix-the-printer.md"; names are always lower case). Leave empty to keep spaces. Existing notes are not renamed.')
      .addText((t) => t.setPlaceholder('-').setValue(s.fileNameSeparator).onChange(async (v) => { s.fileNameSeparator = v; await save(); }));

    new Setting(containerEl).setName('Note template (optional)')
      .setDesc('Path to a note used as template. Placeholders: {{title}} {{description}} {{due}} {{url}} {{id}} {{date}}.')
      .addText((t) => t.setPlaceholder('Templates/Task note').setValue(s.template).onChange(async (v) => { s.template = v.trim(); await save(); }));

    new Setting(containerEl).setName('Write note link back into the task')
      .setDesc('Adds a "📝 Obsidian note" link to the Todoist task description.')
      .addToggle((t) => t.setValue(s.writeBackLink).onChange(async (v) => { s.writeBackLink = v; await save(); }));

    new Setting(containerEl).setName('Fix the link when a note is renamed or moved')
      .addToggle((t) => t.setValue(s.updateLinkOnRename).onChange(async (v) => { s.updateLinkOnRename = v; await save(); }));

    new Setting(containerEl).setName('Log to daily note')
      .setDesc('When you open a task note, add a timestamped link to today\'s daily note (once per day).')
      .addToggle((t) => t.setValue(s.logToDaily).onChange(async (v) => { s.logToDaily = v; await save(); }));

    new Setting(containerEl).setName('Daily note heading')
      .setDesc('Links go at the end of this section; it\'s created if missing. Leave empty to append at the end.')
      .addText((t) => t.setValue(s.dailyHeading).onChange(async (v) => { s.dailyHeading = v; await save(); }));

    new Setting(containerEl).setName('Write mention link back into the task')
      .setDesc('When you insert a task inline, add a "💬 Obsidian mention" link to the task pointing at that note (replaces the previous mention link).')
      .addToggle((t) => t.setValue(s.writeBackMention).onChange(async (v) => { s.writeBackMention = v; await save(); }));

    new Setting(containerEl).setName('Refresh task notes on startup')
      .setDesc('Updates due dates and open/closed status in the notes\' properties.')
      .addToggle((t) => t.setValue(s.refreshOnStartup).onChange(async (v) => { s.refreshOnStartup = v; await save(); }));

    new Setting(containerEl).setName('Due date language')
      .setDesc('Language of the natural-language due dates you type (e.g. en, fr).')
      .addText((t) => t.setValue(s.dueLang).onChange(async (v) => { s.dueLang = v.trim() || 'en'; await save(); }));
  }
}

TaskNoteBridge._test = { inlineLine, MENTION_RE, sanitizeTitle, withLink, stripLink, insertUnderHeading, encodeUriPart, compareDue, renderTemplate };
module.exports = TaskNoteBridge;
