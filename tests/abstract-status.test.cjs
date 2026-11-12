const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../anesthesia conferences 2026-2027.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function load() {
  const elements = {};
  const callbacks = {};
  const context = {
    Intl, Date,
    document: {
      hidden: false,
      getElementById(id) {
        return elements[id] ||= {
          innerHTML: '', style: {}, addEventListener() {},
          querySelectorAll() { return []; }, querySelector() { return null; }
        };
      },
      querySelectorAll() { return []; },
      addEventListener(name, cb) { callbacks[name] = cb; }
    },
    window: { addEventListener(name, cb) { callbacks[name] = cb; } },
    setInterval(cb, ms) { callbacks.interval = cb; assert.equal(ms, 30000); }
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return {
    context, elements, callbacks,
    conferences: vm.runInContext('CONFERENCES', context),
    status: (id, time) => context.getAbstractStatus(
      vm.runInContext('CONFERENCES', context).find(c => c.id === id), new Date(time))
  };
}

test('ASA opens on January 5 and stays open through March 30 Pacific time', () => {
  const { status } = load();
  assert.equal(status('asa-2027', '2027-01-05T07:59:59Z'), 'upcoming');
  assert.equal(status('asa-2027', '2027-01-05T08:00:00Z'), 'open');
  assert.equal(status('asa-2027', '2027-03-31T06:59:59Z'), 'open');
  assert.equal(status('asa-2027', '2027-03-31T07:00:00Z'), 'closed');
});

test('published deadlines respect explicit time zones and exact cutoff instants', () => {
  const { status } = load();
  for (const [id, before, cutoff] of [
    ['sea-spring-2027', '2026-10-01T03:58:59Z', '2026-10-01T03:59:00Z'],
    ['ccas-2027', '2026-10-26T15:59:59Z', '2026-10-26T16:00:00Z'],
    ['spa-2027', '2026-10-26T16:59:59Z', '2026-10-26T17:00:00Z'],
    ['sca-2027', '2026-12-02T04:58:59Z', '2026-12-02T04:59:00Z'],
    ['iars-socca-2027', '2026-12-07T07:58:59Z', '2026-12-07T07:59:00Z']
  ]) {
    assert.equal(status(id, before), 'open', id);
    assert.equal(status(id, cutoff), 'closed', id);
  }
});

test('unknown openings never become open merely because a deadline is in the future', () => {
  const { status, context } = load();
  assert.equal(status('aua-2027', '2026-10-01T12:00:00Z'), 'tbd');
  assert.equal(status('soap-2027', '2027-02-01T12:00:00Z'), 'tbd');
  assert.equal(context.getAbstractStatus({ abstractStatus: 'tbd', abstractDeadline: [2027, 3, 30] }, new Date('2027-01-01')), 'tbd');
  assert.equal(context.getAbstractStatus({ abstractStatus: 'tbd', abstractOpensAt: '2027-01-05T12:00:00-05:00' }, new Date('2027-01-05T16:59:59Z')), 'upcoming');
  assert.equal(context.getAbstractStatus({ abstractStatus: 'tbd', abstractOpensAt: '2027-01-05T12:00:00-05:00' }, new Date('2027-01-05T17:00:00Z')), 'open');
});

test('award cutoff requires verification; completed meetings and recorded closures remain closed', () => {
  const { status } = load();
  assert.equal(status('sta-2027', '2026-11-15T20:00:00Z'), 'open');
  assert.equal(status('sta-2027', '2026-11-16T08:00:00Z'), 'tbd');
  assert.equal(status('sta-2027', '2027-01-18T08:00:00Z'), 'closed');
  assert.equal(status('sccm-2027', '2026-09-22T12:00:00Z'), 'closed');
});

test('live refresh updates cards, list, links, banner and preserves selected filter/view', () => {
  const { context, elements, callbacks } = load();
  vm.runInContext("currentFilter = 'open'; currentView = 'list';", context);
  context.refreshTimeSensitiveUI(new Date('2026-12-08T12:00:00Z'));
  assert(!elements['alert-items'].innerHTML.includes('<strong>ASA</strong>'));
  assert.match(elements['grid-2728'].innerHTML, /data-abstract="upcoming"[\s\S]*?id="card-asa-2027"/);
  context.refreshTimeSensitiveUI(new Date('2027-01-05T08:00:00Z'));
  assert(elements['alert-items'].innerHTML.includes('<strong>ASA</strong>'));
  assert.match(elements['grid-2728'].innerHTML, /data-abstract="open"[\s\S]*?id="card-asa-2027"/);
  assert(elements['list-tbody'].innerHTML.includes('class="abstract-open" target="_blank">Submit</a>'));
  context.refreshTimeSensitiveUI(new Date('2027-03-31T07:00:00Z'));
  assert.equal(elements['alert-banner'].style.display, 'none');
  assert.equal(elements['alert-items'].innerHTML, '');
  assert(!elements['grid-2728'].innerHTML.includes('Submit Abstract (OPEN)'));
  assert(!elements['list-tbody'].innerHTML.includes('class="abstract-open" target="_blank">Submit</a>'));
  context.refreshTimeSensitiveUI(new Date('2027-01-06T12:00:00Z'));
  assert.equal(elements['alert-banner'].style.display, '');
  assert.equal(vm.runInContext('currentFilter', context), 'open');
  assert.equal(vm.runInContext('currentView', context), 'list');
  for (const name of ['interval', 'focus', 'visibilitychange']) assert.equal(typeof callbacks[name], 'function');
});

test('Open Now filter uses the derived status on cards and list rows', () => {
  const { context, conferences } = load();
  const rows = Array.from(conferences).map(c => ({
    dataset: { abstract: context.getAbstractStatus(c, new Date('2027-01-06T12:00:00Z')), tags: c.tags.join(' ') },
    classList: { contains() { return false; }, toggle(name, hidden) { this[name] = hidden; } }
  }));
  context.document.querySelectorAll = selector => ['.conf-card', '#list-tbody tr'].includes(selector) ? rows : [];
  context.applyFilter('open');
  assert.deepEqual(rows.filter(r => !r.classList.hidden).map(r => r.dataset.abstract), ['open', 'open']);
  assert.deepEqual(rows.filter(r => !r.classList['list-hidden']).map(r => r.dataset.abstract), ['open', 'open']);
});
