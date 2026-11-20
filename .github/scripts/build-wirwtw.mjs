#!/usr/bin/env node
/**
 * Generates the WIRWTW ("What I Read/Watched This Week") pages from the
 * repository's GitHub Discussions labeled `wirwtw`:
 *
 *   wirwtw/index.html             every entry, newest first
 *   wirwtw/<YYYY-Www>/index.html  one page per discussion, named after the
 *                                 ISO week in its title, e.g. "What I
 *                                 Read/Watched This Week (2026-W47)" becomes
 *                                 wirwtw/2026-W47/, so supporting material
 *                                 can live next to it in that folder
 *
 * .github/workflows/pages.yml runs this before the Jekyll build, on every push
 * and on every discussion change. Nothing it writes is committed: each build
 * re-reads the discussions, so edits show up and deleted or unlabeled
 * discussions disappear on the next deploy.
 *
 * The build fails rather than publish something wrong: when one of the
 * owner's labeled discussions can't be published (no week or an invalid week
 * in its title, or a week another discussion already has), or when there
 * would be no pages at all. A failed build deploys nothing, so the live site
 * keeps its current pages. Discussions by anyone else are skipped with a
 * warning.
 *
 * Local preview (build into an empty directory, not into the repo):
 *   GITHUB_REPOSITORY=viniciuskneves/viniciuskneves.github.io \
 *   GITHUB_TOKEN="$(gh auth token)" \
 *   node .github/scripts/build-wirwtw.mjs "$(mktemp -d)"
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LABEL = 'wirwtw';
const SERIES_TITLE = 'What I Read/Watched This Week';
const SERIES_WEEK = /\b(\d{4})-W(\d{2})\b/i;

// An ISO year has 53 weeks when it ends on a Thursday, or when the year
// before ended on a Wednesday (0 = Sunday ... 4 = Thursday).
const dec31Weekday = (year) => (year + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400)) % 7;
const weeksInYear = (year) => (dec31Weekday(year) === 4 || dec31Weekday(year - 1) === 3 ? 53 : 52);

const QUERY = `
  query ($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      discussions(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          url
          bodyHTML
          bodyText
          createdAt
          lastEditedAt
          author { login }
          labels(first: 20) { nodes { name } }
        }
      }
    }
  }
`;

// bodyHTML points uploaded images and videos at
// private-user-images.githubusercontent.com URLs signed with a JWT that
// expires after 5 minutes, which would break them on a static page. The
// permanent github.com/user-attachments/assets/<uuid> URL redirects to a fresh
// signed URL on every request, so use that instead.
const SIGNED_ASSET_URL =
  /https:\/\/private-user-images\.githubusercontent\.com\/\d+\/\d+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.\w+\?jwt=[^"'\s<>]*/g;

const [outDir] = process.argv.slice(2);
const { GITHUB_REPOSITORY, GITHUB_TOKEN, SITE_URL = '' } = process.env;
if (!outDir || !GITHUB_REPOSITORY || !GITHUB_TOKEN) {
  console.error(
    'usage: GITHUB_REPOSITORY=<owner>/<repo> GITHUB_TOKEN=<token> node build-wirwtw.mjs <out-dir>',
  );
  process.exit(1);
}
const [owner, name] = GITHUB_REPOSITORY.split('/');
const siteUrl = SITE_URL.replace(/\/+$/, '');

// Messages only ever contain discussion numbers and logins, never titles, so
// discussion content can't inject workflow commands into the Actions log.
const warn = (message) => console.log(`::warning::${message}`);
const logError = (message) => console.log(`::error::${message}`);

