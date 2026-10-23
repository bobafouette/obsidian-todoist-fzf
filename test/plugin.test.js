'use strict';
process.env.TZ = 'Europe/Paris';
const test = require('node:test');
const assert = require('node:assert/strict');
const stub = require('./obsidian-stub');
const {
  TaskNoteBridge, TaskPicker, BridgeSettingTab, NewTaskModal, DEFAULTS, TodoistError,
  truncate, sanitizeTitle, dailyNotePath, sectionContains, noteProps, propsDiff, applyProps,
  indexNotes, propsForLookup, stripFrontmatter,
} = require('./load-plugin');

const eq = assert.equal;
const deepEq = assert.deepEqual;
const ok = assert.ok;

const manifest = { id: 'task-note-bridge' };
const url = (id) => `https://app.todoist.com/app/task/${id}`;
const today = () => stub.moment().format('YYYY-MM-DD');
const DAILY = () => `Daily/${today()}.md`;

function mkFile(path) {
  const f = new stub.TFile();
  f.path = path;
  f.name = path.split('/').pop();
  f.basename = f.name.replace(/\.md$/, '');
  f.extension = 'md';
  return f;
}

// A tiny YAML subset: `key: value` lines. Unquoted values containing ": " are
// rejected, like a real YAML parser would.
const FM_RE = /^---\n([\s\S]*?)\n?---\n?/;
function parseYaml(src) {
  const out = {};
  for (const line of src.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) throw new Error('YAML: bad line ' + line);
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    else if (v.includes(': ')) throw new Error('YAML: nested mapping in ' + line);
    out[m[1]] = v;
  }
  return out;
}
const toYaml = (fm) => '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n';

// In-memory vault: files (path -> TFile), contents, frontmatter, folders.
function fakeApp({ files = {}, fm = {}, folders = [], daily = { folder: 'Daily', format: 'YYYY-MM-DD' } } = {}) {
  const store = { files: new Map(), data: new Map(), fm: new Map(), folders: new Set(folders), opened: [], log: [] };
  for (const [path, content] of Object.entries(files)) {
    store.files.set(path, mkFile(path));
    store.data.set(path, content);
  }
  for (const [path, f] of Object.entries(fm)) store.fm.set(path, { ...f });
  return {
    store,
    workspace: {
      onLayoutReady: (f) => f(),
      active: null,
      getActiveFile() { return this.active; },
      getLeaf: () => ({ openFile: async (file) => { store.opened.push(file.path); } }),
    },
    metadataCache: {
      getFileCache: (f) => (store.fm.has(f.path) ? { frontmatter: store.fm.get(f.path) } : {}),
    },
    vault: {
      getName: () => 'Vault',
      on: (name, cb) => ({ name, cb }),
      getMarkdownFiles: () => [...store.files.values()],
      getAbstractFileByPath: (p) => store.files.get(p) || (store.folders.has(p) ? new stub.TFolder() : null),
      createFolder: async (p) => { store.log.push('createFolder ' + p); store.folders.add(p); },
      create: async (p, content) => {
        if (store.files.has(p)) throw new Error('File already exists');
        const f = mkFile(p);
        store.files.set(p, f); store.data.set(p, content); store.log.push('create ' + p);
        return f;
      },
      modify: async (f, content) => { store.data.set(f.path, content); store.log.push('modify ' + f.path); },
      read: async (f) => store.data.get(f.path),
      process: async (f, fn) => { const out = fn(store.data.get(f.path)); store.data.set(f.path, out); return out; },
    },
    fileManager: {
      processFrontMatter: async (f, fn) => {
        if (store.failFm && store.failFm.has(f.path)) throw new Error('locked');
        const content = store.data.get(f.path) || '';
        const m = content.match(FM_RE);
        const fm = m ? parseYaml(m[1]) : { ...(store.fm.get(f.path) || {}) };
        fn(fm);
        store.fm.set(f.path, fm);
        store.data.set(f.path, toYaml(fm) + (m ? content.slice(m[0].length) : content));
        store.log.push('fm ' + f.path);
      },
      generateMarkdownLink: (f) => '[[' + f.basename + ']]',
    },
    internalPlugins: {
      getPluginById: (id) => (id === 'daily-notes' && daily ? { instance: { options: daily } } : null),
    },
  };
}

