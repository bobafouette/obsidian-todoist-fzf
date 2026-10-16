'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  inlineLine, MENTION_RE, sanitizeTitle, withLink, stripLink,
  insertUnderHeading, encodeUriPart, compareDue, renderTemplate,
} = require('./load-plugin.js');

const NOTE_LINK = '[📝 Obsidian note](obsidian://open?vault=Work&file=Tasks%2Fa.md)';
const NOTE_LINK_2 = '[📝 Obsidian note](obsidian://open?vault=Work&file=Archive%2Fa.md)';
const MENTION = '[💬 Obsidian mention](obsidian://open?vault=Work&file=Daily%2F2026-10-14.md)';
const MENTION_2 = '[💬 Obsidian mention](obsidian://open?vault=Work&file=Daily%2F2026-10-15.md)';

// ---------------------------------------------------------------- sanitizeTitle
describe('sanitizeTitle', () => {
  test('lower-cases and uses the default "-" separator setting for spaces', () => {
    assert.equal(sanitizeTitle('Renew SSL Certificate', '-'), 'renew-ssl-certificate');
  });

  test('without a separator argument it keeps spaces (function default is " ")', () => {
    assert.equal(sanitizeTitle('Renew SSL Certificate'), 'renew ssl certificate');
  });

  test('replaces every forbidden character with the separator', () => {
    assert.equal(sanitizeTitle('a\\b/c:d*e?f"g<h>i|j#k^l[m]n', '-'), 'a-b-c-d-e-f-g-h-i-j-k-l-m-n');
  });

  test('collapses runs of spaces, forbidden chars and separators into one separator', () => {
    assert.equal(sanitizeTitle('Fix:  VPN -- / config', '-'), 'fix-vpn-config');
  });

  test('trims leading/trailing separators', () => {
    assert.equal(sanitizeTitle('  [Urgent] deploy?  ', '-'), 'urgent-deploy');
    assert.equal(sanitizeTitle('-- hello --', '-'), 'hello');
  });

  test('custom separators: "_" and multi-char', () => {
    assert.equal(sanitizeTitle('Call Bob: budget', '_'), 'call_bob_budget');
    assert.equal(sanitizeTitle('a b', '--'), 'a--b');
  });

  test('a separator made of forbidden chars or whitespace falls back to space', () => {
    assert.equal(sanitizeTitle('A/B c', '/'), 'a b c');
    assert.equal(sanitizeTitle('A B', '   '), 'a b');
    assert.equal(sanitizeTitle('A B', ''), 'a b');
    assert.equal(sanitizeTitle('A B', null), 'a b');
  });

  test('regex metacharacters in the separator are escaped', () => {
    assert.equal(sanitizeTitle('a  b.c', '.'), 'a.b.c');
    assert.equal(sanitizeTitle('x y', '+'), 'x+y');
  });

  test('markdown links are reduced to their text', () => {
    assert.equal(
      sanitizeTitle('Review [PROJ-12](https://jira.example.com/browse/PROJ-12) spec', '-'),
      'review-proj-12-spec',
    );
  });

  test('keeps non-ASCII letters and emoji (only lower-cased)', () => {
    assert.equal(sanitizeTitle('Réunion Équipe 🚀', '-'), 'réunion-équipe-🚀');
  });

  test('empty / missing / all-forbidden titles become "untitled<sep>task"', () => {
    assert.equal(sanitizeTitle('', '-'), 'untitled-task');
    assert.equal(sanitizeTitle(undefined, '-'), 'untitled-task');
    assert.equal(sanitizeTitle('???', '-'), 'untitled-task');
    assert.equal(sanitizeTitle(null), 'untitled task');
  });

  test('truncates to at most 100 characters (before lower-casing)', () => {
    const out = sanitizeTitle('word '.repeat(50), '-');
    assert.ok(out.length <= 100, `length ${out.length}`);
    assert.ok(!out.endsWith('-'));
    assert.match(out, /^word(-word)*$/);
  });

  test('collision suffix pattern used by the plugin (`${base} ${i}`) stays sanitized', () => {
    const base = sanitizeTitle('My Task', '-');
    assert.equal(sanitizeTitle(`${base} 2`, '-'), 'my-task-2');
  });

  test('is idempotent', () => {
    const once = sanitizeTitle('Fix: [x] the <thing>', '-');
    assert.equal(sanitizeTitle(once, '-'), once);
  });

  // SUSPECTED BUG: a title starting with "." yields a dot-file name
  // (e.g. ".htaccess-review.md"), which Obsidian ignores/hides in the vault.
  // Test documents current behaviour.
  test('CURRENT BEHAVIOUR: leading dot is kept (hidden file in Obsidian)', () => {
    assert.equal(sanitizeTitle('.htaccess review', '-'), '.htaccess-review');
  });
});