async function fetchDiscussions() {
  const discussions = [];
  let cursor = null;
  do {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `bearer ${GITHUB_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': 'wirwtw-site-builder',
      },
      body: JSON.stringify({ query: QUERY, variables: { owner, name, cursor } }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.errors) {
      throw new Error(`GitHub GraphQL request failed (HTTP ${res.status}): ${JSON.stringify(json.errors ?? json)}`);
    }
    const { nodes, pageInfo } = json.data.repository.discussions;
    discussions.push(...nodes);
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);
  return discussions;
}

function selectEntries(discussions) {
  const byWeek = new Map();
  const problems = [];
  for (const discussion of discussions) {
    if (!discussion.labels.nodes.some((label) => label.name === LABEL)) continue;

    // Anyone can open a discussion on a public repo, and category forms can
    // apply labels automatically, so only the owner's discussions get published.
    // Other people's only warn: failing on them would let anyone block deploys.
    const author = discussion.author?.login;
    if (author !== owner) {
      warn(`Skipping discussion #${discussion.number}: it is by ${author ?? 'a deleted account'}, only discussions by ${owner} are published.`);
      continue;
    }

    // From here on it is the owner's own post, so anything that would keep it
    // off the site fails the build instead of being skipped.
    const match = discussion.title.match(SERIES_WEEK);
    if (!match) {
      problems.push(`Discussion #${discussion.number}: its title needs the ISO week, e.g. "(2026-W47)", to decide the page URL.`);
      continue;
    }

    const [year, weekNumber] = [Number(match[1]), Number(match[2])];
    if (weekNumber < 1 || weekNumber > weeksInYear(year)) {
      problems.push(`Discussion #${discussion.number}: its title says week ${match[2]}, but ${year} has weeks 01 to ${weeksInYear(year)}.`);
      continue;
    }

    // Zero-padded, so newest first is a plain string sort.
    const week = `${year}-W${match[2]}`;
    const taken = byWeek.get(week);
    if (taken) {
      problems.push(`Discussions #${taken.number} and #${discussion.number} are both for ${week}; rename one of them.`);
      continue;
    }
    byWeek.set(week, { ...discussion, week });
  }

  // Report every problem in one run, not just the first.
  if (problems.length) {
    for (const problem of problems) logError(problem);
    throw new Error('Not deploying until the problems above are fixed; the live site keeps its current pages.');
  }
  return [...byWeek.values()].sort((a, b) => b.week.localeCompare(a.week));
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

const timeTag = (iso) => `<time datetime="${iso}">${formatDate(iso)}</time>`;

function excerpt(text, max = 160) {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
}

function layout({ title, description, urlPath, ogType, main }) {
  const head = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:type" content="${ogType}">`,
  ];
  if (description) {
    head.push(
      `<meta name="description" content="${escapeHtml(description)}">`,
      `<meta property="og:description" content="${escapeHtml(description)}">`,
    );
  }
  if (siteUrl) {
    head.push(
      `<link rel="canonical" href="${escapeHtml(siteUrl + urlPath)}">`,
      `<meta property="og:url" content="${escapeHtml(siteUrl + urlPath)}">`,
    );
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head.join('\n')}
<style>${CSS}</style>
</head>
<body>
<main>
${main}
</main>
</body>
</html>
`;
}

function renderEntry(entry) {
  const body = entry.bodyHTML.replace(SIGNED_ASSET_URL, 'https://github.com/user-attachments/assets/$1');
  if (body.includes('private-user-images.githubusercontent.com')) {
    warn(`Discussion #${entry.number} still links to an expiring private-user-images URL; that image may break after 5 minutes.`);
  }
  const edited =
    entry.lastEditedAt && formatDate(entry.lastEditedAt) !== formatDate(entry.createdAt)
      ? ` · updated ${timeTag(entry.lastEditedAt)}`
      : '';
  return layout({
    title: entry.title,
    description: excerpt(entry.bodyText),
    urlPath: `/${LABEL}/${entry.week}/`,
    ogType: 'article',
    main: `<nav class="crumb"><a href="../">← ${SERIES_TITLE}</a></nav>
<article>
<header>
<h1 class="page-title">${escapeHtml(entry.title)}</h1>
<p class="meta">${timeTag(entry.createdAt)}${edited} · <a href="${escapeHtml(entry.url)}">Discuss on GitHub</a></p>
</header>
<div class="markdown-body">
${body}
</div>
</article>`,
  });
}

function renderIndex(entries) {
  const list = `<ul class="entries">
${entries
  .map((e) => `<li><a href="${e.week}/">${escapeHtml(e.title)}</a> ${timeTag(e.createdAt)}</li>`)
  .join('\n')}
</ul>`;
  return layout({
    title: SERIES_TITLE,
    description: `${SERIES_TITLE}: articles and videos, one post per week.`,
    urlPath: `/${LABEL}/`,
    ogType: 'website',
    main: `<nav class="crumb"><a href="../">← Home</a></nav>
<h1 class="page-title">${SERIES_TITLE}</h1>
${list}`,
  });
}