function fakeClient(over = {}) {
  const calls = [];
  const rec = (name, fn) => async (...args) => { calls.push([name, ...args]); return fn ? fn(...args) : null; };
  return {
    calls,
    tasks: rec('tasks', over.tasks || (() => [])),
    filter: rec('filter', over.filter || (() => [])),
    task: rec('task', over.task || (() => null)),
    updateTask: rec('updateTask', over.updateTask),
    createTask: rec('createTask', over.createTask),
    ping: rec('ping', over.ping),
  };
}

async function plugin(appOpts = {}, settings = {}, client) {
  const app = fakeApp(appOpts);
  const p = new TaskNoteBridge(app, manifest);
  p.loadData = async () => ({ refreshOnStartup: false, token: 'tok', ...settings });
  p.saveData = async (d) => { p.saved = d; };
  await p.onload();
  if (client) p.client = () => client;
  return p;
}

function captureNotices() {
  stub.Notice.log = [];
  return stub.Notice.log;
}

async function capture(Cls, run) {
  let inst;
  const orig = Cls.prototype.open;
  Cls.prototype.open = function () { inst = this; };
  try { await run(); } finally { Cls.prototype.open = orig; }
  return inst;
}

function fakeEditor() {
  return { text: '', replaceSelection(s) { this.text += s; }, focus() {} };
}

const cmd = (p, id) => p.commands.find((c) => c.id === id);
const TASK = { id: 'T1', content: 'Fix the printer', description: 'Paper jam', due: { date: '2026-10-20' } };

// ---------------------------------------------------------------- pure helpers

test('truncate cuts on whole characters', () => {
  eq(truncate('abc', 5), 'abc');
  eq(truncate('a🚀b', 2), 'a');
  eq(truncate('a🚀b', 3), 'a🚀');
  const name = sanitizeTitle('x'.repeat(99) + '🚀 tail', '-');
  ok(!/[\uD800-\uDBFF]$/.test(name), 'no lone surrogate');
  eq(name, 'x'.repeat(99));
});

test('dailyNotePath uses folder and format', () => {
  const m = stub.moment('2026-10-16T09:05:00');
  eq(dailyNotePath({ folder: 'Daily/', format: 'YYYY-MM-DD' }, m), 'Daily/2026-10-16.md');
  eq(dailyNotePath({ folder: '', format: '' }, m), '2026-10-16.md');
  eq(dailyNotePath(undefined, m), '2026-10-16.md');
});

test('sectionContains looks only under the heading', () => {
  const data = '# Day\n[[a]]\n## Log\n- 10:00 [[b]]\n### Sub\n[[s]]\n## Other\n- [[c]]\n';
  ok(sectionContains(data, '## Log', '[[b]]'));
  ok(sectionContains(data, '## Log', '[[s]]'));
  ok(!sectionContains(data, '## Log', '[[a]]'));
  ok(!sectionContains(data, '## Log', '[[c]]'));
  ok(!sectionContains('no heading', '## Log', 'no'));
  ok(sectionContains(data, '', '[[c]]'), 'empty heading means the whole note');
});

test('noteProps, propsDiff and applyProps', () => {
  deepEq(noteProps({ id: 5, content: 'T', due: { datetime: '2026-10-20T09:00:00' } }), {
    todoist_id: '5', todoist_url: url(5), todoist_title: 'T', due: '2026-10-20T09:00:00', todoist_status: 'open',
  });
  deepEq(noteProps({ id: '5' }, 'closed'), {
    todoist_id: '5', todoist_url: url(5), todoist_title: null, due: null, todoist_status: 'closed',
  });
  deepEq(propsDiff({ a: '1', b: 2, c: '' }, { a: '1', b: '2', c: null, d: undefined, e: 'x' }), { e: 'x' });
  deepEq(propsDiff(undefined, { a: 'x' }), { a: 'x' });
  const fm = { due: '2026-01-01', keep: 1 };
  applyProps(fm, { due: null, todoist_title: 'T', todoist_status: 'open' });
  deepEq(fm, { keep: 1, todoist_title: 'T', todoist_status: 'open' });
});

test('indexNotes keeps every duplicate, sorted by path, and type-checks ids', () => {
  const files = ['b.md', 'a.md', 'c.md', 'd.md', 'e.md'].map(mkFile);
  const fms = { 'b.md': { todoist_id: 'X' }, 'a.md': { todoist_id: ' X ' }, 'c.md': { todoist_id: 12 }, 'd.md': { todoist_id: '' }, 'e.md': { todoist_id: ['X'] } };
  const idx = indexNotes(files, (f) => fms[f.path]);
  deepEq([...idx.keys()], ['X', '12']);
  deepEq(idx.get('X').map((f) => f.path), ['a.md', 'b.md']);
});