// ---------------------------------------------------------------- encodeUriPart
describe('encodeUriPart', () => {
  test('encodes ( and ) so markdown links do not break', () => {
    assert.equal(encodeUriPart('Tasks/meeting (draft).md'), 'Tasks%2Fmeeting%20%28draft%29.md');
  });

  test('result never contains raw parentheses, spaces or slashes', () => {
    const out = encodeUriPart('a (b) ((c)) / d');
    assert.doesNotMatch(out, /[()\s/]/);
  });

  test('round-trips through decodeURIComponent', () => {
    const s = 'Work vault (perso)/Tasks/été & co #1?.md';
    assert.equal(decodeURIComponent(encodeUriPart(s)), s);
  });

  test('encodes unicode and reserved chars like encodeURIComponent', () => {
    assert.equal(encodeUriPart('é&='), encodeURIComponent('é&='));
  });

  test('a link built from it is matched in full by MENTION_RE', () => {
    const link = `[💬 Obsidian mention](obsidian://open?vault=${encodeUriPart('My Vault (1)')}&file=${encodeUriPart('Daily/x (y).md')})`;
    const m = `before ${link} after`.match(MENTION_RE);
    assert.ok(m);
    assert.equal(m[0], link);
  });
});

// ---------------------------------------------------------------- withLink
describe('withLink (📝 note link, default regex)', () => {
  test('empty / missing description becomes just the link', () => {
    assert.equal(withLink('', NOTE_LINK), NOTE_LINK);
    assert.equal(withLink(undefined, NOTE_LINK), NOTE_LINK);
    assert.equal(withLink(null, NOTE_LINK), NOTE_LINK);
    assert.equal(withLink('   \n ', NOTE_LINK), NOTE_LINK);
  });

  test('appends after existing text with a blank line, trimming trailing whitespace', () => {
    assert.equal(withLink('Call the vendor\n\n', NOTE_LINK), `Call the vendor\n\n${NOTE_LINK}`);
  });

  test('adding is idempotent: applying twice does not duplicate the link', () => {
    const once = withLink('Some text', NOTE_LINK);
    const twice = withLink(once, NOTE_LINK);
    assert.equal(twice, once);
    assert.equal(twice.split('📝').length - 1, 1);
  });

  test('replaces an existing link in place (rename/move) and keeps surrounding text', () => {
    const desc = `Intro line\n\n${NOTE_LINK}\n\nTrailing notes (keep me)`;
    assert.equal(withLink(desc, NOTE_LINK_2), `Intro line\n\n${NOTE_LINK_2}\n\nTrailing notes (keep me)`);
  });

  test('does not touch a 💬 mention when updating the 📝 link', () => {
    const desc = `Text\n\n${MENTION}`;
    assert.equal(withLink(desc, NOTE_LINK), `Text\n\n${MENTION}\n\n${NOTE_LINK}`);
  });

  test('replacement text containing $ patterns is inserted literally', () => {
    const weird = '[📝 Obsidian note](obsidian://open?vault=a&file=%24%26%241)';
    const desc = `x ${NOTE_LINK} y`;
    assert.equal(withLink(desc, weird), `x ${weird} y`);
    const dollars = '[📝 Obsidian note](obsidian://open?vault=$&file=$1)';
    assert.equal(withLink(desc, dollars), `x ${dollars} y`);
  });

  test('ignores look-alike links that are not obsidian:// URIs', () => {
    const desc = '[📝 Obsidian note](https://example.com)';
    assert.equal(withLink(desc, NOTE_LINK), `${desc}\n\n${NOTE_LINK}`);
  });
});

