// Builds the Lines Police CAD status page from the data Upptime commits.
//
// Upptime's own Svelte status site is not used. Everything it writes to this
// repository is still the source of truth:
//
//   history/summary.json   per site: status, uptime windows, response times,
//                          and dailyMinutesDown, which is what the 90 day
//                          strip is drawn from
//   history/<slug>.yml     the latest check, including when monitoring started
//   GitHub issues          an incident per outage, labelled "status" plus the
//                          site's slug, with Upptime's updates as comments
//
// So the checks, the alerting and the incident record are untouched; only the
// page a customer sees is ours.
//
// Lives outside site/, which Upptime's own site command creates and owns.
//
// Usage:
//   node status-page/build.mjs     # writes status-page/dist
//   GITHUB_TOKEN=... node status-page/build.mjs
//
// Without a token the page still builds, with the incident list omitted rather
// than silently shown as empty. No dependencies: this runs on a bare Node.

import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(here, "dist");

const DAYS = 90;
const INCIDENT_DAYS = 14;
const REPO = process.env.GITHUB_REPOSITORY || "Linesmerrill/police-cad-status";
const TOKEN = (process.env.GITHUB_TOKEN || "").trim();

// ---------------------------------------------------------------- reading ---

/**
 * The handful of `key: value` lines Upptime writes per site. A real YAML parser
 * would be a dependency for a file shaped like an .env.
 */
