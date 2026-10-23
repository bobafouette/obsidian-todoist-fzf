'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TodoistError, TodoistClient, paginate } = require('./load-plugin');

const eq = assert.equal;
const deepEq = assert.deepEqual;
const ok = assert.ok;
const rejects = assert.rejects;

const API = 'https://api.todoist.com/api/v1';
const json = (status, body) => ({ status, json: body, text: JSON.stringify(body) });

function fakeRequest(responses) {
  const queue = responses.slice();
  const req = async (arg) => {
    req.calls.push(arg);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  req.calls = [];
  return req;
}

const client = (responses) => {
  const req = fakeRequest(responses);
  return { c: new TodoistClient({ token: 'tok' }, req), req };
};

test('paginate follows next_cursor', async () => {
  const pages = { undefined: { results: [1, 2], next_cursor: 'a' }, a: { results: [3], next_cursor: null } };
  deepEq(await paginate(async (c) => pages[c]), [1, 2, 3]);
  deepEq(await paginate(async () => ({ results: [1] })), [1]);
  deepEq(await paginate(async () => null), []);
});

test('paginate stops at the cap (500 by default)', async () => {
  let calls = 0;
  const endless = async () => { calls++; return { results: Array(200).fill(0), next_cursor: 'n' }; };
  eq((await paginate(endless)).length, 500);
  eq(calls, 3);
  eq((await paginate(endless, 250)).length, 250);
});

test('GET requests: URL, auth header, throw:false, no body', async () => {
  const { c, req } = client([json(200, { results: [{ id: '1' }], next_cursor: null })]);
  const out = await c.filter('overdue | today');
  deepEq(out, [{ id: '1' }]);
  const call = req.calls[0];
  eq(call.method, 'GET');
  eq(call.headers.Authorization, 'Bearer tok');
  eq(call.headers['Content-Type'], undefined);
  eq(call.throw, false);
  eq(call.body, undefined);
  ok(call.url.startsWith(API + '/tasks/filter?'));
  const q = new URL(call.url).searchParams;
  eq(q.get('query'), 'overdue | today');
  eq(q.get('limit'), '200');
  eq(q.has('cursor'), false);
});

test('tasks() pages through /tasks with the cursor', async () => {
  const { c, req } = client([
    json(200, { results: [{ id: 'a' }], next_cursor: 'cur 2' }),
    json(200, { results: [{ id: 'b' }], next_cursor: null }),
  ]);
  deepEq((await c.tasks()).map((t) => t.id), ['a', 'b']);
  ok(req.calls[0].url.startsWith(API + '/tasks?'));
  eq(new URL(req.calls[1].url).searchParams.get('cursor'), 'cur 2');
});

test('tasks() is capped at 500 tasks', async () => {
  const page = json(200, { results: Array(200).fill({ id: 'x' }), next_cursor: 'n' });
  const { c, req } = client([page, page, page, page]);
  eq((await c.tasks()).length, 500);
  eq(req.calls.length, 3);
});

test('POST requests send JSON', async () => {
  const { c, req } = client([json(200, { id: '9', content: 'New' })]);
  const t = await c.createTask({ content: 'New', due_string: 'tomorrow' });
  eq(t.id, '9');
  eq(req.calls[0].method, 'POST');
  eq(req.calls[0].url, API + '/tasks');
  eq(req.calls[0].headers['Content-Type'], 'application/json');
  deepEq(JSON.parse(req.calls[0].body), { content: 'New', due_string: 'tomorrow' });

  const u = client([{ status: 204, text: '' }]);
  eq(await u.c.updateTask('a/b', { description: 'd' }), null);
  eq(u.req.calls[0].url, API + '/tasks/a%2Fb');
});

test('task(id) returns the task, or null on 404', async () => {
  const { c, req } = client([json(200, { id: '7', checked: true })]);
  deepEq(await c.task('7'), { id: '7', checked: true });
  eq(req.calls[0].url, API + '/tasks/7');
  eq(await client([json(404, { error: 'Task not found' })]).c.task('7'), null);
  await rejects(client([json(500, {})]).c.task('7'), (e) => e.status === 500);
});

test('401 and 403 give a friendly message', async () => {
  for (const status of [401, 403]) {
    await rejects(client([json(status, { error: 'Unauthorized' })]).c.ping(),
      (e) => e instanceof TodoistError && e.status === status && /Todoist rejected the API token/.test(e.message));
  }
});

test('network failure: "Can\'t reach Todoist", status 0', async () => {
  await rejects(client([new Error('offline')]).c.tasks(),
    (e) => e instanceof TodoistError && e.status === 0 && /Can't reach Todoist/.test(e.message));
});

test('other errors carry the status and Todoist\'s error text', async () => {
  await rejects(client([json(400, { error: 'Invalid filter', error_code: 1 })]).c.filter('(('),
    (e) => e.status === 400 && e.message === 'Todoist API 400: Invalid filter');
  const long = 'x'.repeat(500);
  await rejects(client([{ status: 502, text: long, get json() { throw new Error('not json'); } }]).c.tasks(),
    (e) => e.status === 502 && e.message === `Todoist API 502: ${'x'.repeat(200)}`);
  await rejects(client([{ status: 500, text: '' }]).c.tasks(), (e) => e.message === 'Todoist API 500');
});

test('a 2xx with an unreadable body is an error', async () => {
  const bad = { status: 200, text: '<html>', get json() { throw new Error('not json'); } };
  await rejects(client([bad]).c.tasks(), (e) => e instanceof TodoistError && e.message === 'Unexpected response from Todoist');
});
