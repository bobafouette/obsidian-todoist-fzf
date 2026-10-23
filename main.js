'use strict';
/*
 * Todoist fzf: Todoist stays the alarm clock, Obsidian holds the thinking.
 * Plain JS (no build step). Works on desktop and mobile (uses requestUrl, no Node APIs).
 */
const {
  Plugin, PluginSettingTab, Setting, Notice, FuzzySuggestModal, Modal,
  TFile, normalizePath, requestUrl, moment,
} = require('obsidian');

const PLUGIN_NAME = 'Todoist fzf';
const API = 'https://api.todoist.com/api/v1';
const LINK_LABEL = '📝 Obsidian note';
const LINK_RE = /\[📝 Obsidian note\]\(obsidian:\/\/[^)\s]*\)/;
const MENTION_LABEL = '💬 Obsidian mention';
const MENTION_RE = /\[💬 Obsidian mention\]\(obsidian:\/\/[^)\s]*\)/;
const NAME_MAX = 100;
const PAGE_LIMIT = 200;
const FETCH_CAP = 500;

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

const MSG_TOKEN = 'Set your Todoist API token in the plugin settings first.';
const MSG_LOADING = 'Loading Todoist tasks…';
const MSG_NO_TASKS = 'No tasks match.';
const MSG_NO_NOTES = 'No task notes found.';
const MSG_NO_DAILY = "Today's daily note doesn't exist yet, so this wasn't logged.";
const MSG_ALREADY_LINKED = 'This note is already linked to a Todoist task.';
const MSG_CONNECTED = 'Connected to Todoist ✔';
const MSG_AUTH = 'Todoist rejected the API token (check it in the settings)';
const MSG_OFFLINE = "Can't reach Todoist (check your connection)";
const MSG_BAD_RESPONSE = 'Unexpected response from Todoist';

// ---------- pure helpers ----------

const FORBIDDEN_RE = /[\\/:*?"<>|#^[\]]/g;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Cuts to at most `max` UTF-16 units without splitting a character (emoji stay whole).
function truncate(s, max) {
  if (s.length <= max) return s;
  let cut = '';
  for (const ch of s) {
    if (cut.length + ch.length > max) break;
    cut += ch;
  }
  return cut;
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
    .trim();
  t = truncate(t, NAME_MAX).trim();
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

// True if `needle` appears in the section under `heading` (up to the next heading
// of the same or a higher level). An empty heading means the whole note.
function sectionContains(data, heading, needle) {
  const text = String(data);
  const want = (heading || '').trim();
  if (!want) return text.includes(needle);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === want);
  if (start === -1) return false;
  const level = (want.match(/^#+/) || [''])[0].length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) break;
    if (lines[i].includes(needle)) return true;
  }
  return false;
}

// Path of the daily note for moment `m`, from the core Daily notes options.
function dailyNotePath(options, m) {
  const o = options || {};
  const folder = String(o.folder || '').trim();
  return normalizePath(`${folder ? `${folder}/` : ''}${m.format(o.format || 'YYYY-MM-DD')}.md`);
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

function stripFrontmatter(s) {
  return String(s).replace(/^---\r?\n(?:[\s\S]*?\r?\n)??---[ \t]*(?:\r?\n|$)/, '');
}

function defaultBody(task) {
  const desc = stripLink(task.description);
  const quoted = desc ? desc.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' : '';
  return `# ${task.content}\n\n${quoted}## Context\n\n\n## Notes\n\n`;
}

// Every property the plugin keeps in a task note. A null value means "remove the key".
function noteProps(task, status = 'open') {
  return {
    todoist_id: String(task.id),
    todoist_url: taskUrl(task.id),
    todoist_title: task.content || null,
    due: dueOf(task) || null,
    todoist_status: status,
  };
}

// The subset of `props` whose value differs from the frontmatter (null, undefined
// and '' are all "absent").
function propsDiff(fm, props) {
  const norm = (v) => (v == null ? '' : String(v));
  const out = {};
  for (const k of Object.keys(props)) {
    if (norm(fm && fm[k]) !== norm(props[k])) out[k] = props[k];
  }
  return out;
}

function applyProps(fm, props) {
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === '') delete fm[k]; else fm[k] = v;
  }
}

function idOf(fm) {
  const v = fm && fm.todoist_id;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

// todoist_id -> every note that carries it, sorted by path (duplicates are kept).
function indexNotes(files, fmOf) {
  const map = new Map();
  for (const f of files) {
    const id = idOf(fmOf(f));
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(f);
  }
  for (const list of map.values()) list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return map;
}

// ---------- Todoist client ----------

class TodoistError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TodoistError';
    this.status = status;
  }
}