describe('withLink with MENTION_RE (💬 inline mention)', () => {
  test('adds a mention when none exists', () => {
    assert.equal(withLink('Details', MENTION, MENTION_RE), `Details\n\n${MENTION}`);
  });

  test('replaces the previous mention instead of adding a second one', () => {
    const desc = `Details\n\n${MENTION}`;
    const out = withLink(desc, MENTION_2, MENTION_RE);
    assert.equal(out, `Details\n\n${MENTION_2}`);
    assert.equal(out.split('💬').length - 1, 1);
  });

  test('replacing the mention leaves the 📝 note link and other text intact', () => {
    const desc = `Context here\n\n${NOTE_LINK}\n\n${MENTION}\nPS: thanks`;
    assert.equal(
      withLink(desc, MENTION_2, MENTION_RE),
      `Context here\n\n${NOTE_LINK}\n\n${MENTION_2}\nPS: thanks`,
    );
  });

  test('re-applying the same mention is a no-op (no API write needed)', () => {
    const desc = `A\n\n${MENTION}`;
    assert.equal(withLink(desc, MENTION, MENTION_RE), desc);
  });

  // Note: MENTION_RE is not global, so if a description already had two
  // mentions (e.g. edited by hand), only the first is replaced.
  test('CURRENT BEHAVIOUR: only the first of several existing mentions is replaced', () => {
    const desc = `${MENTION}\n${MENTION}`;
    assert.equal(withLink(desc, MENTION_2, MENTION_RE), `${MENTION_2}\n${MENTION}`);
  });
});

// ---------------------------------------------------------------- MENTION_RE
describe('MENTION_RE', () => {
  test('matches a mention link', () => {
    assert.ok(MENTION_RE.test(MENTION));
  });

  test('does not match the 📝 note link or other schemes', () => {
    assert.ok(!MENTION_RE.test(NOTE_LINK));
    assert.ok(!MENTION_RE.test('[💬 Obsidian mention](https://x.y)'));
    assert.ok(!MENTION_RE.test('💬 Obsidian mention obsidian://open'));
  });

  test('is not global/sticky (safe to reuse with .test())', () => {
    assert.equal(MENTION_RE.global, false);
    assert.equal(MENTION_RE.sticky, false);
    assert.ok(MENTION_RE.test(MENTION));
    assert.ok(MENTION_RE.test(MENTION));
  });

  test('stops at the first ")" — which is why URI parts must encode parentheses', () => {
    const raw = '[💬 Obsidian mention](obsidian://open?file=a (b).md)';
    assert.ok(!MENTION_RE.test(raw));
  });
});