function readHistoryFile(slug) {
  const text = readFileSync(join(root, "history", `${slug}.yml`), "utf8");
  const out = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function readConfig() {
  // Only the two fields the page needs, read the same forgiving way.
  const text = readFileSync(join(root, ".upptimerc.yml"), "utf8");
  const cname = /^\s*cname:\s*(\S+)/m.exec(text);
  const name = /^\s*name:\s*(.+)$/m.exec(text.slice(text.indexOf("status-website:")));
  return {
    cname: cname ? cname[1] : "status.linespolice-cad.com",
    name: name ? name[1].trim() : "Lines Police CAD Status",
  };
}

function readSites() {
  const summary = JSON.parse(readFileSync(join(root, "history", "summary.json"), "utf8"));
  return summary.map((site) => {
    let history = {};
    try {
      history = readHistoryFile(site.slug);
    } catch {
      // A site in the summary with no history file yet: treat it as unmonitored
      // rather than failing the build.
    }
    return {
      ...site,
      startTime: history.startTime ? new Date(history.startTime) : null,
      lastUpdated: history.lastUpdated ? new Date(history.lastUpdated) : null,
      responseTime: Number(history.responseTime || site.time || 0),
      liveStatus: history.status || site.status,
    };
  });
}

// -------------------------------------------------------------- incidents ---

async function github(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${TOKEN}`,
      "User-Agent": "lpc-status-page",
    },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);
  return res.json();
}

/**
 * Every incident the repository holds, newest first, each with the updates
 * posted on it.
 *
 * Upptime opens an issue when a site goes down and comments as it recovers, so
 * the issue is the incident and its comments are the timeline. Issues labelled
 * "maintenance" are ours rather than Upptime's and are shown the same way.
 *
 * The front page shows the last two weeks and a service page shows that
 * service's whole history, so both come out of this one pass. Comments are
 * fetched only for the most recent COMMENT_FETCH_LIMIT, which keeps a long
 * history from turning into a hundred API calls for timelines nobody scrolls
 * that far to read.
 */
const COMMENT_FETCH_LIMIT = 25;

async function readIncidents(sites) {
  if (!TOKEN) return null;

  const issues = await github(`/repos/${REPO}/issues?state=all&per_page=100&sort=created&direction=desc`);
  const slugToName = new Map(sites.map((s) => [s.slug, s.name]));

  const incidents = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
    if (!labels.includes("status") && !labels.includes("maintenance")) continue;

    const slug = labels.find((l) => slugToName.has(l)) || "";
    incidents.push({
      number: issue.number,
      url: issue.html_url,
      title: cleanTitle(issue.title),
      slug,
      component: slugToName.get(slug) || "",
      maintenance: labels.includes("maintenance"),
      created: new Date(issue.created_at),
      closed: issue.closed_at ? new Date(issue.closed_at) : null,
      comments: issue.comments,
      updates: [],
    });
  }

  for (const incident of incidents.slice(0, COMMENT_FETCH_LIMIT)) {
    if (!incident.comments) continue;
    try {
      const comments = await github(`/repos/${REPO}/issues/${incident.number}/comments?per_page=100`);
      incident.updates = comments.map((c) => ({ at: new Date(c.created_at), ...parseUpdate(c.body) }));
    } catch {
      // An incident with its updates missing is still worth showing.
    }
  }
  return incidents;
}

/** Upptime puts an emoji in front of every issue title; the words are enough. */
function cleanTitle(title) {
  return String(title || "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
}

/**
 * One update, from a comment Upptime (or a person) posted on the incident.
 *
 * The convention both follow is a leading label: "**Resolved:** the bot is
 * back". The label is worth pulling out so the timeline reads at a glance, and
 * the little markdown that appears in these comments is stripped rather than
 * shown as asterisks.
 */
function parseUpdate(body) {
  const plain = plainText(body);
  const line = plain.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
  const labelled =
    /^(Resolved|Investigating|Identified|Monitoring|Update|Scheduled|In progress|Completed)\s*[:.-]\s*(.*)$/i.exec(line);
  if (labelled && labelled[2]) {
    return { label: titleCase(labelled[1]), text: truncate(labelled[2].trim()) };
  }
  return { label: "", text: truncate(line) };
}

/**
 * A comment is whatever someone typed: markdown from Upptime, and on a
 * post-mortem, pasted HTML. Both have to come out as the sentence a reader
 * wants, not as tags and link syntax.
 */
function plainText(body) {
  return String(body || "")
    .replace(/<\/(p|div|br|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/^[^\p{L}\p{N}\n]+/gmu, "")
    .replace(/[ \t]+/g, " ");
}

const UPDATE_MAX = 320;

/** Long updates get their first part; the incident link has the rest. */
function truncate(text) {
  if (text.length <= UPDATE_MAX) return text;
  const cut = text.slice(0, UPDATE_MAX);
  const at = cut.lastIndexOf(" ");
  return `${(at > UPDATE_MAX * 0.6 ? cut.slice(0, at) : cut).trimEnd()}...`;
}

const titleCase = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

// ----------------------------------------------------------------- shaping ---

const DAY = 86400_000;

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * One entry per day for the strip, oldest first.
 *
 * A day Upptime recorded no downtime for is a full day up, but only once
 * monitoring had started: before that there is nothing to claim, and the strip
 * says so rather than drawing 90 reassuring green bars on day one.
 */
function dailyBars(site) {
  const today = new Date();
  const bars = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - i * DAY);
    const key = dayKey(date);
    if (site.startTime && date.getTime() + DAY <= site.startTime.getTime()) {
      bars.push({ key, state: "nodata", minutesDown: 0, uptime: null });
      continue;
    }
    const minutesDown = Number((site.dailyMinutesDown || {})[key] || 0);
    const uptime = Math.max(0, (1440 - minutesDown) / 1440);
    bars.push({ key, state: barState(uptime), minutesDown, uptime });
  }
  return bars;
}

function barState(uptime) {
  if (uptime >= 1) return "up";
  if (uptime >= 0.99) return "minor";
  if (uptime >= 0.95) return "moderate";
  if (uptime >= 0.8) return "major";
  return "down";
}

function overall(sites) {
  const down = sites.filter((s) => s.liveStatus === "down");
  const degraded = sites.filter((s) => s.liveStatus === "degraded");
  if (down.length === 1) return { level: "down", text: `${down[0].name} is down` };
  if (down.length > 1) return { level: "down", text: `${down.length} services are down` };
  if (degraded.length === 1) return { level: "degraded", text: `${degraded[0].name} is degraded` };
  if (degraded.length > 1) return { level: "degraded", text: `${degraded.length} services are degraded` };
  return { level: "up", text: "All systems operational" };
}

const STATUS_LABEL = { up: "Operational", degraded: "Degraded", down: "Down" };

// --------------------------------------------------------------- rendering ---

const escapeHTML = (value) =>
  String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const UTC_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const UTC_DATE_SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const UTC_TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

const formatDate = (date) => UTC_DATE.format(date);
const formatStamp = (date) => `${UTC_DATE_SHORT.format(date)}, ${UTC_TIME.format(date)} UTC`;

function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ${hours % 24}h`;
}

function barTitle(bar) {
  const date = formatDate(new Date(`${bar.key}T00:00:00Z`));
  if (bar.state === "nodata") return `${date}: not monitored`;
  if (bar.minutesDown === 0) return `${date}: no downtime`;
  return `${date}: down for ${formatDuration(bar.minutesDown * 60000)} (${(bar.uptime * 100).toFixed(2)}% up)`;
}

function barNote(bar) {
  if (bar.state === "nodata") return "Not monitored on this day.";
  if (bar.minutesDown === 0) return "No downtime recorded on this day.";
  return `Down for ${formatDuration(bar.minutesDown * 60000)}, ${(bar.uptime * 100).toFixed(2)}% up.`;
}

/**
 * The 90 day strip.
 *
 * Each bar carries its own date and note so the tooltip is already in the
 * markup: hovering asks the page nothing it does not already know, and with
 * JavaScript off the strip is still a correct picture with a readable label.
 */
function renderStrip(site) {
  const bars = dailyBars(site)
    .map(
      (bar) =>
        `<span class="bar bar-${bar.state}" data-date="${escapeHTML(formatDate(new Date(`${bar.key}T00:00:00Z`)))}" data-note="${escapeHTML(barNote(bar))}"></span>`,
    )
    .join("");
  return `<div class="strip" role="img" aria-label="Daily uptime for ${escapeHTML(site.name)} over the past ${DAYS} days">${bars}</div>`;
}

function stripLegend(site) {
  const since =
    site.startTime && Date.now() - site.startTime.getTime() < DAYS * DAY
      ? `Monitored since ${formatDate(site.startTime)}`
      : `${DAYS} days ago`;
  return `
        <p class="strip-legend">
          <span class="since">${escapeHTML(since)}</span>
          <span class="rule"></span>
          <span class="uptime">${escapeHTML(site.uptime)} uptime</span>
          <span class="rule"></span>
          <span>Today</span>
        </p>`;
}

const liveStatusOf = (site) =>
  site.liveStatus === "degraded" || site.liveStatus === "down" ? site.liveStatus : "up";

/** A service on the front page: the same card, with its own page behind it. */
function renderSite(site) {
  const status = liveStatusOf(site);
  return `
      <a class="service" href="service/${encodeURIComponent(site.slug)}/">
        <span class="service-head">
          <span class="service-name">${escapeHTML(site.name)}</span>
          <span class="pill pill-${status}">${STATUS_LABEL[status]}</span>
        </span>
        ${renderStrip(site)}
        ${stripLegend(site)}
      </a>`;
}

function renderIncidentCard(incident, { showComponent = false } = {}) {
  const outcome = incident.closed
    ? `Resolved after ${formatDuration(incident.closed - incident.created)}`
    : "Ongoing";
  const window = incident.closed
    ? `${formatStamp(incident.created)} to ${UTC_TIME.format(incident.closed)} UTC`
    : `Started ${formatStamp(incident.created)}`;

  const updates = [...incident.updates]
    .sort((a, b) => b.at - a.at)
    .map(
      (u) => `
            <li>
              <p>${u.label ? `<span class="update-label">${escapeHTML(u.label)}</span> ` : ""}${escapeHTML(u.text)}</p>
              <time>${escapeHTML(formatStamp(u.at))}</time>
            </li>`,
    )
    .join("");

  return `
        <article class="incident"${incident.slug ? ` data-slug="${escapeHTML(incident.slug)}"` : ""}>
          <h4>${escapeHTML(incident.title)}</h4>
          <p class="incident-meta">
            <span class="outcome${incident.closed ? "" : " outcome-open"}">${escapeHTML(outcome)}</span>
            ${showComponent && incident.component ? `<span>${escapeHTML(incident.component)}</span>` : ""}
            <span>${escapeHTML(window)}</span>
          </p>
          ${updates ? `<ul class="updates">${updates}\n          </ul>` : ""}
          <a class="incident-link" href="${escapeHTML(incident.url)}">Incident #${incident.number}</a>
        </article>`;
}

/** Incidents by day for the last two weeks, the way a status page reads. */
function renderIncidentDays(incidents) {
  if (incidents === null) {
    return `<p class="muted">Incident history is unavailable right now.</p>`;
  }
  const today = new Date();
  const days = [];
  for (let i = 0; i < INCIDENT_DAYS; i++) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - i * DAY);
    const key = dayKey(date);
    const onThisDay = incidents.filter((incident) => dayKey(incident.created) === key);
    days.push(`
      <section class="day">
        <h3>${escapeHTML(formatDate(date))}</h3>
        ${
          onThisDay.length === 0
            ? `<p class="muted">No incidents reported${i === 0 ? " today" : ""}.</p>`
            : onThisDay.map((incident) => renderIncidentCard(incident, { showComponent: true })).join("")
        }
      </section>`);
  }
  return days.join("");
}