test('propsForLookup: 404/deleted -> missing, checked -> closed', () => {
  deepEq(propsForLookup(null), { todoist_status: 'missing' });
  deepEq(propsForLookup({ id: '1', content: 'x', is_deleted: true }), { todoist_status: 'missing' });
  eq(propsForLookup({ id: '1', content: 'x', checked: true }).todoist_status, 'closed');
  eq(propsForLookup({ id: '1', content: 'x', checked: false }).todoist_status, 'open');
});

test('stripFrontmatter', () => {
  eq(stripFrontmatter('---\na: 1\n---\nbody'), 'body');
  eq(stripFrontmatter('body'), 'body');
});

// ---------------------------------------------------------------- loading

test('registers the seven commands with their existing ids, and the ribbon icon', async () => {
  const p = await plugin();
  deepEq(p.commands.map((c) => c.id).sort(), ['create-task-from-note', 'insert-task-inline', 'insert-task-inline-all',
    'open-in-todoist', 'open-task-note', 'open-task-note-all', 'refresh-task-notes']);
  eq(p.ribbons.length, 1);
  eq(p.events.length, 1);
});

test('defaults are unchanged', () => {
  deepEq(DEFAULTS, {
    token: '', filter: 'overdue | today', folder: 'Tasks', fileNameSeparator: '-', template: '',
    writeBackLink: true, updateLinkOnRename: true, logToDaily: true, dailyHeading: '## Log',
    refreshOnStartup: true, dueLang: 'en', writeBackMention: true,
  });
});

test('startup refresh failure is caught and silent', async () => {
  const notices = captureNotices();
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  try {
    const p = new TaskNoteBridge(fakeApp(), manifest);
    p.loadData = async () => ({ token: 'tok' });
    let called = false;
    p.refreshAll = async () => { called = true; throw new Error('boom'); };
    const warn = console.warn; console.warn = () => {};
    try {
      await p.onload();
      await new Promise((r) => setTimeout(r, 10));
    } finally { console.warn = warn; }
    ok(called);
  } finally { process.off('unhandledRejection', onRej); }
  deepEq(rejections, []);
  deepEq(notices, []);
});

test('startup refresh with a failing listing is silent', async () => {
  const notices = captureNotices();
  const app = fakeApp({ files: { 'a.md': '' }, fm: { 'a.md': { todoist_id: '1' } } });
  const p = new TaskNoteBridge(app, manifest);
  p.loadData = async () => ({ token: 'tok' });
  let called = false;
  p.client = () => fakeClient({ tasks: () => { called = true; throw new TodoistError("Can't reach Todoist", 0); } });
  const warn = console.warn; console.warn = () => {};
  try { await p.onload(); await new Promise((r) => setTimeout(r, 10)); } finally { console.warn = warn; }
  ok(called);
  deepEq(notices, []);
});

test('startup refresh is skipped without a token or when disabled', async () => {
  for (const data of [{ token: '' }, { token: 'tok', refreshOnStartup: false }]) {
    const p = new TaskNoteBridge(fakeApp(), manifest);
    p.loadData = async () => data;
    let called = false;
    p.refreshAll = async () => { called = true; };
    await p.onload();
    eq(called, false);
  }
});

test('client() needs a token', async () => {
  const notices = captureNotices();
  const p = await plugin({}, { token: '  ' });
  eq(p.client(), null);
  deepEq(notices, ['Set your Todoist API token in the plugin settings first.']);
  eq(p.client(true), null);
  eq(notices.length, 1);
  p.settings.token = ' tok ';
  eq(p.client().token, 'tok');
});

// ---------------------------------------------------------------- pickers

test('open-task-note lists the filter, sorted by due, then opens the choice', async () => {
  const notices = captureNotices();
  const c = fakeClient({ filter: () => [{ id: 'b', content: 'B' }, { id: 'a', content: 'A', due: { date: '2026-10-01' } }] });
  const p = await plugin({}, { filter: '7 days' }, c);
  const picker = await capture(TaskPicker, () => cmd(p, 'open-task-note').callback());
  deepEq(c.calls[0], ['filter', '7 days']);
  deepEq(picker.getItems().map((t) => t.id), ['a', 'b']);
  deepEq(notices, ['Loading Todoist tasks…']);
  await picker.onChooseItem(picker.getItems()[0]);
  deepEq(p.app.store.opened, ['Tasks/a.md']);
});