// Follows next_cursor until the last page, keeping at most `cap` results.
async function paginate(fetchPage, cap = FETCH_CAP) {
  const out = [];
  let cursor;
  for (;;) {
    const page = await fetchPage(cursor);
    out.push(...((page && page.results) || []));
    if (out.length >= cap) return out.slice(0, cap);
    if (!page || !page.next_cursor) return out;
    cursor = page.next_cursor;
  }
}

function readJson(res) {
  try {
    return res.json;
  } catch (e) {
    return undefined;
  }
}

function readText(res) {
  try {
    return typeof res.text === 'string' ? res.text : '';
  } catch (e) {
    return '';
  }
}

class TodoistClient {
  constructor({ token }, request = requestUrl) {
    this.token = token;
    this.request = request;
  }

  async call(method, path, params, body) {
    let url = API + path;
    if (params) {
      const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
      if (q) url += `?${q}`;
    }
    const headers = { Authorization: `Bearer ${this.token}` };
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await this.request({
        url, method, headers,
        body: body ? JSON.stringify(body) : undefined,
        throw: false,
      });
    } catch (e) {
      throw new TodoistError(MSG_OFFLINE, 0);
    }
    const status = res && res.status;
    if (status >= 200 && status < 300) {
      if (status === 204 || !readText(res)) return null;
      const data = readJson(res);
      if (data === undefined) throw new TodoistError(MSG_BAD_RESPONSE, status);
      return data;
    }
    if (status === 401 || status === 403) throw new TodoistError(MSG_AUTH, status);
    const json = readJson(res);
    const detail = json && typeof json.error === 'string' && json.error.trim()
      ? json.error.trim()
      : readText(res).trim().slice(0, 200);
    throw new TodoistError(`Todoist API ${status}${detail ? `: ${detail}` : ''}`, status);
  }

  get(path, params) { return this.call('GET', path, params); }
  post(path, body) { return this.call('POST', path, undefined, body); }

  list(path, params, cap = FETCH_CAP) {
    return paginate((cursor) => this.get(path, Object.assign({}, params, { limit: PAGE_LIMIT, cursor })), cap);
  }

  tasks() { return this.list('/tasks'); }
  filter(query) { return this.list('/tasks/filter', { query }); }

  // The task, or null when Todoist answers 404 (deleted or unknown).
  async task(id) {
    try {
      return await this.get(`/tasks/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof TodoistError && e.status === 404) return null;
      throw e;
    }
  }

  updateTask(id, fields) { return this.post(`/tasks/${encodeURIComponent(id)}`, fields); }
  createTask(fields) { return this.post('/tasks', fields); }
  ping() { return this.get('/tasks/filter', { query: 'today', limit: 1 }); }
}

// Properties for a note whose task is not among the active tasks, from GET /tasks/{id}.
// 404 or is_deleted: missing (only the status changes). Completed: closed.
function propsForLookup(task) {
  if (!task || task.is_deleted) return { todoist_status: 'missing' };
  return noteProps(task, task.checked ? 'closed' : 'open');
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
  onChooseItem(t) { return this.onChoose(t); }
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

    const openNote = (t, notes) => this.openTaskNote(t, (notes.get(String(t.id)) || [])[0]);
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
      if (!this.settings.refreshOnStartup || !this.settings.token) return;
      // Startup refresh is silent on failure.
      this.refreshAll(false).catch((e) => console.warn(`[${PLUGIN_NAME}] refresh failed`, e));
    });
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULTS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  // A client for the current token, or null (with a notice unless quiet) if none is set.
  client(quiet = false) {
    const token = String(this.settings.token || '').trim();
    if (!token) {
      if (!quiet) new Notice(MSG_TOKEN);
      return null;
    }
    return new TodoistClient({ token });
  }

  // ----- vault helpers -----

  frontmatter(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    return cache && cache.frontmatter;
  }

  taskIdOf(file) {
    if (!(file instanceof TFile)) return null;
    return idOf(this.frontmatter(file));
  }

  notesIndex() {
    return indexNotes(this.app.vault.getMarkdownFiles(), (f) => this.frontmatter(f));
  }

  noteUri(file) {
    return `obsidian://open?vault=${encodeUriPart(this.app.vault.getName())}&file=${encodeUriPart(file.path)}`;
  }

  fail(e) {
    console.error(`[${PLUGIN_NAME}]`, e);
    new Notice(`${PLUGIN_NAME}: ${(e && e.message) || e}`, 8000);
  }

  // Writes only the properties whose value changed, so refreshes don't churn sync.
  async syncProps(file, props) {
    const diff = propsDiff(this.frontmatter(file), props);
    if (!Object.keys(diff).length) return false;
    await this.app.fileManager.processFrontMatter(file, (fm) => applyProps(fm, diff));
    return true;
  }

  // ----- main flow -----

  async pickTask(all, onChoose) {
    const client = this.client();
    if (!client) return;
    const loading = new Notice(MSG_LOADING, 0);
    let tasks;
    try {
      tasks = all ? await client.tasks() : await client.filter(this.settings.filter || 'today');
    } catch (e) {
      loading.hide();
      this.fail(e);
      return;
    }
    loading.hide();
    if (!tasks.length) { new Notice(MSG_NO_TASKS); return; }
    tasks.sort(compareDue);
    const notes = this.notesIndex();
    new TaskPicker(this.app, tasks, notes, (t) => onChoose(t, notes)).open();
  }

  async insertInline(editor, file, task, notes) {
    const note = (notes.get(String(task.id)) || [])[0];
    const noteLink = note && file ? this.app.fileManager.generateMarkdownLink(note, file.path) : '';
    editor.replaceSelection(inlineLine(task, noteLink));
    if (typeof editor.focus === 'function') editor.focus();

    if (this.settings.writeBackMention && file) {
      try {
        const next = withLink(task.description, `[${MENTION_LABEL}](${this.noteUri(file)})`, MENTION_RE);
        const client = this.client();
        if (client && next !== (task.description || '')) await client.updateTask(task.id, { description: next });
      } catch (e) {
        this.fail(e);
      }
    }
  }

  // Opens the task's note, creating it (and logging it in today's daily note) if needed.
  // The back-link and the log are independent: one failing doesn't skip the other.
  async openTaskNote(task, existing) {
    let file = existing;
    if (file) {
      try { await this.syncProps(file, noteProps(task)); } catch (e) { this.fail(e); }
    } else {
      try { file = await this.createNote(task); } catch (e) { this.fail(e); return; }
      try { await this.logToDaily(file); } catch (e) { this.fail(e); }
    }
    try { await this.app.workspace.getLeaf(false).openFile(file); } catch (e) { this.fail(e); }
    if (this.settings.writeBackLink) {
      try { await this.writeBackLink(task, file, false); } catch (e) { this.fail(e); }
    }
  }

  async createNote(task) {
    const { vault, fileManager } = this.app;
    const raw = normalizePath(this.settings.folder || '/');
    const prefix = raw && raw !== '/' ? `${raw}/` : '';
    if (prefix && !vault.getAbstractFileByPath(raw)) await vault.createFolder(raw);

    const sep = this.settings.fileNameSeparator;
    const base = sanitizeTitle(task.content, sep);
    let path = normalizePath(`${prefix}${base}.md`);
    for (let i = 2; vault.getAbstractFileByPath(path); i++) {
      path = normalizePath(`${prefix}${sanitizeTitle(`${base} ${i}`, sep)}.md`);
    }

    let body = defaultBody(task);
    const tplName = String(this.settings.template || '').trim();
    if (tplName) {
      const tplPath = normalizePath(/\.md$/i.test(tplName) ? tplName : `${tplName}.md`);
      const tpl = vault.getAbstractFileByPath(tplPath);
      if (tpl instanceof TFile) body = renderTemplate(await vault.read(tpl), task);
      else new Notice(`Template not found: ${tplPath} — using the default layout.`);
    }

    // The template's own frontmatter is kept; the plugin's keys are merged into it.
    const file = await vault.create(path, body);
    const setProps = () => fileManager.processFrontMatter(file, (fm) => {
      applyProps(fm, noteProps(task));
      if (!fm.created) fm.created = moment().format('YYYY-MM-DD');
    });
    try {
      await setProps();
    } catch (e) {
      // Rendered template frontmatter that isn't valid YAML: drop it and retry.
      const stripped = stripFrontmatter(body);
      if (stripped === body) throw e;
      new Notice(`${PLUGIN_NAME}: the template's properties aren't valid YAML once filled in, so they were dropped.`, 8000);
      await vault.modify(file, stripped);
      await setProps();
    }
    return file;
  }

  async writeBackLink(task, file, onlyIfPresent) {
    const desc = task.description || '';
    if (onlyIfPresent && !LINK_RE.test(desc)) return;
    const next = withLink(desc, `[${LINK_LABEL}](${this.noteUri(file)})`);
    if (next === desc) return;
    const client = this.client();
    if (client) await client.updateTask(task.id, { description: next });
  }

  async onRename(file) {
    if (!this.settings.updateLinkOnRename) return;
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    const id = this.taskIdOf(file);
    const client = id && this.client(true);
    if (!client) return;
    try {
      const task = await client.task(id);
      if (task && !task.checked && !task.is_deleted) await this.writeBackLink(task, file, true);
    } catch (e) {
      console.warn(`[${PLUGIN_NAME}] rename sync failed`, e);
    }
  }

  // Updates every task note (duplicates included). Active tasks come from one listing;
  // a note whose task isn't active and that isn't already closed/missing is looked up
  // on its own: completed -> closed, 404 or deleted -> missing.
  async refreshAll(verbose) {
    const client = this.client(!verbose);
    if (!client) return;
    const index = this.notesIndex();
    if (!index.size) { if (verbose) new Notice(MSG_NO_NOTES); return; }
    let tasks;
    try {
      tasks = await client.tasks();
    } catch (e) {
      if (verbose) this.fail(e); else console.warn(`[${PLUGIN_NAME}] refresh failed`, e);
      return;
    }
    const active = new Map(tasks.map((t) => [String(t.id), t]));
    let changed = 0;
    let failed = 0;
    for (const [id, files] of index) {
      let props;
      if (active.has(id)) {
        props = noteProps(active.get(id));
      } else {
        const settled = files.every((f) => {
          const s = (this.frontmatter(f) || {}).todoist_status;
          return s === 'closed' || s === 'missing';
        });
        if (settled) continue;
        try {
          props = propsForLookup(await client.task(id));
        } catch (e) {
          failed += files.length;
          console.warn(`[${PLUGIN_NAME}] refresh of task ${id} failed`, e);
          continue;
        }
      }
      for (const file of files) {
        try {
          if (await this.syncProps(file, props)) changed++;
        } catch (e) {
          failed++;
          console.warn(`[${PLUGIN_NAME}] refresh of ${file.path} failed`, e);
        }
      }
    }
    if (verbose) new Notice(`Task notes refreshed (${changed} updated${failed ? `, ${failed} failed` : ''}).`);
  }

  async createTaskFromNote(file) {
    if (this.taskIdOf(file)) { new Notice(MSG_ALREADY_LINKED); return; }
    const client = this.client();
    if (!client) return;
    new NewTaskModal(this.app, file.basename, async (content, dueString) => {
      try {
        const body = { content, description: `[${LINK_LABEL}](${this.noteUri(file)})` };
        if (dueString) { body.due_string = dueString; body.due_lang = this.settings.dueLang || 'en'; }
        const task = await client.createTask(body);
        await this.app.fileManager.processFrontMatter(file, (fm) => applyProps(fm, noteProps(task)));
        const due = dueOf(task);
        new Notice(due ? `Task created, due ${due}.` : 'Task created (no due date).');
      } catch (e) {
        this.fail(e);
      }
    }).open();
  }

  dailyNoteFile() {
    const ip = this.app.internalPlugins;
    const dn = ip && ip.getPluginById && ip.getPluginById('daily-notes');
    const options = dn && dn.instance && dn.instance.options;
    const file = this.app.vault.getAbstractFileByPath(dailyNotePath(options, moment()));
    return file instanceof TFile ? file : null;
  }

  async logToDaily(file) {
    if (!this.settings.logToDaily) return;
    const daily = this.dailyNoteFile();
    if (!daily) { new Notice(MSG_NO_DAILY); return; }
    if (daily.path === file.path) return;
    const heading = this.settings.dailyHeading;
    const link = this.app.fileManager.generateMarkdownLink(file, daily.path);
    const line = `- ${moment().format('HH:mm')} ${link}`;
    await this.app.vault.process(daily, (data) =>
      (sectionContains(data, heading, link) ? data : insertUnderHeading(data, heading, line)));
  }
}

// ---------- settings ----------

class BridgeSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    const s = plugin.settings;
    const save = () => plugin.saveSettings();
    containerEl.empty();

    const text = (name, desc, key, placeholder, transform = (v) => v) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) => t
        .setPlaceholder(placeholder)
        .setValue(s[key])
        .onChange(async (v) => { s[key] = transform(v); await save(); }));
    const toggle = (name, desc, key) =>
      new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) => t
        .setValue(s[key])
        .onChange(async (v) => { s[key] = v; await save(); }));
    const trim = (v) => v.trim();

    new Setting(containerEl)
      .setName('Todoist API token')
      .setDesc('Todoist → Settings → Integrations → Developer. Stored in plain text in this plugin\'s data.json.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setValue(s.token).onChange(async (v) => { s.token = v.trim(); await save(); });
      })
      .addButton((b) => b.setButtonText('Test').onClick(async () => {
        const client = plugin.client();
        if (!client) return;
        try { await client.ping(); new Notice(MSG_CONNECTED); } catch (e) { plugin.fail(e); }
      }));

    text('Task filter', 'Todoist filter used by the "filtered tasks" commands. Examples: "overdue | today", "7 days | overdue".',
      'filter', DEFAULTS.filter);
    text('Task notes folder', 'Where new task notes are created.', 'folder', DEFAULTS.folder, trim);
    text('File name separator', 'Replaces spaces and characters not allowed in file names when naming a new task note (e.g. "-" gives "fix-the-printer.md"; names are always lower case). Leave empty to keep spaces. Existing notes are not renamed.',
      'fileNameSeparator', '-');
    text('Note template (optional)', 'Path to a note used as template. Placeholders: {{title}} {{description}} {{due}} {{url}} {{id}} {{date}}. Its properties are kept and merged with the plugin\'s.',
      'template', 'Templates/Task note', trim);
    toggle('Write note link back into the task', 'Adds a "📝 Obsidian note" link to the Todoist task description.', 'writeBackLink');
    toggle('Fix the link when a note is renamed or moved', 'Updates the "📝 Obsidian note" link in Todoist, if the task has one.', 'updateLinkOnRename');
    toggle('Log to daily note', 'When a task note is created, add a timestamped link to today\'s daily note.', 'logToDaily');
    text('Daily note heading', 'Links go at the end of this section; it\'s created if missing. Leave empty to append at the end.',
      'dailyHeading', DEFAULTS.dailyHeading);
    toggle('Write mention link back into the task', 'When you insert a task inline, add a "💬 Obsidian mention" link to the task pointing at that note (replaces the previous mention link).',
      'writeBackMention');
    toggle('Refresh task notes on startup', 'Updates title, due date and status in the notes\' properties.', 'refreshOnStartup');
    text('Due date language', 'Language of the natural-language due dates you type (e.g. en, fr).', 'dueLang', 'en',
      (v) => v.trim() || 'en');
  }
}

TaskNoteBridge._test = {
  PLUGIN_NAME, DEFAULTS, MENTION_RE, LINK_RE,
  truncate, sanitizeTitle, dueOf, taskUrl, encodeUriPart, withLink, stripLink, insertUnderHeading,
  sectionContains, dailyNotePath, inlineLine, compareDue, renderTemplate, stripFrontmatter, defaultBody,
  noteProps, propsDiff, applyProps, indexNotes, propsForLookup,
  TodoistError, paginate, TodoistClient, TaskPicker, NewTaskModal, BridgeSettingTab,
};
module.exports = TaskNoteBridge;