// ------------------------------------------------------------ service page ---

/** A labelled figure: the number first, because that is what is being read. */
function statTile(label, value, note = "") {
  return `
        <div class="stat">
          <span class="stat-value">${escapeHTML(value)}</span>
          <span class="stat-label">${escapeHTML(label)}</span>
          ${note ? `<span class="stat-note">${escapeHTML(note)}</span>` : ""}
        </div>`;
}

/**
 * Response time across the windows Upptime records.
 *
 * Upptime keeps averages, not a series, so this compares the windows it has
 * rather than drawing a line through points that were never measured. Bars are
 * relative to the slowest window, with the millisecond figure on each.
 */
function renderResponseChart(site) {
  const rows = [
    ["Last check", site.responseTime],
    ["24 hours", site.timeDay],
    ["7 days", site.timeWeek],
    ["30 days", site.timeMonth],
    ["1 year", site.timeYear],
  ].filter(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0);

  if (rows.length === 0) return `<p class="muted">No response times recorded yet.</p>`;
  const max = Math.max(...rows.map(([, value]) => Number(value)));

  return `
        <div class="chart-rows">
${rows
  .map(
    ([label, value]) => `          <div class="chart-row">
            <span class="chart-label">${escapeHTML(label)}</span>
            <span class="chart-track"><span class="chart-fill" style="width:${Math.max(2, Math.round((Number(value) / max) * 100))}%"></span></span>
            <span class="chart-value">${escapeHTML(String(Math.round(Number(value))))} ms</span>
          </div>`,
  )
  .join("\n")}
        </div>`;
}