// ---------------------------------------------------------------- stripLink
describe('stripLink', () => {
  test('removes the 📝 link and trims', () => {
    assert.equal(stripLink(`Buy licences\n\n${NOTE_LINK}`), 'Buy licences');
  });

  test('removes the 💬 mention too', () => {
    assert.equal(stripLink(`Buy licences\n\n${MENTION}`), 'Buy licences');
  });

  test('removes both at once', () => {
    assert.equal(stripLink(`Body\n\n${NOTE_LINK}\n\n${MENTION}`), 'Body');
  });

  test('leaves other links and text untouched', () => {
    const d = 'See [ticket](https://jira/PROJ-1) and (notes)';
    assert.equal(stripLink(d), d);
  });

  test('empty / missing description gives empty string', () => {
    assert.equal(stripLink(''), '');
    assert.equal(stripLink(undefined), '');
    assert.equal(stripLink(NOTE_LINK), '');
  });

  test('a link in the middle collapses its surrounding blank lines to one', () => {
    assert.equal(stripLink(`a\n\n${NOTE_LINK}\n\nb`), 'a\n\nb');
    assert.equal(stripLink(`a\n\n${MENTION}\n\nb`), 'a\n\nb');
  });

  test('a link between single newlines leaves a single newline', () => {
    assert.equal(stripLink(`a\n${NOTE_LINK}\nb`), 'a\nb');
  });

  test('both links in the middle leave one blank line', () => {
    assert.equal(stripLink(`a\n\n${NOTE_LINK}\n\n${MENTION}\n\nb`), 'a\n\nb');
  });

  test('a link sharing a line with text is just removed', () => {
    assert.equal(stripLink(`a\n\nsee ${NOTE_LINK} here\n\nb`), 'a\n\nsee  here\n\nb');
  });

  test('blank lines elsewhere in the description are left alone', () => {
    assert.equal(stripLink(`a\n\n\n\nb\n\n${NOTE_LINK}\n\nc`), 'a\n\n\n\nb\n\nc');
  });
});

// ---------------------------------------------------------------- insertUnderHeading
describe('insertUnderHeading', () => {
  const LINE = '- 09:30 [[tasks/foo]]';

  test('heading missing: appends heading and line at end of note', () => {
    assert.equal(
      insertUnderHeading('# 2026-10-15\n\nSome text\n\n', '## Log', LINE),
      `# 2026-10-15\n\nSome text\n\n## Log\n${LINE}\n`,
    );
  });

  test('heading present and last section: appends after existing entries', () => {
    const data = '# Day\n\n## Log\n- 08:00 [[a]]\n';
    assert.equal(insertUnderHeading(data, '## Log', LINE), `# Day\n\n## Log\n- 08:00 [[a]]\n${LINE}\n`);
  });

  test('heading present with a following section: inserts before it, skipping blank lines', () => {
    const data = '## Log\n- 08:00 [[a]]\n\n## Notes\nnarrative';
    assert.equal(
      insertUnderHeading(data, '## Log', LINE),
      `## Log\n- 08:00 [[a]]\n${LINE}\n\n## Notes\nnarrative`,
    );
  });

  test('empty section: line goes right under the heading', () => {
    const data = '## Log\n\n## Notes\n';
    assert.equal(insertUnderHeading(data, '## Log', LINE), `## Log\n${LINE}\n\n## Notes\n`);
  });

  test('deeper sub-headings stay inside the section', () => {
    const data = '## Log\n### Morning\n- x\n## Notes\n';
    assert.equal(
      insertUnderHeading(data, '## Log', LINE),
      `## Log\n### Morning\n- x\n${LINE}\n## Notes\n`,
    );
  });

  test('a higher-level heading also ends the section', () => {
    const data = '## Log\n- x\n# Next day\n';
    assert.equal(insertUnderHeading(data, '## Log', LINE), `## Log\n- x\n${LINE}\n# Next day\n`);
  });

  test('#tags at line start are not mistaken for headings', () => {
    const data = '## Log\n#work\n\n## Notes\n';
    assert.equal(insertUnderHeading(data, '## Log', LINE), `## Log\n#work\n${LINE}\n\n## Notes\n`);
  });

  test('heading setting with surrounding whitespace is trimmed and matches', () => {
    const data = '## Log  \n- x\n';
    assert.equal(insertUnderHeading(data, '  ## Log ', LINE), `## Log  \n- x\n${LINE}\n`);
  });

  test('only the first matching heading is used', () => {
    const data = '## Log\n- a\n## Log\n- b\n';
    assert.equal(insertUnderHeading(data, '## Log', LINE), `## Log\n- a\n${LINE}\n## Log\n- b\n`);
  });

  test('a heading of a different level does not match', () => {
    const data = '### Log\n- a\n';
    assert.equal(insertUnderHeading(data, '## Log', LINE), `### Log\n- a\n\n## Log\n${LINE}\n`);
  });

  test('empty heading setting: appends line at end of note', () => {
    assert.equal(insertUnderHeading('text\n\n\n', '', LINE), `text\n${LINE}\n`);
    assert.equal(insertUnderHeading('text', null, LINE), `text\n${LINE}\n`);
  });

  test('preserves missing trailing newline when inserting into existing section', () => {
    assert.equal(insertUnderHeading('## Log\n- a', '## Log', LINE), `## Log\n- a\n${LINE}`);
  });

  test('empty note: heading and line with no leading blank lines (#5)', () => {
    assert.equal(insertUnderHeading('', '## Log', LINE), `## Log\n${LINE}\n`);
    assert.equal(insertUnderHeading('', '', LINE), `${LINE}\n`);
  });

  test('whitespace-only note is treated as empty', () => {
    assert.equal(insertUnderHeading(' \n\n\t\n', '## Log', LINE), `## Log\n${LINE}\n`);
    assert.equal(insertUnderHeading('\n \n', '', LINE), `${LINE}\n`);
  });
});