async function write(relativePath, html) {
  const file = path.join(outDir, relativePath);
  if (existsSync(file)) {
    throw new Error(`${relativePath} already exists and would be overwritten by a generated page; move it, or build into an empty directory.`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, html);
  console.log(`wrote ${relativePath}`);
}

// Light theme only, to match the hand-written pages under wirwtw/. The
// selectors cover the markup GitHub emits in bodyHTML.
const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2328; background: #fff; }
main { max-width: 760px; margin: 0 auto; padding: 32px 20px 96px; }
a { color: #0969da; }
.crumb { margin: 0 0 28px; font-size: 14px; }
.crumb a { text-decoration: none; }
.crumb a:hover { text-decoration: underline; }
.page-title { margin: 0 0 .35rem; font-size: clamp(1.7rem, 4vw, 2.2rem); line-height: 1.2; }
.meta { margin: 0 0 2rem; color: #59636e; font-size: 14px; }
.entries { list-style: none; margin: 1.5rem 0 0; padding: 0; }
.entries li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; padding: 14px 0; border-top: 1px solid #d1d9e0; }
.entries time { color: #59636e; font-size: 14px; white-space: nowrap; }

.markdown-body { overflow-wrap: break-word; }
.markdown-body > :first-child { margin-top: 0 !important; }
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 { margin: 1.5em 0 .6em; font-weight: 600; line-height: 1.25; }
.markdown-body h1 { font-size: 1.6em; padding-bottom: .3em; border-bottom: 1px solid #d1d9e0; }
.markdown-body h2 { font-size: 1.35em; padding-bottom: .3em; border-bottom: 1px solid #d1d9e0; }
.markdown-body h3 { font-size: 1.15em; }
.markdown-body h4, .markdown-body h5, .markdown-body h6 { font-size: 1em; }
.markdown-body .anchor { display: none; }
.markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body blockquote,
.markdown-body pre, .markdown-body table, .markdown-body details, .markdown-body .markdown-alert { margin: 0 0 1em; }
.markdown-body ul, .markdown-body ol { padding-left: 2em; }
.markdown-body li ul, .markdown-body li ol { margin: .25em 0 0; }
.markdown-body li + li { margin-top: .4em; }
.markdown-body img, .markdown-body video { max-width: 100%; height: auto; }
.markdown-body blockquote { margin-left: 0; padding: 0 1em; color: #59636e; border-left: .25em solid #d1d9e0; }
.markdown-body hr { height: .25em; margin: 1.5em 0; border: 0; background: #d1d9e0; }
.markdown-body code { padding: .15em .35em; border-radius: 6px; background: rgba(129, 139, 152, .12); font: .875em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.markdown-body pre { padding: 16px; overflow: auto; border-radius: 6px; background: #f6f8fa; line-height: 1.45; }
.markdown-body pre code { padding: 0; background: none; font-size: 85%; }
.markdown-body .highlight pre { font: 85%/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.markdown-body table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; }
.markdown-body th, .markdown-body td { padding: 6px 13px; border: 1px solid #d1d9e0; }
.markdown-body tr:nth-child(2n) { background: #f6f8fa; }
.markdown-body .task-list-item { list-style: none; }
.markdown-body .task-list-item-checkbox { margin: 0 .3em .2em -1.4em; vertical-align: middle; }
.markdown-body svg.octicon { fill: currentColor; vertical-align: text-bottom; }
.markdown-body .markdown-alert { padding: .5em 1em; border-left: .25em solid var(--alert); }
.markdown-body .markdown-alert > :last-child { margin-bottom: 0; }
.markdown-body .markdown-alert-title { display: flex; align-items: center; gap: .5em; margin: 0 0 .25em; color: var(--alert); font-weight: 600; }
.markdown-alert-note { --alert: #0969da; }
.markdown-alert-tip { --alert: #1a7f37; }
.markdown-alert-important { --alert: #8250df; }
.markdown-alert-warning { --alert: #9a6700; }
.markdown-alert-caution { --alert: #d1242f; }
.pl-c { color: #59636e; }
.pl-c1, .pl-ent, .pl-s .pl-v { color: #0550ae; }
.pl-e, .pl-en { color: #6639ba; }
.pl-k { color: #cf222e; }
.pl-s, .pl-pds, .pl-sr { color: #0a3069; }
.pl-v, .pl-smw { color: #953800; }
.pl-mi1 { color: #116329; background: #dafbe1; }
.pl-md { color: #82071e; background: #ffebe9; }
`;

try {
  const entries = selectEntries(await fetchDiscussions());
  // An empty list is almost always a mistake (a removed label, a deleted
  // discussion), so fail instead of deploying it; the live site keeps its pages.
  if (entries.length === 0) {
    throw new Error(`No WIRWTW pages to publish: there are no discussions by ${owner} labeled "${LABEL}".`);
  }
  for (const entry of entries) {
    await write(path.join(LABEL, entry.week, 'index.html'), renderEntry(entry));
  }
  await write(path.join(LABEL, 'index.html'), renderIndex(entries));
} catch (error) {
  console.log(`::error::${error.message}`);
  process.exit(1);
}