/**
 * Downtime by day, for the days that had any.
 *
 * A column chart of 90 mostly empty days says less than a short list of the
 * days that actually went wrong, so that is what this is.
 */
function renderDowntimeDays(site) {
  const days = dailyBars(site)
    .filter((bar) => bar.minutesDown > 0)
    .reverse();
  if (days.length === 0) {
    return `<p class="muted">No downtime in the last ${DAYS} days.</p>`;
  }
  const max = Math.max(...days.map((d) => d.minutesDown));
  return `
        <div class="chart-rows">
${days
  .map(
    (day) => `          <div class="chart-row">
            <span class="chart-label">${escapeHTML(formatDate(new Date(`${day.key}T00:00:00Z`)))}</span>
            <span class="chart-track"><span class="chart-fill chart-fill-${day.state}" style="width:${Math.max(2, Math.round((day.minutesDown / max) * 100))}%"></span></span>
            <span class="chart-value">${escapeHTML(formatDuration(day.minutesDown * 60000))}</span>
          </div>`,
  )
  .join("\n")}
        </div>`;
}

function renderServicePage({ config, site, incidents, generatedAt }) {
  const status = liveStatusOf(site);
  const mine = incidents === null ? null : incidents.filter((incident) => incident.slug === site.slug);
  const host = (() => {
    try {
      return new URL(site.url).host;
    } catch {
      return site.url;
    }
  })();

  const body = `
    <a class="back" href="../../">All services</a>

    <div class="service-hero">
      <h2>${escapeHTML(site.name)}</h2>
      <span class="pill pill-${status}">${STATUS_LABEL[status]}</span>
    </div>
    <p class="service-sub">Checking <span class="host">${escapeHTML(host)}</span> every 5 minutes${
      site.startTime ? ` since ${escapeHTML(formatDate(site.startTime))}` : ""
    }.</p>

    <div class="stats">
${statTile("Last 24 hours", site.uptimeDay)}
${statTile("Last 7 days", site.uptimeWeek)}
${statTile("Last 30 days", site.uptimeMonth)}
${statTile("Last year", site.uptimeYear)}
    </div>

    <section class="panel">
      <h3>Uptime, past ${DAYS} days</h3>
      ${renderStrip(site)}
      ${stripLegend(site)}
    </section>

    <section class="panel">
      <h3>Response time</h3>
      ${renderResponseChart(site)}
    </section>

    <section class="panel">
      <h3>Downtime by day</h3>
      ${renderDowntimeDays(site)}
    </section>

    <h2 class="section-title">Incidents</h2>
    <div class="incidents">
      ${
        mine === null
          ? `<p class="muted">Incident history is unavailable right now.</p>`
          : mine.length === 0
            ? `<p class="muted">No incidents recorded for this service.</p>`
            : `<section class="day">${mine.map((incident) => renderIncidentCard(incident)).join("")}</section>`
      }
    </div>`;

  return layout({
    config,
    generatedAt,
    base: "../../",
    title: `${site.name} status`,
    description: `Uptime, response time and incident history for ${site.name}.`,
    markLevel: status,
    body,
    lastChecked: site.lastUpdated,
  });
}

// --------------------------------------------------------------- the shell ---

/**
 * Every page shares this: the masthead, the footer, the appearance toggle and
 * the tooltip. `base` is how deep the page sits, since the site is published as
 * plain files with relative links and no router.
 */
function layout({ config, generatedAt, base, title, description, markLevel, body, lastChecked }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(title)}</title>
<meta name="description" content="${escapeHTML(description)}">
<meta name="theme-color" content="#faf9f5">
<meta property="og:title" content="${escapeHTML(title)}">
<meta property="og:description" content="${escapeHTML(description)}">
<meta property="og:type" content="website">
<link rel="icon" href="${base}assets/lpc-logo.png">
<link rel="apple-touch-icon" href="${base}assets/lpc-logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${base}styles.css?v=${generatedAt.getTime()}">
<script>
  // Applied before the first paint so a dark-mode visitor never sees a white
  // flash. The page follows the system setting until someone picks a side.
  try {
    var saved = localStorage.getItem("lpc-status-theme");
    if (saved === "dark" || saved === "light") document.documentElement.dataset.theme = saved;
  } catch (e) {}
</script>
</head>
<body>
<a class="skip" href="#content">Skip to service status</a>