// ---------------------------------------------------------------- compareDue
describe('compareDue', () => {
  const t = (id, due) => ({ id, due });
  const date = (d) => ({ date: d });
  const dt = (d, datetime) => ({ date: d, datetime });

  test('earlier date sorts first', () => {
    assert.ok(compareDue(t(1, date('2026-10-14')), t(2, date('2026-10-15'))) < 0);
    assert.ok(compareDue(t(1, date('2026-10-16')), t(2, date('2026-10-15'))) > 0);
  });

  test('equal due dates compare equal', () => {
    assert.equal(compareDue(t(1, date('2026-10-15')), t(2, date('2026-10-15'))), 0);
  });

  test('datetime is preferred over date', () => {
    const a = t(1, dt('2026-10-15', '2026-10-15T08:00:00'));
    const b = t(2, dt('2026-10-15', '2026-10-15T17:00:00'));
    assert.ok(compareDue(a, b) < 0);
    assert.ok(compareDue(b, a) > 0);
  });

  test('all-day task sorts before a timed task on the same day', () => {
    assert.ok(compareDue(t(1, date('2026-10-15')), t(2, dt('2026-10-15', '2026-10-15T00:00:00'))) < 0);
  });

  test('tasks without due date sort last', () => {
    assert.ok(compareDue(t(1, date('2026-10-15')), t(2, null)) < 0);
    assert.ok(compareDue(t(1, null), t(2, date('2026-10-15'))) > 0);
    assert.equal(compareDue(t(1, null), t(2, undefined)), 0);
    assert.equal(compareDue({ id: 1 }, null), 0);
  });

  test('Array.prototype.sort gives chronological order with undated tasks at the end', () => {
    const tasks = [
      t('none', null),
      t('c', date('2026-12-01')),
      t('b2', dt('2026-10-15', '2026-10-15T14:00:00')),
      t('a', date('2026-10-01')),
      t('b1', date('2026-10-15')),
    ];
    assert.deepEqual(tasks.sort(compareDue).map((x) => x.id), ['a', 'b1', 'b2', 'c', 'none']);
  });
});

