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
 * Incidents from the last INCIDENT_DAYS days, newest first, each with the
 * updates Upptime posted on it.
 *
 * Upptime opens an issue when a site goes down and comments as it recovers, so
 * the issue is the incident and its comments are the timeline. Issues labelled
 * "maintenance" are ours rather than Upptime's and are shown the same way.
 */
async function readIncidents(sites) {
  if (!TOKEN) return null;

  const since = new Date(Date.now() - INCIDENT_DAYS * 86400_000).toISOString();
  const issues = await github(
    `/repos/${REPO}/issues?state=all&per_page=100&sort=created&direction=desc&since=${since}`,
  );
  const slugToName = new Map(sites.map((s) => [s.slug, s.name]));

  const incidents = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
    if (!labels.includes("status") && !labels.includes("maintenance")) continue;
    const created = new Date(issue.created_at);
    if (Date.now() - created.getTime() > INCIDENT_DAYS * 86400_000) continue;

    let updates = [];
    if (issue.comments > 0) {
      try {
        const comments = await github(`/repos/${REPO}/issues/${issue.number}/comments?per_page=100`);
        updates = comments.map((c) => ({ at: new Date(c.created_at), ...parseUpdate(c.body) }));
      } catch {
        // An incident with its updates missing is still worth showing.
      }
    }

    const component = labels.map((l) => slugToName.get(l)).find(Boolean) || "";
    incidents.push({
      number: issue.number,
      url: issue.html_url,
      title: cleanTitle(issue.title),
      component,
      maintenance: labels.includes("maintenance"),
      created,
      closed: issue.closed_at ? new Date(issue.closed_at) : null,
      updates,
    });
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
  const line =
    String(body || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "";
  const plain = line
    .replace(/[*_`]+/g, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  const labelled = /^(Resolved|Investigating|Identified|Monitoring|Update|Scheduled|In progress|Completed)\s*[:.-]\s*(.*)$/i.exec(plain);
  if (labelled && labelled[2]) {
    return { label: titleCase(labelled[1]), text: labelled[2].trim() };
  }
  return { label: "", text: plain };
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

function renderSite(site) {
  const bars = dailyBars(site)
    .map((bar) => `<span class="bar bar-${bar.state}" title="${escapeHTML(barTitle(bar))}"></span>`)
    .join("");
  const status = site.liveStatus === "up" || site.liveStatus === "degraded" || site.liveStatus === "down"
    ? site.liveStatus
    : "up";
  const since = site.startTime && Date.now() - site.startTime.getTime() < DAYS * DAY
    ? `Monitored since ${formatDate(site.startTime)}`
    : `${DAYS} days ago`;

  return `
      <section class="service">
        <header class="service-head">
          <h3>${escapeHTML(site.name)}</h3>
          <span class="pill pill-${status}">${STATUS_LABEL[status]}</span>
        </header>
        <div class="strip" role="img" aria-label="Daily uptime for the past ${DAYS} days">${bars}</div>
        <footer class="strip-legend">
          <span class="since">${escapeHTML(since)}</span>
          <span class="rule"></span>
          <span class="uptime">${escapeHTML(site.uptime)} uptime</span>
          <span class="rule"></span>
          <span>Today</span>
        </footer>
      </section>`;
}

function renderIncidentCard(incident) {
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
        <article class="incident">
          <h4>${escapeHTML(incident.title)}</h4>
          <p class="incident-meta">
            <span class="outcome${incident.closed ? "" : " outcome-open"}">${escapeHTML(outcome)}</span>
            <span>${escapeHTML(window)}</span>
          </p>
          ${updates ? `<ul class="updates">${updates}\n          </ul>` : ""}
          <a class="incident-link" href="${escapeHTML(incident.url)}">Incident #${incident.number}</a>
        </article>`;
}

function renderIncidents(incidents) {
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
            : onThisDay.map(renderIncidentCard).join("")
        }
      </section>`);
  }
  return days.join("");
}

function renderPage({ config, sites, incidents, generatedAt }) {
  const state = overall(sites);
  const lastChecked = sites
    .map((s) => s.lastUpdated)
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(config.name)}</title>
<meta name="description" content="Live availability and uptime for the Lines Police CAD website, API and Discord bot.">
<meta name="theme-color" content="#faf9f5">
<meta property="og:title" content="${escapeHTML(config.name)}">
<meta property="og:description" content="${escapeHTML(state.text)}. Live availability for Lines Police CAD.">
<meta property="og:type" content="website">
<link rel="icon" href="https://www.linespolice-cad.com/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&display=swap">
<link rel="stylesheet" href="styles.css?v=${generatedAt.getTime()}">
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
<a class="skip" href="#services">Skip to service status</a>

<header class="masthead">
  <div class="wrap masthead-inner">
    <a class="brand" href="https://www.linespolice-cad.com">
      <span class="brand-mark mark-${state.level}" aria-hidden="true"></span>
      <span class="brand-name">Lines Police CAD <span>Status</span></span>
    </a>
    <nav class="masthead-nav">
      <a href="https://www.linespolice-cad.com">Main site</a>
      <a class="btn" href="https://discord.gg/Y9ytW2ZMp4">Get alerts in Discord</a>
      <button class="theme-toggle" type="button" aria-label="Switch between light and dark">
        <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9"/></svg>
        <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4z"/></svg>
      </button>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <div class="banner banner-${state.level}">
      <h2>${escapeHTML(state.text)}</h2>
    </div>

    <p class="caption">Uptime over the past ${DAYS} days. Checked every 5 minutes.</p>

    <div id="services" class="services">
${sites.map(renderSite).join("\n")}
    </div>

    <h2 class="section-title">Past incidents</h2>
    <div class="incidents">
${renderIncidents(incidents)}
    </div>
  </div>
</main>

<footer class="footer">
  <div class="wrap footer-inner">
    <p>${lastChecked ? `Last checked ${escapeHTML(formatStamp(lastChecked))}.` : "Waiting for the first check."} All times UTC.</p>
    <nav>
      <a href="https://www.linespolice-cad.com">Lines Police CAD</a>
      <a href="https://discord.gg/Y9ytW2ZMp4">Discord</a>
      <a href="https://github.com/${escapeHTML(REPO)}">Monitoring data</a>
    </nav>
  </div>
</footer>

<script>
  // The toggle flips the current appearance, whether that came from the system
  // or from an earlier choice, and remembers it. Nothing else on the page needs
  // JavaScript: if this fails, the system setting still decides.
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
</script>
</body>
</html>
`;
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

mkdirSync(outDir, { recursive: true });
const generatedAt = new Date();
writeFileSync(join(outDir, "index.html"), renderPage({ config, sites, incidents, generatedAt }));
copyFileSync(join(here, "styles.css"), join(outDir, "styles.css"));
writeFileSync(join(outDir, "CNAME"), `${config.cname}\n`);
// GitHub Pages runs Jekyll over the published branch unless told not to.
writeFileSync(join(outDir, ".nojekyll"), "");

const built = readdirSync(outDir).join(", ");
console.log(
  `built ${sites.length} service(s), ${incidents === null ? "no" : incidents.length} incident(s) in the last ${INCIDENT_DAYS} days -> status-page/dist (${built})`,
);