<header class="masthead">
  <div class="wrap masthead-inner">
    <a class="brand" href="${base}">
      <img class="brand-logo" src="${base}assets/lpc-logo.png" alt="" width="30" height="30">
      <span class="brand-name">Lines Police CAD <span>Status</span></span>
      <span class="brand-dot mark-${markLevel}" aria-hidden="true"></span>
    </a>
    <nav class="masthead-nav">
      <a href="https://www.linespolice-cad.com">Main site</a>
      <a class="btn" href="https://discord.gg/Y9ytW2ZMp4">Discord support</a>
      <button class="theme-toggle" type="button" aria-label="Switch between light and dark">
        <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9"/></svg>
        <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4z"/></svg>
      </button>
    </nav>
  </div>
</header>

<main id="content">
  <div class="wrap">${body}
  </div>
</main>

<footer class="footer">
  <div class="wrap footer-inner">
    <p>
      ${lastChecked ? `Last checked ${escapeHTML(formatStamp(lastChecked))}. ` : "Waiting for the first check. "}All times UTC.<br>
      Questions about the website, mobile app or bot? Ask in our Discord.
    </p>
    <nav>
      <a href="https://www.linespolice-cad.com">Lines Police CAD</a>
      <a href="https://discord.gg/Y9ytW2ZMp4">Discord</a>
      <a href="https://github.com/${escapeHTML(REPO)}">Monitoring data</a>
    </nav>
  </div>
</footer>

<div class="tip" role="status" aria-live="off" hidden>
  <p class="tip-date"></p>
  <p class="tip-note"></p>
</div>

<script>
  // The toggle flips the current appearance, whether that came from the system
  // or from an earlier choice, and remembers it.
  (function () {
    var button = document.querySelector(".theme-toggle");
    if (!button) return;
    var root = document.documentElement;
    var dark = window.matchMedia("(prefers-color-scheme: dark)");
    var isDark = function () {
      return root.dataset.theme ? root.dataset.theme === "dark" : dark.matches;
    };
    var label = function () {
      button.setAttribute("aria-label", isDark() ? "Switch to light appearance" : "Switch to dark appearance");
    };
    button.addEventListener("click", function () {
      root.dataset.theme = isDark() ? "light" : "dark";
      try {
        localStorage.setItem("lpc-status-theme", root.dataset.theme);
      } catch (e) {}
      label();
    });
    dark.addEventListener("change", label);
    label();
  })();

  // One tooltip, moved to whichever bar is under the pointer. The text is on
  // the bar itself, so this only positions and shows it; a bar near an edge is
  // nudged back inside the viewport rather than hanging off it.
  (function () {
    var tip = document.querySelector(".tip");
    if (!tip) return;
    var dateEl = tip.querySelector(".tip-date");
    var noteEl = tip.querySelector(".tip-note");

    function show(bar) {
      dateEl.textContent = bar.dataset.date || "";
      noteEl.textContent = bar.dataset.note || "";
      tip.hidden = false;
      var b = bar.getBoundingClientRect();
      var t = tip.getBoundingClientRect();
      var left = b.left + b.width / 2 - t.width / 2;
      left = Math.min(Math.max(8, left), window.innerWidth - t.width - 8);
      var top = b.top - t.height - 10;
      var below = top < 8;
      if (below) top = b.bottom + 10;
      tip.classList.toggle("tip-below", below);
      tip.style.left = Math.round(left + window.scrollX) + "px";
      tip.style.top = Math.round(top + window.scrollY) + "px";
      tip.style.setProperty("--arrow", Math.round(b.left + b.width / 2 + window.scrollX - left - window.scrollX) + "px");
    }

    function hide() {
      tip.hidden = true;
    }

    document.addEventListener("mouseover", function (event) {
      var bar = event.target.closest(".bar");
      if (bar) show(bar);
    });
    document.addEventListener("mouseout", function (event) {
      if (event.target.closest(".bar")) hide();
    });
    window.addEventListener("scroll", hide, { passive: true });
  })();
</script>
</body>
</html>
`;
}

function renderIndex({ config, sites, incidents, generatedAt }) {
  const state = overall(sites);
  const lastChecked = sites
    .map((s) => s.lastUpdated)
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

  const body = `
    <div class="banner banner-${state.level}">
      <h2>${escapeHTML(state.text)}</h2>
    </div>

    <p class="caption">Uptime over the past ${DAYS} days. Checked every 5 minutes. <a href="uptime/">View historical uptime</a>.</p>

    <div class="services">
${sites.map(renderSite).join("\n")}
    </div>

    <h2 class="section-title">Past incidents</h2>
    <div class="incidents">