// ---------------------------------------------------------------- inlineLine
describe('inlineLine', () => {
  test('title linking to Todoist, no due, no note', () => {
    assert.equal(inlineLine({ id: '123', content: 'Order laptops' }),
      '- [Order laptops](https://app.todoist.com/app/task/123)');
  });

  test('with due date and note link', () => {
    assert.equal(
      inlineLine({ id: '9', content: 'Budget', due: { date: '2026-10-20' } }, '[[tasks/budget]]'),
      '- [Budget](https://app.todoist.com/app/task/9) · due 2026-10-20 · [[tasks/budget]]',
    );
  });

  test('datetime is shown as "YYYY-MM-DD HH:mm"', () => {
    assert.equal(
      inlineLine({ id: '9', content: 'Call', due: { date: '2026-10-20', datetime: '2026-10-20T14:30:00' } }),
      '- [Call](https://app.todoist.com/app/task/9) · due 2026-10-20 14:30',
    );
  });

  test('square brackets in titles are escaped, markdown links reduced to text', () => {
    assert.equal(
      inlineLine({ id: '1', content: 'See [PROJ-1](https://jira/PROJ-1) [urgent]' }),
      '- [See PROJ-1 \\[urgent\\]](https://app.todoist.com/app/task/1)',
    );
  });

  test('whitespace/newlines in the title are collapsed', () => {
    assert.equal(inlineLine({ id: '1', content: '  a\n\tb   c ' }), '- [a b c](https://app.todoist.com/app/task/1)');
  });

  test('missing title falls back to "Untitled task"', () => {
    assert.equal(inlineLine({ id: '1' }), '- [Untitled task](https://app.todoist.com/app/task/1)');
  });

  test('empty note link is omitted', () => {
    assert.equal(inlineLine({ id: '1', content: 'x' }, ''), '- [x](https://app.todoist.com/app/task/1)');
  });

  // SUSPECTED BUG (minor): Todoist returns UTC datetimes with a trailing "Z"
  // for fixed-timezone tasks; formatDue just slices the string, so the line
  // shows the UTC time, not local time.
  test('CURRENT BEHAVIOUR: UTC datetime ("Z") is shown as-is, not converted to local time', () => {
    assert.equal(
      inlineLine({ id: '1', content: 'x', due: { date: '2026-10-20', datetime: '2026-10-20T07:00:00Z' } }),
      '- [x](https://app.todoist.com/app/task/1) · due 2026-10-20 07:00',
    );
  });
});

// ---------------------------------------------------------------- renderTemplate
describe('renderTemplate', () => {
  const task = {
    id: 42,
    content: 'Plan migration',
    description: `Move mail to the new tenant\n\n${NOTE_LINK}\n\n${MENTION}`,
    due: { date: '2026-10-20', datetime: '2026-10-20T09:00:00' },
  };

  test('fills all supported placeholders', () => {
    const out = renderTemplate('{{title}}|{{description}}|{{due}}|{{url}}|{{id}}', task);
    assert.equal(out,
      'Plan migration|Move mail to the new tenant|2026-10-20T09:00:00|https://app.todoist.com/app/task/42|42');
  });

  test('{{date}} is today as YYYY-MM-DD', () => {
    const out = renderTemplate('{{date}}', task);
    assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
    const n = new Date();
    const p = (x) => String(x).padStart(2, '0');
    assert.equal(out, `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`);
  });

  test('description excludes the 📝 link and 💬 mention', () => {
    assert.doesNotMatch(renderTemplate('{{description}}', task), /Obsidian (note|mention)/);
  });

  test('replaces repeated placeholders', () => {
    assert.equal(renderTemplate('{{title}} / {{title}}', task), 'Plan migration / Plan migration');
  });

  test('unknown placeholders are left untouched', () => {
    assert.equal(renderTemplate('{{foo}} {{ title }} {title}', task), '{{foo}} {{ title }} {title}');
  });

  test('missing fields render as empty strings', () => {
    assert.equal(renderTemplate('[{{title}}][{{description}}][{{due}}]', { id: 1 }), '[][][]');
  });

  test('due falls back to the date when there is no datetime', () => {
    assert.equal(renderTemplate('{{due}}', { id: 1, due: { date: '2026-11-01' } }), '2026-11-01');
  });

  test('$ sequences in task values are inserted literally', () => {
    assert.equal(renderTemplate('{{title}}', { id: 1, content: 'Pay $& $1 $$' }), 'Pay $& $1 $$');
  });

  test('inherited keys like {{constructor}} are left untouched (#3)', () => {
    for (const k of ['constructor', 'toString', '__proto__']) {
      assert.equal(renderTemplate(`{{${k}}}`, task), `{{${k}}}`);
    }
  });
});