test('open-task-note-all lists every task', async () => {
  const c = fakeClient({ tasks: () => [TASK] });
  const p = await plugin({}, {}, c);
  const picker = await capture(TaskPicker, () => cmd(p, 'open-task-note-all').callback());
  deepEq(c.calls[0], ['tasks']);
  eq(picker.getItems().length, 1);
});

test('picker errors show a prefixed notice and open nothing', async () => {
  const notices = captureNotices();
  const p = await plugin({}, {}, fakeClient({ filter: () => { throw new TodoistError('Todoist rejected the API token (check it in the settings)', 401); } }));
  const err = console.error; console.error = () => {};
  let picker;
  try { picker = await capture(TaskPicker, () => cmd(p, 'open-task-note').callback()); } finally { console.error = err; }
  eq(picker, undefined);
  deepEq(notices, ['Loading Todoist tasks…', 'Todoist fzf: Todoist rejected the API token (check it in the settings)']);
});

test('no matching tasks: notice, no picker', async () => {
  const notices = captureNotices();
  const p = await plugin({}, {}, fakeClient());
  const picker = await capture(TaskPicker, () => cmd(p, 'open-task-note').callback());
  eq(picker, undefined);
  eq(notices[1], 'No tasks match.');
});

// ---------------------------------------------------------------- open / create