${renderIncidentDays(incidents)}
    </div>

    <p class="more-link"><a href="history/">Incident history</a></p>`;

  return layout({
    config,
    generatedAt,
    base: "",
    title: config.name,
    description: "Live availability and uptime for the Lines Police CAD website, API and Discord bot.",
    markLevel: state.level,
    body,
    lastChecked,
  });
}

// ------------------------------------------------- uptime and history pages ---

const MONTHS_PER_WINDOW = 3;
const INCIDENTS_SHOWN_PER_MONTH = 3;

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const monthKey = (date) => date.toISOString().slice(0, 7);
const monthStart = (key) => new Date(`${key}-01T00:00:00Z`);
const monthName = (key) => MONTH_LABEL.format(monthStart(key));

/** Every month from the first day anything was monitored to this one, oldest first. */
function monthsCovered(sites, incidents) {
  const earliest = [
    ...sites.map((s) => s.startTime).filter(Boolean),
    ...(incidents || []).map((i) => i.created),
  ].sort((a, b) => a - b)[0];
  const now = new Date();
  const start = earliest || now;

  const keys = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  while (cursor <= last) {
    keys.push(monthKey(cursor));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return keys;
}

/**
 * Months in windows of three, newest window first, the way the pages page
 * through them. Page 1 is always the three months ending with this one.
 */
function windowsOf(monthKeys) {
  const windows = [];
  for (let end = monthKeys.length; end > 0; end -= MONTHS_PER_WINDOW) {
    windows.push(monthKeys.slice(Math.max(0, end - MONTHS_PER_WINDOW), end));
  }
  return windows;
}

/**
 * Per-day downtime for every service, as plain data the uptime page can
 * re-render from when someone picks another service or pages back.
 *
 * Only days from the day monitoring started are included: a month before a
 * service existed is blank rather than perfect.
 */
function uptimeDataset(sites) {
  const todayKey = dayKey(new Date());
  return sites.map((site) => {
    const days = {};
    if (site.startTime) {
      let cursor = new Date(
        Date.UTC(site.startTime.getUTCFullYear(), site.startTime.getUTCMonth(), site.startTime.getUTCDate()),
      );
      while (dayKey(cursor) <= todayKey) {
        const key = dayKey(cursor);
        days[key] = Number((site.dailyMinutesDown || {})[key] || 0);
        cursor = new Date(cursor.getTime() + DAY);
      }
    }
    return { slug: site.slug, name: site.name, days };
  });
}

/** Tabs shared by the two historical pages. */
function historyTabs(active, base) {
  const tab = (key, label, href) =>
    `<a class="tab${active === key ? " tab-on" : ""}" href="${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`;
  return `
    <nav class="tabs">
      ${tab("history", "Incidents", `${base}history/`)}
      ${tab("uptime", "Uptime", `${base}uptime/`)}
    </nav>`;
}

