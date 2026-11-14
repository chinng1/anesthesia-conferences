#!/usr/bin/env node
/*
Monthly health check for the CONFERENCES data in index.html: broken links and
deadlines or calls that need attention.

Prints a Markdown report. It never edits index.html; a person reviews the report
and makes the changes. Node standard library only (Node 18+).

    node check_conferences.cjs                       # full check, report to stdout
    node check_conferences.cjs --no-links            # deadlines only (fast)
    node check_conferences.cjs --today 2027-01-10 --out report.md
*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOON_DAYS = 42;           // "closing soon" means under 6 weeks out
const CHECK_CALL_MONTHS = 9;    // TBD meetings starting within this many months: look for a call
const STALE_DATA_DAYS = 90;     // warn if "Last updated" is older than this
const CALENDAR_WARN_DAYS = 90;  // warn when the sidebar calendar is about to run out
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BLOCKED_CODES = new Set([401, 403, 429]); // many society sites block bots but are fine

function parseArgs(argv) {
  const args = { html: path.join(__dirname, 'index.html'), today: null, links: true, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-links') args.links = false;
    else if (a === '--today') args.today = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--html') args.html = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

// Load the page's own script with a stub DOM, so the report uses the site's real status logic.
function loadPage(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const stub = () => ({ innerHTML: '', style: {}, addEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return null; } });
  const elements = {};
  const context = {
    Intl, Date, console,
    document: { hidden: false, getElementById: id => (elements[id] ||= stub()),
      querySelectorAll() { return []; }, addEventListener() {} },
    window: { addEventListener() {} },
    setInterval() {}
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  const updated = (html.match(/Last updated:\s*([A-Z][a-z]+ \d{1,2}, \d{4})/) || [])[1] || null;
  return {
    conferences: vm.runInContext('CONFERENCES', context),
    calEnd: vm.runInContext('typeof CAL_END !== "undefined" ? CAL_END : null', context),
    status: (c, now) => context.getAbstractStatus(c, now),
    deadlinePassed: (c, now) => Boolean(context.deadlinePassed(c, now)),
    updated
  };
}

const ymd = a => a ? new Date(Date.UTC(a[0], a[1] - 1, a[2])) : null;
const days = (a, b) => Math.floor((a - b) / 86400000);
const fmt = d => d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
const md = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function closeDate(c) {
  if (c.abstractClosesAt) return new Date(c.abstractClosesAt);
  return ymd(c.abstractDeadline);
}

function checkConference(c, page, now, today) {
  const issues = [];
  const status = page.status(c, now);
  const start = ymd(c.start);
  const end = ymd(c.end || c.start);

  if (end && today > end) {
    issues.push(['Meeting is over', "move it to the past-cycle section (ay: 'past') or remove it"]);
    return issues;
  }
  if (c.abstractDeadlineKind === 'award' && page.deadlinePassed(c, now)) {
    issues.push(['Award deadline passed; general submission status unknown',
      'check whether regular abstracts are still accepted and update the entry']);
  }
  if (status === 'open') {
    const close = closeDate(c);
    if (close) {
      const left = days(close, today);
      if (left <= SOON_DAYS) issues.push([`Open call closes in ${left} day${left === 1 ? '' : 's'}`,
        'remind residents; confirm the deadline has not been extended']);
    } else {
      issues.push(['Marked open with no deadline', 'find the deadline and add it']);
    }
  }
  if (status === 'upcoming') {
    issues.push(['Call has a confirmed future opening', 'confirm the opening date still holds']);
  }
  const cmeOnly = /\bCME\b/.test(c.abstractDeadlineText || '');
  if (status === 'tbd' && start && c.abstractDeadlineKind !== 'award' && !cmeOnly) {
    const monthsOut = days(start, today) / 30.4;
    if (monthsOut <= CHECK_CALL_MONTHS) {
      issues.push([`Call TBD; meeting starts in ~${Math.max(0, Math.round(monthsOut))} months`,
        'check the society site for an abstract call or confirm there is none (CME-only)']);
    }
  }
  if (!c.start) issues.push(['Meeting dates TBD', 'check whether dates have been announced']);
  return issues;
}

async function checkUrl(url, timeoutMs = 20000) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*;q=0.8' } });
      if (res.ok) return ['ok', String(res.status)];
      if (method === 'HEAD' && [400, 403, 404, 405, 500, 501, 503].includes(res.status)) continue;
      if (BLOCKED_CODES.has(res.status)) return ['blocked', `HTTP ${res.status}`];
      return ['broken', `HTTP ${res.status}`];
    } catch (err) {
      if (method === 'HEAD') continue;
      const reason = err.cause?.code || err.cause?.message || err.name || String(err);
      if (/CERT|SSL|TLS/i.test(reason)) return ['blocked', 'certificate problem (usually opens fine in a browser)'];
      return ['broken', String(reason).slice(0, 100)];
    }
  }
  return ['broken', 'no response'];
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  return results;
}

async function buildReport(page, now, checkLinks) {
  // Calendar day in Pacific time (UCSF), stored as midnight UTC for day arithmetic.
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
    year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now).map(x => [x.type, x.value]));
  const today = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  const current = page.conferences.filter(c => c.ay !== 'past');
  const lines = [`# Conference guide check — ${fmt(today)}`, '',
    `${current.length} current conferences (${page.conferences.length - current.length} past-cycle), ` +
    `page last updated ${page.updated || 'unknown'}.`, ''];

  if (page.updated) {
    const age = days(today, new Date(page.updated + ' UTC'));
    if (age > STALE_DATA_DAYS) lines.push(`> ⚠️ The data was last updated ${age} days ago. ` +
      'Consider a full review against the society websites.', '');
  }
  if (page.calEnd) {
    const left = days(page.calEnd, today);
    if (left <= CALENDAR_WARN_DAYS) lines.push(`> ⚠️ The sidebar calendar ends ${fmt(page.calEnd)} ` +
      `(${left} days away). Extend CAL_START/CAL_END and add the next academic year.`, '');
  }

  const openNow = current.filter(c => page.status(c, now) === 'open');
  lines.push(`## Open calls right now (${openNow.length})`, '');
  if (openNow.length) {
    lines.push('| Conference | Deadline |', '|---|---|');
    openNow.sort((a, b) => (closeDate(a) || Infinity) - (closeDate(b) || Infinity))
      .forEach(c => lines.push(`| [${md(c.name)}](${c.abstractUrl || c.url}) | ${md(c.abstractDeadlineText)} |`));
  } else lines.push('None.');
  lines.push('');

  const rows = [];
  for (const c of current) for (const [problem, fix] of checkConference(c, page, now, today)) rows.push([c, problem, fix]);
  lines.push(`## Needs attention (${rows.length})`, '');
  if (rows.length) {
    lines.push('| Conference | Deadline text | Problem | Suggested fix |', '|---|---|---|---|');
    for (const [c, problem, fix] of rows)
      lines.push(`| [${md(c.name)}](${c.url}) \`${c.id}\` | ${md(c.abstractDeadlineText)} | ${problem} | ${fix} |`);
  } else lines.push('None.');
  lines.push('');
  const cme = current.filter(c => /\bCME\b/.test(c.abstractDeadlineText || '')).length;
  if (cme) lines.push(`${cme} CME-only meetings with no abstract call are not flagged; spot-check them once a year.`, '');

  let broken = [];
  if (checkLinks) {
    const targets = [];
    for (const c of current) {
      targets.push([c, 'page', c.url]);
      if (c.abstractUrl && c.abstractUrl !== c.url) targets.push([c, 'abstract', c.abstractUrl]);
    }
    const unique = [...new Set(targets.map(t => t[2]))];
    const results = new Map(unique.map((u, i) => [u, null]));
    const checked = await mapLimit(unique, 8, checkUrl);
    unique.forEach((u, i) => results.set(u, checked[i]));
    broken = targets.filter(t => results.get(t[2])[0] === 'broken');
    const blocked = targets.filter(t => results.get(t[2])[0] === 'blocked');
    const ok = targets.length - broken.length - blocked.length;
    lines.push(`## Links: ${ok} OK, ${blocked.length} blocked bots, ${broken.length} broken`, '');
    if (broken.length) {
      lines.push('### Broken (check these by hand)', '', '| Conference | Link | URL | Error |', '|---|---|---|---|');
      for (const [c, kind, url] of broken)
        lines.push(`| ${md(c.name)} \`${c.id}\` | ${kind} | ${url} | ${md(results.get(url)[1])} |`);
      lines.push('');
    }
    if (blocked.length) {
      lines.push('<details><summary>Blocked automated checks (usually fine)</summary>', '');
      for (const [c, kind, url] of blocked) lines.push(`- ${md(c.name)} (${kind}): ${url} (${results.get(url)[1]})`);
      lines.push('', '</details>', '');
    }
  }

  lines.push('---', 'Generated by `check_conferences.cjs`. It never changes index.html: ' +
    'fix entries by hand (or with Claude), update "Last updated", commit, and push to update the site.');
  return { report: lines.join('\n'), nIssues: rows.length, nBroken: broken.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // --today pins the clock to noon Pacific on that date, like a person checking that day.
  const now = args.today ? new Date(`${args.today}T12:00:00-08:00`) : new Date();
  const page = loadPage(args.html);
  const { report, nIssues, nBroken } = await buildReport(page, now, args.links);
  console.log(report);
  if (args.out) fs.writeFileSync(args.out, report);
  console.log(`\nSummary: ${nIssues} items need attention, ${nBroken} broken links.`);
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
module.exports = { loadPage, buildReport };