test('creating a note: properties, body, daily log and 📝 link', async () => {
  const c = fakeClient();
  const p = await plugin({ files: { [DAILY()]: '# Today\n' } }, {}, c);
  await p.openTaskNote(TASK, undefined);
  const path = 'Tasks/fix-the-printer.md';
  deepEq(p.app.store.opened, [path]);
  const fm = p.app.store.fm.get(path);
  eq(fm.todoist_id, 'T1'); eq(fm.todoist_url, url('T1')); eq(fm.todoist_title, 'Fix the printer');
  eq(fm.due, '2026-10-20'); eq(fm.todoist_status, 'open'); eq(fm.created, today());
  ok(p.app.store.data.get(path).endsWith('# Fix the printer\n\n> Paper jam\n\n## Context\n\n\n## Notes\n\n'));
  ok(/^# Today\n\n## Log\n- \d\d:\d\d \[\[fix-the-printer\]\]\n$/.test(p.app.store.data.get(DAILY())));
  deepEq(c.calls, [['updateTask', 'T1', { description: 'Paper jam\n\n[📝 Obsidian note](obsidian://open?vault=Vault&file=Tasks%2Ffix-the-printer.md)' }]]);
});

test('opening an existing note does not log it again, and syncs changed properties', async () => {
  const daily = DAILY();
  const path = 'Notes/x.md';
  const props = noteProps(TASK);
  const p = await plugin({ files: { [path]: '', [daily]: '' }, fm: { [path]: { ...props, todoist_title: 'Old' } } }, {}, fakeClient());
  await p.openTaskNote(TASK, p.app.store.files.get(path));
  deepEq(p.app.store.opened, [path]);
  eq(p.app.store.data.get(daily), '');
  eq(p.app.store.fm.get(path).todoist_title, 'Fix the printer');
});

test('a failing 📝 write-back does not prevent the daily log', async () => {
  const notices = captureNotices();
  const p = await plugin({ files: { [DAILY()]: '' } }, {},
    fakeClient({ updateTask: () => { throw new TodoistError("Can't reach Todoist (check your connection)", 0); } }));
  const err = console.error; console.error = () => {};
  try { await p.openTaskNote(TASK, undefined); } finally { console.error = err; }
  ok(p.app.store.data.get(DAILY()).includes('[[fix-the-printer]]'));
  deepEq(p.app.store.opened, ['Tasks/fix-the-printer.md']);
  deepEq(notices, ["Todoist fzf: Can't reach Todoist (check your connection)"]);
});

test('a failing daily log does not prevent the 📝 write-back', async () => {
  const c = fakeClient();
  const p = await plugin({ files: { [DAILY()]: '' } }, {}, c);
  p.app.vault.process = async () => { throw new Error('locked'); };
  const err = console.error; console.error = () => {};
  try { await p.openTaskNote(TASK, undefined); } finally { console.error = err; }
  eq(c.calls.length, 1);
  eq(c.calls[0][0], 'updateTask');
});

test('write-back is skipped when disabled or already present', async () => {
  const c = fakeClient();
  const p = await plugin({}, { writeBackLink: false, logToDaily: false }, c);
  await p.openTaskNote(TASK, undefined);
  eq(c.calls.length, 0);
  p.settings.writeBackLink = true;
  const desc = '[📝 Obsidian note](obsidian://open?vault=Vault&file=Tasks%2Ffix-the-printer.md)';
  await p.openTaskNote({ ...TASK, description: desc }, p.app.store.files.get('Tasks/fix-the-printer.md'));
  eq(c.calls.length, 0);
});

test('collision suffix uses the separator', async () => {
  const p = await plugin({ folders: ['Tasks'], files: { 'Tasks/fix-the-printer.md': 'x', 'Tasks/fix-the-printer-2.md': 'x' } }, { logToDaily: false });
  const f = await p.createNote(TASK);
  eq(f.path, 'Tasks/fix-the-printer-3.md');
  ok(!p.app.store.log.some((l) => l.startsWith('createFolder')));
});

test('empty folder means the vault root', async () => {
  const p = await plugin({}, { folder: '', fileNameSeparator: '_' });
  eq((await p.createNote(TASK)).path, 'fix_the_printer.md');
});

// ---------------------------------------------------------------- templates

test('template frontmatter is merged with the plugin properties', async () => {
  const tpl = '---\ntags: task\ntitle: "{{title}}"\ndue: placeholder\ncreated: 2020-01-01\n---\n# {{title}}\n{{url}} {{nope}}\n';
  const p = await plugin({ files: { 'Templates/Task.md': tpl } }, { template: 'Templates/Task' });
  const f = await p.createNote(TASK);
  const fm = p.app.store.fm.get(f.path);
  deepEq(fm, {
    tags: 'task', title: 'Fix the printer', due: '2026-10-20', created: '2020-01-01',
    todoist_id: 'T1', todoist_url: url('T1'), todoist_title: 'Fix the printer', todoist_status: 'open',
  });
  const data = p.app.store.data.get(f.path);
  eq((data.match(/^---$/gm) || []).length, 2, 'a single frontmatter block');
  ok(data.endsWith(`---\n# Fix the printer\n${url('T1')} {{nope}}\n`), data);
});

test('template without frontmatter gets the plugin properties', async () => {
  const p = await plugin({ files: { 'Templates/Task.md': '# {{title}}\n' } }, { template: 'Templates/Task.md' });
  const f = await p.createNote({ id: 'T2', content: 'No due' });
  const fm = p.app.store.fm.get(f.path);
  eq(fm.todoist_id, 'T2'); eq(fm.due, undefined);
  ok(p.app.store.data.get(f.path).endsWith('---\n# No due\n'));
});

test('template frontmatter that breaks once filled is dropped, plugin properties still set', async () => {
  const notices = captureNotices();
  const p = await plugin({ files: { 'Templates/Task.md': '---\ntitle: {{title}}\n---\nBody\n' } }, { template: 'Templates/Task' });
  const f = await p.createNote({ id: 'T3', content: 'Call Bob: budget' });
  eq(p.app.store.fm.get(f.path).todoist_id, 'T3');
  eq(p.app.store.fm.get(f.path).title, undefined);
  ok(p.app.store.data.get(f.path).endsWith('---\nBody\n'));
  eq(notices.length, 1);
});

test('missing template: notice and default body', async () => {
  const notices = captureNotices();
  const p = await plugin({}, { template: 'Templates/Nope' });
  const f = await p.createNote(TASK);
  deepEq(notices, ['Template not found: Templates/Nope.md — using the default layout.']);
  ok(p.app.store.data.get(f.path).includes('## Context'));
});

// ---------------------------------------------------------------- daily log

test('logToDaily adds the line once, deduped within the section', async () => {
  const daily = DAILY();
  const p = await plugin({ files: { [daily]: '[[n]] mentioned up here\n## Log\n- 08:00 [[old]]\n\n## Notes\nhi\n', 'Tasks/n.md': '' } });
  const file = p.app.store.files.get('Tasks/n.md');
  await p.logToDaily(file);
  await p.logToDaily(file);
  const out = p.app.store.data.get(daily);
  ok(/^\[\[n\]\] mentioned up here\n## Log\n- 08:00 \[\[old\]\]\n- \d\d:\d\d \[\[n\]\]\n\n## Notes\nhi\n$/.test(out), out);
});

test('logToDaily: missing daily note, toggle, and the daily note itself', async () => {
  const notices = captureNotices();
  const p = await plugin({ files: { 'Tasks/n.md': '', [DAILY()]: '' } }, {});
  p.app.internalPlugins.getPluginById = () => ({ instance: { options: { folder: 'Elsewhere' } } });
  await p.logToDaily(p.app.store.files.get('Tasks/n.md'));
  deepEq(notices, ["Today's daily note doesn't exist yet, so this wasn't logged."]);
  p.settings.logToDaily = false;
  await p.logToDaily(p.app.store.files.get('Tasks/n.md'));
  eq(notices.length, 1);
  p.settings.logToDaily = true;
  p.app.internalPlugins.getPluginById = () => null;
  const q = await plugin({ files: { [`${today()}.md`]: '' } });
  q.app.internalPlugins.getPluginById = () => null;
  await q.logToDaily(q.app.store.files.get(`${today()}.md`));
  eq(q.app.store.data.get(`${today()}.md`), '');
});

// ---------------------------------------------------------------- refresh

test('refresh updates title/due/status, writes only changes, keeps duplicates in sync', async () => {
  const notices = captureNotices();
  const same = noteProps({ id: 'A', content: 'Alpha', due: { date: '2026-10-20' } });
  const b = noteProps({ id: 'B', content: 'Old title', due: { date: '2026-10-01' } });
  const p = await plugin({
    files: { 'a.md': '', 'b1.md': '', 'b2.md': '', 'plain.md': '' },
    fm: { 'a.md': same, 'b1.md': b, 'b2.md': { ...b, extra: 'kept' } },
  }, {}, fakeClient({
    tasks: () => [{ id: 'A', content: 'Alpha', due: { date: '2026-10-20' } }, { id: 'B', content: 'New title' }],
  }));
  await p.refreshAll(true);
  deepEq(p.app.store.log.sort(), ['fm b1.md', 'fm b2.md']);
  for (const path of ['b1.md', 'b2.md']) {
    eq(p.app.store.fm.get(path).todoist_title, 'New title');
    eq(p.app.store.fm.get(path).due, undefined);
  }
  eq(p.app.store.fm.get('b2.md').extra, 'kept');
  deepEq(notices, ['Task notes refreshed (2 updated).']);
});

test('refresh: tasks no longer active are looked up: completed -> closed, 404/deleted -> missing', async () => {
  const open = (id) => noteProps({ id, content: 'X' });
  const c = fakeClient({
    task: (id) => ({
      done: { id: 'done', content: 'X', checked: true },
      del: { id: 'del', content: 'X', is_deleted: true },
      far: { id: 'far', content: 'Beyond the cap', checked: false },
    }[id] || null),
  });
  const p = await plugin({
    files: { 'done.md': '', 'gone.md': '', 'del.md': '', 'far.md': '', 'old.md': '', 'miss.md': '' },
    fm: {
      'done.md': open('done'), 'gone.md': { ...open('gone'), due: '2026-01-01' }, 'del.md': open('del'), 'far.md': open('far'),
      'old.md': { ...open('old'), todoist_status: 'closed' }, 'miss.md': { ...open('miss'), todoist_status: 'missing' },
    },
  }, {}, c);
  await p.refreshAll(true);
  const st = (path) => p.app.store.fm.get(path).todoist_status;
  eq(st('done.md'), 'closed');
  eq(st('gone.md'), 'missing');
  eq(p.app.store.fm.get('gone.md').due, '2026-01-01', 'missing keeps the other properties');
  eq(st('del.md'), 'missing');
  eq(st('far.md'), 'open');
  eq(p.app.store.fm.get('far.md').todoist_title, 'Beyond the cap');
  deepEq(c.calls.filter((x) => x[0] === 'task').map((x) => x[1]).sort(), ['del', 'done', 'far', 'gone']);
});

test('refresh isolates errors per task and per file', async () => {
  const notices = captureNotices();
  const p = await plugin({
    files: { 'a.md': '', 'b.md': '', 'c.md': '' },
    fm: { 'a.md': noteProps({ id: 'A', content: 'old' }), 'b.md': noteProps({ id: 'B', content: 'old' }), 'c.md': noteProps({ id: 'C', content: 'old' }) },
  }, {}, fakeClient({
    tasks: () => [{ id: 'A', content: 'new' }, { id: 'C', content: 'new' }],
    task: () => { throw new TodoistError('Todoist API 500', 500); },
  }));
  p.app.store.failFm = new Set(['a.md']);
  const warn = console.warn; console.warn = () => {};
  try { await p.refreshAll(true); } finally { console.warn = warn; }
  eq(p.app.store.fm.get('c.md').todoist_title, 'new');
  deepEq(notices, ['Task notes refreshed (1 updated, 2 failed).']);
});

test('refresh: no notes, listing error, no token', async () => {
  const notices = captureNotices();
  const p = await plugin({}, {}, fakeClient());
  await p.refreshAll(true);
  deepEq(notices, ['No task notes found.']);
  await p.refreshAll(false);
  eq(notices.length, 1);

  const q = await plugin({ files: { 'a.md': '' }, fm: { 'a.md': { todoist_id: '1' } } }, {},
    fakeClient({ tasks: () => { throw new TodoistError('Todoist rejected the API token (check it in the settings)', 401); } }));
  const err = console.error; const warn = console.warn; console.error = () => {}; console.warn = () => {};
  try {
    await q.refreshAll(true);
    await q.refreshAll(false);
  } finally { console.error = err; console.warn = warn; }
  deepEq(notices.slice(1), ['Todoist fzf: Todoist rejected the API token (check it in the settings)']);

  const r = await plugin({ files: { 'a.md': '' }, fm: { 'a.md': { todoist_id: '1' } } }, { token: '' });
  await r.refreshAll(false);
  eq(notices.length, 2);
  await r.refreshAll(true);
  eq(notices[2], 'Set your Todoist API token in the plugin settings first.');
});

test('refresh-task-notes command runs a verbose refresh', async () => {
  const notices = captureNotices();
  const p = await plugin({}, {}, fakeClient());
  await cmd(p, 'refresh-task-notes').callback();
  deepEq(notices, ['No task notes found.']);
});

// ---------------------------------------------------------------- inline

test('insert-task-inline inserts plain text and writes the 💬 mention', async () => {
  const c = fakeClient({ filter: () => [TASK] });
  const p = await plugin({ files: { 'Tasks/n.md': '', 'Daily/d.md': '' }, fm: { 'Tasks/n.md': { todoist_id: 'T1' } } }, {}, c);
  const ed = fakeEditor();
  const view = { file: p.app.store.files.get('Daily/d.md') };
  const picker = await capture(TaskPicker, () => cmd(p, 'insert-task-inline').editorCallback(ed, view));
  await picker.onChooseItem(TASK);
  eq(ed.text, `[Fix the printer](${url('T1')}) · due 2026-10-20 · [[n]]`);
  deepEq(c.calls[1], ['updateTask', 'T1', { description: 'Paper jam\n\n[💬 Obsidian mention](obsidian://open?vault=Vault&file=Daily%2Fd.md)' }]);
});

test('insert-task-inline-all lists all tasks; mention disabled writes nothing', async () => {
  const c = fakeClient({ tasks: () => [TASK] });
  const p = await plugin({ files: { 'Daily/d.md': '' } }, { writeBackMention: false }, c);
  const ed = fakeEditor();
  const picker = await capture(TaskPicker, () => cmd(p, 'insert-task-inline-all').editorCallback(ed, { file: p.app.store.files.get('Daily/d.md') }));
  await picker.onChooseItem(TASK);
  eq(ed.text, `[Fix the printer](${url('T1')}) · due 2026-10-20`);
  deepEq(c.calls, [['tasks']]);
});

// ---------------------------------------------------------------- other commands

test('create-task-from-note creates the task and writes its properties', async () => {
  const notices = captureNotices();
  const c = fakeClient({ createTask: (body) => ({ id: 'N1', content: body.content, due: { date: '2026-10-24' } }) });
  const p = await plugin({ files: { 'Drafts/plan.md': 'body' } }, { dueLang: 'fr' }, c);
  const command = cmd(p, 'create-task-from-note');
  eq(command.checkCallback(true), false);
  p.app.workspace.active = p.app.store.files.get('Drafts/plan.md');
  eq(command.checkCallback(true), true);
  const modal = await capture(NewTaskModal, () => command.checkCallback(false));
  await modal.onSubmit('Plan it', 'demain');
  deepEq(c.calls[0], ['createTask', {
    content: 'Plan it', description: '[📝 Obsidian note](obsidian://open?vault=Vault&file=Drafts%2Fplan.md)',
    due_string: 'demain', due_lang: 'fr',
  }]);
  deepEq(p.app.store.fm.get('Drafts/plan.md'), {
    todoist_id: 'N1', todoist_url: url('N1'), todoist_title: 'Plan it', due: '2026-10-24', todoist_status: 'open',
  });
  deepEq(notices, ['Task created, due 2026-10-24.']);
});

test('create-task-from-note refuses a note already linked', async () => {
  const notices = captureNotices();
  const p = await plugin({ files: { 'a.md': '' }, fm: { 'a.md': { todoist_id: '1' } } }, {}, fakeClient());
  await p.createTaskFromNote(p.app.store.files.get('a.md'));
  deepEq(notices, ['This note is already linked to a Todoist task.']);
});

test('open-in-todoist is available only on task notes', async () => {
  const p = await plugin({ files: { 'a.md': '', 'b.md': '' }, fm: { 'a.md': { todoist_id: 'X1' } } });
  const command = cmd(p, 'open-in-todoist');
  eq(command.checkCallback(true), false);
  p.app.workspace.active = p.app.store.files.get('b.md');
  eq(command.checkCallback(true), false);
  p.app.workspace.active = p.app.store.files.get('a.md');
  const opened = [];
  global.window = { open: (u) => opened.push(u) };
  try {
    eq(command.checkCallback(true), true);
    deepEq(opened, []);
    command.checkCallback(false);
    deepEq(opened, [url('X1')]);
  } finally { delete global.window; }
});

test('rename fixes the 📝 link only when present and the task is open', async () => {
  const link = '[📝 Obsidian note](obsidian://open?vault=Vault&file=Tasks%2Fold.md)';
  const tasks = { A: { id: 'A', description: `x\n\n${link}` }, B: { id: 'B', description: 'no link' }, C: { id: 'C', checked: true, description: link } };
  const c = fakeClient({ task: (id) => tasks[id] || null });
  const p = await plugin({ files: { 'Archive/a.md': '', 'b.md': '', 'c.md': '', 'd.md': '' },
    fm: { 'Archive/a.md': { todoist_id: 'A' }, 'b.md': { todoist_id: 'B' }, 'c.md': { todoist_id: 'C' }, 'd.md': { todoist_id: 'D' } } }, {}, c);
  for (const path of ['Archive/a.md', 'b.md', 'c.md', 'd.md']) await p.onRename(p.app.store.files.get(path));
  deepEq(c.calls.filter((x) => x[0] === 'updateTask'), [['updateTask', 'A', { description: 'x\n\n[📝 Obsidian note](obsidian://open?vault=Vault&file=Archive%2Fa.md)' }]]);
});

// ---------------------------------------------------------------- settings

test('settings tab: names, password token, Test button, helpers', async () => {
  const notices = captureNotices();
  const c = fakeClient();
  const p = await plugin({}, {}, c);
  const tab = new BridgeSettingTab(p.app, p);
  tab.display();
  const byName = (n) => tab.containerEl.settings.find((s) => s.name === n);
  deepEq(tab.containerEl.settings.map((s) => s.name), ['Todoist API token', 'Task filter', 'Task notes folder',
    'File name separator', 'Note template (optional)', 'Write note link back into the task',
    'Fix the link when a note is renamed or moved', 'Log to daily note', 'Daily note heading',
    'Write mention link back into the task', 'Refresh task notes on startup', 'Due date language']);
  const token = byName('Todoist API token');
  eq(token.components[0].inputEl.type, 'password');
  await token.components[0].changeHandler(' new ');
  eq(p.settings.token, 'new');
  eq(p.saved.token, 'new');
  await token.components.find((x) => x.kind === 'button').clickHandler();
  deepEq(c.calls, [['ping']]);
  deepEq(notices, ['Connected to Todoist ✔']);
  await byName('Task notes folder').components[0].changeHandler(' Work/Tasks ');
  eq(p.settings.folder, 'Work/Tasks');
  await byName('Due date language').components[0].changeHandler('  ');
  eq(p.settings.dueLang, 'en');
  const toggle = byName('Log to daily note').components[0];
  eq(toggle.kind, 'toggle');
  eq(toggle.value, true);
  await toggle.changeHandler(false);
  eq(p.settings.logToDaily, false);
});

test('settings Test button reports errors with the plugin prefix', async () => {
  const notices = captureNotices();
  const p = await plugin({}, {}, fakeClient({ ping: () => { throw new TodoistError('Todoist rejected the API token (check it in the settings)', 401); } }));
  const tab = new BridgeSettingTab(p.app, p);
  tab.display();
  const err = console.error; console.error = () => {};
  try { await tab.containerEl.settings[0].components.find((x) => x.kind === 'button').clickHandler(); } finally { console.error = err; }
  deepEq(notices, ['Todoist fzf: Todoist rejected the API token (check it in the settings)']);
});