function renderUptimePage({ config, sites, incidents, generatedAt }) {
  const months = monthsCovered(sites, incidents);
  const dataset = uptimeDataset(sites);

  const body = `
    <a class="back" href="../">Current status</a>
    ${historyTabs("uptime", "../")}

    <div class="controls">
      <label class="field">
        <span class="sr-only">Service</span>
        <select id="service">
${sites.map((s) => `          <option value="${escapeHTML(s.slug)}">${escapeHTML(s.name)}</option>`).join("\n")}
        </select>
      </label>
      <div class="window-nav">
        <button type="button" id="older" aria-label="Earlier months">&#8249;</button>
        <span id="window-label"></span>
        <button type="button" id="newer" aria-label="Later months">&#8250;</button>
      </div>
    </div>

    <div id="months" class="months"></div>

    <noscript>
      <p class="muted">This view needs JavaScript. Each service's own page has its uptime and incidents without it:
      ${sites.map((s) => `<a href="../service/${escapeHTML(s.slug)}/">${escapeHTML(s.name)}</a>`).join(", ")}.</p>
    </noscript>

    <script id="uptime-data" type="application/json">${JSON.stringify({ months, services: dataset }).replace(/</g, "\\u003c")}</script>
    <script>
      (function () {
        var raw = document.getElementById("uptime-data");
        var data = JSON.parse(raw.textContent);
        var months = data.months;
        var services = data.services;
        if (!months.length || !services.length) return;

        var select = document.getElementById("service");
        var label = document.getElementById("window-label");
        var holder = document.getElementById("months");
        var older = document.getElementById("older");
        var newer = document.getElementById("newer");
        var perWindow = ${MONTHS_PER_WINDOW};

        var params = new URLSearchParams(location.search);
        var slug = params.get("service");
        if (!services.some(function (s) { return s.slug === slug; })) slug = services[0].slug;
        select.value = slug;
        // offset 0 is the window ending with this month; 1 is the one before.
        var offset = Math.max(0, parseInt(params.get("page") || "1", 10) - 1) || 0;

        function monthLabel(key) {
          var d = new Date(key + "-01T00:00:00Z");
          return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
        }

        function windowFor(off) {
          var end = months.length - off * perWindow;
          return months.slice(Math.max(0, end - perWindow), Math.max(0, end));
        }

        function stateFor(minutesDown) {
          var uptime = Math.max(0, (1440 - minutesDown) / 1440);
          if (uptime >= 1) return "up";
          if (uptime >= 0.99) return "minor";
          if (uptime >= 0.95) return "moderate";
          if (uptime >= 0.8) return "major";
          return "down";
        }

        function render() {
          var service = services.filter(function (s) { return s.slug === slug; })[0];
          var keys = windowFor(offset);
          holder.innerHTML = "";

          keys.forEach(function (key) {
            var first = new Date(key + "-01T00:00:00Z");
            var daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
            var monitored = 0;
            var down = 0;
            var cells = "";

            for (var pad = 0; pad < first.getUTCDay(); pad++) cells += '<span class="cell cell-pad"></span>';
            for (var day = 1; day <= daysInMonth; day++) {
              var dayKey = key + "-" + String(day).padStart(2, "0");
              var at = new Date(dayKey + "T00:00:00Z");
              if (at > new Date()) { cells += '<span class="cell cell-pad"></span>'; continue; }
              if (!(dayKey in service.days)) {
                cells += '<span class="cell cell-nodata" title="' + dayKey + ': not monitored"></span>';
                continue;
              }
              var minutes = service.days[dayKey];
              monitored += 1440;
              down += minutes;
              var note = minutes === 0 ? "no downtime" : "down for " + minutes + " minutes";
              cells += '<span class="cell cell-' + stateFor(minutes) + '" title="' + dayKey + ": " + note + '"></span>';
            }

            var pct = monitored === 0 ? null : ((monitored - down) / monitored) * 100;
            var section = document.createElement("section");
            section.className = "month";
            section.innerHTML =
              '<header class="month-head"><h3>' + monthLabel(key) + "</h3><span>" +
              (pct === null ? "no data" : pct.toFixed(2) + "%") +
              '</span></header><div class="grid">' + cells + "</div>";
            holder.appendChild(section);
          });

          label.textContent = keys.length
            ? keys.length === 1
              ? monthLabel(keys[0])
              : monthLabel(keys[0]) + " to " + monthLabel(keys[keys.length - 1])
            : "";
          older.disabled = (offset + 1) * perWindow >= months.length;
          newer.disabled = offset === 0;

          var next = new URLSearchParams();
          next.set("service", slug);
          if (offset > 0) next.set("page", String(offset + 1));
          history.replaceState(null, "", location.pathname + "?" + next.toString());
        }

        select.addEventListener("change", function () { slug = select.value; offset = 0; render(); });
        older.addEventListener("click", function () { offset += 1; render(); });
        newer.addEventListener("click", function () { offset = Math.max(0, offset - 1); render(); });
        render();
      })();
    </script>`;

  return layout({
    config,
    generatedAt,
    base: "../",
    title: "Historical uptime",
    description: "Month by month uptime for every Lines Police CAD service.",
    markLevel: overall(sites).level,
    body,
    lastChecked: sites.map((s) => s.lastUpdated).filter(Boolean).sort((a, b) => b - a)[0],
  });
}

/**
 * One page of incident history: three months of incidents, grouped by month,
 * with the rest of each month behind a toggle and a component filter.
 *
 * Pages are real files (history/, history/2/, ...) so every window is a link
 * someone can send. A ?page= query lands on the same place.
 */
function renderHistoryPage({ config, sites, incidents, generatedAt, windowKeys, pageNumber, pageCount }) {
  const base = pageNumber === 1 ? "../" : "../../";
  const inWindow = (incidents || []).filter((incident) => windowKeys.includes(monthKey(incident.created)));

  const sections = windowKeys
    .slice()
    .reverse()
    .map((key) => {
      const mine = inWindow.filter((incident) => monthKey(incident.created) === key);
      if (mine.length === 0) {
        return `
      <section class="month-incidents">
        <h3>${escapeHTML(monthName(key))}</h3>
        <p class="muted">No incidents reported this month.</p>
      </section>`;
      }
      const shown = mine.slice(0, INCIDENTS_SHOWN_PER_MONTH);
      const rest = mine.slice(INCIDENTS_SHOWN_PER_MONTH);
      return `
      <section class="month-incidents">
        <h3>${escapeHTML(monthName(key))}</h3>
        ${shown.map((incident) => renderIncidentCard(incident, { showComponent: true })).join("")}
        ${
          rest.length === 0
            ? ""
            : `<details class="more">
          <summary>Show all ${mine.length} incidents</summary>
          ${rest.map((incident) => renderIncidentCard(incident, { showComponent: true })).join("")}
        </details>`
        }
      </section>`;
    })
    .join("");

  const olderHref = pageNumber < pageCount ? `${base}history/${pageNumber + 1}/` : "";
  const newerHref = pageNumber > 2 ? `${base}history/${pageNumber - 1}/` : pageNumber === 2 ? `${base}history/` : "";
  const windowLabel =
    windowKeys.length === 0
      ? ""
      : windowKeys.length === 1
        ? monthName(windowKeys[0])
        : `${monthName(windowKeys[0])} to ${monthName(windowKeys[windowKeys.length - 1])}`;

  const body = `
    <a class="back" href="${base}">Current status</a>
    ${historyTabs("history", base)}

    <div class="controls">
      <details class="filter">
        <summary>Filter services</summary>
        <div class="filter-menu">
${sites
  .map(
    (s) => `          <label><input type="checkbox" value="${escapeHTML(s.slug)}" checked> ${escapeHTML(s.name)}</label>`,
  )
  .join("\n")}
        </div>
      </details>
      <div class="window-nav">
        ${olderHref ? `<a href="${olderHref}" aria-label="Earlier months">&#8249;</a>` : `<span class="disabled" aria-hidden="true">&#8249;</span>`}
        <span>${escapeHTML(windowLabel)}</span>
        ${newerHref ? `<a href="${newerHref}" aria-label="Later months">&#8250;</a>` : `<span class="disabled" aria-hidden="true">&#8250;</span>`}
      </div>
    </div>

    <div id="history">${sections}</div>

    <p class="muted page-count">Page ${pageNumber} of ${pageCount}.</p>

    <script>
      (function () {
        // ?page=N is the URL people tend to type; send them to the page itself.
        var asked = new URLSearchParams(location.search).get("page");
        var here = ${pageNumber};
        if (asked && Number(asked) !== here && Number(asked) >= 1) {
          var target = Number(asked) === 1 ? "${base}history/" : "${base}history/" + Number(asked) + "/";
          location.replace(target);
          return;
        }

        // The filter hides incidents in the page rather than reloading it, so
        // without JavaScript every incident is simply shown.
        var boxes = Array.prototype.slice.call(document.querySelectorAll(".filter input"));
        function apply() {
          var on = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
          document.querySelectorAll(".incident[data-slug]").forEach(function (card) {
            card.hidden = on.indexOf(card.dataset.slug) === -1;
          });
          document.querySelectorAll(".month-incidents").forEach(function (section) {
            var any = section.querySelector(".incident:not([hidden])");
            var empty = section.querySelector(".filtered-empty");
            if (!any && !empty) {
              var p = document.createElement("p");
              p.className = "muted filtered-empty";
              p.textContent = "No incidents for the selected services.";
              section.appendChild(p);
            } else if (any && empty) {
              empty.remove();
            }
          });
        }
        boxes.forEach(function (box) { box.addEventListener("change", apply); });
      })();
    </script>`;

  return layout({
    config,
    generatedAt,
    base,
    title: `Incident history${pageNumber > 1 ? `, page ${pageNumber}` : ""}`,
    description: "Every incident recorded for Lines Police CAD, by month.",
    markLevel: overall(sites).level,
    body,
    lastChecked: sites.map((s) => s.lastUpdated).filter(Boolean).sort((a, b) => b - a)[0],
  });
}

// ------------------------------------------------------------------- build ---

const config = readConfig();
const sites = readSites();
let incidents = null;
try {
  incidents = await readIncidents(sites);
} catch (error) {
  console.warn(`incidents unavailable: ${error.message}`);
}

const generatedAt = new Date();
mkdirSync(join(outDir, "assets"), { recursive: true });

writeFileSync(join(outDir, "index.html"), renderIndex({ config, sites, incidents, generatedAt }));
for (const site of sites) {
  const dir = join(outDir, "service", site.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), renderServicePage({ config, site, incidents, generatedAt }));
}

const monthKeys = monthsCovered(sites, incidents);
const pages = windowsOf(monthKeys);

mkdirSync(join(outDir, "uptime"), { recursive: true });
writeFileSync(join(outDir, "uptime", "index.html"), renderUptimePage({ config, sites, incidents, generatedAt }));

pages.forEach((windowKeys, index) => {
  const pageNumber = index + 1;
  const dir = pageNumber === 1 ? join(outDir, "history") : join(outDir, "history", String(pageNumber));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    renderHistoryPage({
      config,
      sites,
      incidents,
      generatedAt,
      windowKeys,
      pageNumber,
      pageCount: pages.length,
    }),
  );
});

copyFileSync(join(here, "styles.css"), join(outDir, "styles.css"));
copyFileSync(join(here, "assets", "lpc-logo.png"), join(outDir, "assets", "lpc-logo.png"));
writeFileSync(join(outDir, "CNAME"), `${config.cname}\n`);
// GitHub Pages runs Jekyll over the published branch unless told not to.
writeFileSync(join(outDir, ".nojekyll"), "");

const recent =
  incidents === null ? "no" : incidents.filter((i) => Date.now() - i.created.getTime() < INCIDENT_DAYS * DAY).length;
console.log(
  `built ${sites.length} service page(s), ${pages.length} history page(s), ${incidents === null ? "no" : incidents.length} incident(s) (${recent} in the last ${INCIDENT_DAYS} days) -> status-page/dist (${readdirSync(outDir).join(", ")})`,
);
