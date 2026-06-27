// metrics.mjs - generates cross-org GitHub stat cards as SVG.
// No npm dependencies; uses Node 18+ global fetch.
// Writes two files: metrics.svg (stats) and languages.svg (top languages).
//
// Env vars:
//   GH_TOKEN      (required)  PAT with read:user, read:org, repo
//   GH_LOGIN      (required)  your GitHub username, e.g. "henniefrancis"
//   EXTRA_REPOS   (optional)  comma-separated "owner/name" repos whose stars
//                             should be folded in (org repos you maintain)
//   EXCLUDE_OWNERS(optional)  comma-separated org/user logins to exclude from
//                             the language aggregation (default: umuzi-org)
//
// Run "node metrics.mjs --demo" to render *.demo.svg with sample data.

const LOGIN = process.env.GH_LOGIN;
const TOKEN = process.env.GH_TOKEN;
const EXTRA_REPOS = (process.env.EXTRA_REPOS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const EXCLUDE_OWNERS = (process.env.EXCLUDE_OWNERS || "umuzi-org")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const DEMO = process.argv.includes("--demo");

const API = "https://api.github.com/graphql";

async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": LOGIN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

// language accumulator helpers
function addLangs(map, colors, langConn, counter) {
  if (!langConn || !langConn.edges || !langConn.edges.length) return;
  counter.repos++;
  for (const e of langConn.edges) {
    const n = e.node.name;
    map.set(n, (map.get(n) || 0) + e.size);
    if (e.node.color) colors.set(n, e.node.color);
  }
}

// --- Profile + owned-repo stars + repos-contributed-to + owned langs ------
async function getProfile(langMap, langColors, langCounter) {
  let after = null;
  let createdAt, followers, following, ownedStars = 0, ownedCount = 0, reposContributedTo = 0;
  do {
    const data = await gql(
      `query($login:String!,$after:String){
        user(login:$login){
          createdAt
          followers{ totalCount }
          following{ totalCount }
          repositoriesContributedTo(first:1, contributionTypes:[COMMIT,PULL_REQUEST,ISSUE,PULL_REQUEST_REVIEW]){ totalCount }
          repositories(ownerAffiliations:OWNER, isFork:false, first:100, after:$after){
            totalCount
            pageInfo{ hasNextPage endCursor }
            nodes{
              stargazerCount
              languages(first:20, orderBy:{field:SIZE,direction:DESC}){ edges{ size node{ name color } } }
            }
          }
        }
      }`,
      { login: LOGIN, after }
    );
    const u = data.user;
    createdAt = u.createdAt;
    followers = u.followers.totalCount;
    following = u.following.totalCount;
    reposContributedTo = u.repositoriesContributedTo.totalCount;
    ownedCount = u.repositories.totalCount;
    for (const n of u.repositories.nodes) {
      ownedStars += n.stargazerCount;
      addLangs(langMap, langColors, n.languages, langCounter);
    }
    after = u.repositories.pageInfo.hasNextPage ? u.repositories.pageInfo.endCursor : null;
  } while (after);
  return { createdAt, followers, following, ownedStars, ownedCount, reposContributedTo };
}

// --- Languages from repos contributed to (not owned) ----------------------
async function getContributedLangs(langMap, langColors, langCounter) {
  let after = null;
  do {
    const data = await gql(
      `query($login:String!,$after:String){
        user(login:$login){
          repositoriesContributedTo(first:50, after:$after, includeUserRepositories:false,
            contributionTypes:[COMMIT,PULL_REQUEST,ISSUE,PULL_REQUEST_REVIEW]){
            pageInfo{ hasNextPage endCursor }
            nodes{
              isFork
              owner{ login }
              languages(first:20, orderBy:{field:SIZE,direction:DESC}){ edges{ size node{ name color } } }
            }
          }
        }
      }`,
      { login: LOGIN, after }
    );
    const conn = data.user.repositoriesContributedTo;
    for (const r of conn.nodes) {
      if (r.isFork) continue;
      if (EXCLUDE_OWNERS.includes((r.owner?.login || "").toLowerCase())) continue;
      addLangs(langMap, langColors, r.languages, langCounter);
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
}

function topLanguages(map, colors, n = 8) {
  const total = [...map.values()].reduce((a, b) => a + b, 0) || 1;
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, n).map(([name, size]) => ({
    name, pct: (size / total) * 100, color: colors.get(name) || "#8b949e",
  }));
  const shown = top.reduce((a, l) => a + l.pct, 0);
  return { top, otherPct: Math.max(0, 100 - shown) };
}

// --- All-time contributions + daily calendar (per year) -------------------
async function getYearly(createdAt) {
  const startYear = new Date(createdAt).getUTCFullYear();
  const nowYear = new Date().getUTCFullYear();
  const t = { commits: 0, prs: 0, reviews: 0, issues: 0, restricted: 0 };
  const days = new Map();
  for (let y = startYear; y <= nowYear; y++) {
    const from = `${y}-01-01T00:00:00Z`;
    const to = `${y}-12-31T23:59:59Z`;
    const data = await gql(
      `query($login:String!,$from:DateTime!,$to:DateTime!){
        user(login:$login){
          contributionsCollection(from:$from,to:$to){
            totalCommitContributions
            totalPullRequestContributions
            totalPullRequestReviewContributions
            totalIssueContributions
            restrictedContributionsCount
            contributionCalendar{ weeks{ contributionDays{ date contributionCount } } }
          }
        }
      }`,
      { login: LOGIN, from, to }
    );
    const c = data.user.contributionsCollection;
    t.commits += c.totalCommitContributions;
    t.prs += c.totalPullRequestContributions;
    t.reviews += c.totalPullRequestReviewContributions;
    t.issues += c.totalIssueContributions;
    t.restricted += c.restrictedContributionsCount;
    for (const w of c.contributionCalendar.weeks)
      for (const d of w.contributionDays) {
        const inYear = d.date.slice(0, 4) === String(y);
        if (inYear || !days.has(d.date)) days.set(d.date, d.contributionCount);
      }
  }
  return { totals: t, days };
}

function computeStreaks(days) {
  const dates = [...days.keys()].sort();
  let longest = 0, run = 0;
  for (const d of dates) {
    if ((days.get(d) || 0) > 0) { run++; if (run > longest) longest = run; }
    else run = 0;
  }
  const today = new Date().toISOString().slice(0, 10);
  let cur = new Date(today + "T00:00:00Z");
  if ((days.get(today) || 0) === 0) cur.setUTCDate(cur.getUTCDate() - 1);
  let current = 0;
  while ((days.get(cur.toISOString().slice(0, 10)) || 0) > 0) {
    current++;
    cur.setUTCDate(cur.getUTCDate() - 1);
  }
  return { current, longest };
}

async function getExtraStars(repos) {
  let sum = 0;
  for (const full of repos) {
    const [owner, name] = full.split("/");
    if (!owner || !name) continue;
    const data = await gql(
      `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ stargazerCount } }`,
      { owner, name }
    );
    sum += data.repository?.stargazerCount || 0;
  }
  return sum;
}

// --- Formatting + shared SVG bits ------------------------------------------
const fmt = (n) =>
  n == null ? "n/a" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const THEME = { title: "#00FF00", value: "#FF00FF", label: "#00FF00", icon: "#00FF00", stroke: "#00FF00" };

const ICONS = {
  commit: "M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z",
  pr: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  review: "M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.671 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.329 2.992 6.019 2 8 2Zm0 1.5c-1.473 0-2.824.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717a.119.119 0 0 0 0 .136c.412.621 1.242 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.824-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z",
  issue: "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
  repo: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z",
  star: "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z",
  people: "M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5.01 5.01 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.514 3.507 3.507 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4Zm-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5Z",
  flame: "M8.5.25a.75.75 0 0 0-1.262-.546C5.81 1.04 4.5 2.673 4.5 4.5c0 .47.077.93.22 1.36-.61-.39-1.12-.94-1.46-1.62A.75.75 0 0 0 2 4.5C2 8.5 4.5 11 7.5 11s5.5-2.5 5.5-6c0-2.02-1.06-3.86-2.62-5.06a.75.75 0 0 0-1.2.55c0 .9-.36 1.66-.86 2.2.1-.46.18-.95.18-1.44 0-.5-.07-.99-.2-1.5Z",
};

function icon(name, x, y, color, size = 19) {
  const s = (size / 16).toFixed(4);
  return `<g transform="translate(${x} ${y - size + 3}) scale(${s})" fill="${color}" fill-rule="evenodd"><path d="${ICONS[name]}"/></g>`;
}

function buildStatsSVG(stats) {
  const { commits, prs, reviews, issues, reposContributedTo, stars, followers,
    currentStreak, longestStreak, restricted, createdYear, years } = stats;
  const { title, value, label, icon: ic, stroke } = THEME;

  const rows = [
    { i: "commit", k: "Total Commits (all-time)", v: fmt(commits) },
    { i: "pr",     k: "Pull Requests",            v: fmt(prs) },
    { i: "review", k: "Code Reviews",             v: fmt(reviews) },
    { i: "issue",  k: "Issues",                   v: fmt(issues) },
    { i: "repo",   k: "Repos Contributed To",     v: fmt(reposContributedTo) },
    { i: "star",   k: "Stars Earned",             v: fmt(stars) },
    { i: "people", k: "Followers",                v: fmt(followers) },
    { i: "flame",  k: "Current Streak",           v: `${fmt(currentStreak)} d` },
    { i: "flame",  k: "Longest Streak",           v: `${fmt(longestStreak)} d` },
  ];
  const W = 560, top = 70, lh = 33, H = top + rows.length * lh + 34;
  const lines = rows.map((r, idx) => {
    const y = top + idx * lh;
    return `
    <g class="row" style="animation-delay:${idx * 90}ms">
      ${icon(r.i, 26, y, ic)}
      <text x="58" y="${y}" class="label">${r.k}</text>
      <text x="${W - 28}" y="${y}" class="value" text-anchor="end">${r.v}</text>
    </g>`;
  }).join("");
  const foot = `On GitHub since ${createdYear} · ${years} yrs` +
    (restricted ? ` · +${fmt(restricted)} private contributions` : "") +
    ` · synced ${new Date().toISOString().slice(0, 10)}`;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img">
  <style>
    text { font-family: 'Segoe UI', 'JetBrains Mono', Consolas, monospace; }
    .title { font-size: 19px; font-weight: 700; fill: ${title}; }
    .label { font-size: 14px; fill: ${label}; }
    .value { font-size: 14px; font-weight: 700; fill: ${value}; }
    .foot  { font-size: 10px; fill: ${label}; opacity: .6; }
    .row { opacity: 0; animation: fadein .5s ease forwards; }
    @keyframes fadein { from { opacity: 0; transform: translateY(6px);} to { opacity: 1; } }
  </style>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="10" fill="none" stroke="${stroke}" stroke-width="1.5" opacity="0.9"/>
  <text x="26" y="38" class="title">${LOGIN} :: contribution stats</text>
  ${lines}
  <text x="26" y="${H - 16}" class="foot">${foot}</text>
</svg>`;
}

function buildLangSVG(top, otherPct, repoCount) {
  const { title, value, label, stroke } = THEME;
  const W = 560, barX = 26, barY = 60, barH = 16, barW = W - 52;
  let x = barX;
  const seg = (w, c) => { const r = `<rect x="${x.toFixed(2)}" y="${barY}" width="${Math.max(0, w).toFixed(2)}" height="${barH}" fill="${c}"/>`; x += Math.max(0, w); return r; };
  const segs = top.map((l) => seg((l.pct / 100) * barW, l.color)).join("") +
    (otherPct > 0.5 ? seg((otherPct / 100) * barW, "#30363d") : "");

  const colW = (W - 52) / 2, legY = 104, lh = 29;
  const rows = Math.ceil(top.length / 2);
  const legend = top.map((l, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const lx = 26 + col * colW, ly = legY + row * lh;
    return `
    <circle cx="${lx + 6}" cy="${ly - 4}" r="6" fill="${l.color}"/>
    <text x="${lx + 20}" y="${ly}" class="lname">${esc(l.name)}</text>
    <text x="${lx + colW - 18}" y="${ly}" class="lpct" text-anchor="end">${l.pct.toFixed(1)}%</text>`;
  }).join("");
  const H = legY + rows * lh + 18;
  const foot = `across ${fmt(repoCount)} repos you've worked in · synced ${new Date().toISOString().slice(0, 10)}`;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img">
  <style>
    text { font-family: 'Segoe UI', 'JetBrains Mono', Consolas, monospace; }
    .title { font-size: 19px; font-weight: 700; fill: ${title}; }
    .lname { font-size: 13px; fill: ${label}; }
    .lpct  { font-size: 13px; font-weight: 700; fill: ${value}; }
    .foot  { font-size: 10px; fill: ${label}; opacity: .6; }
  </style>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="10" fill="none" stroke="${stroke}" stroke-width="1.5" opacity="0.9"/>
  <text x="26" y="38" class="title">${LOGIN} :: most used languages</text>
  <defs><clipPath id="barclip"><rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="8"/></clipPath></defs>
  <g clip-path="url(#barclip)">${segs}</g>
  ${legend}
  <text x="26" y="${H - 14}" class="foot">${foot}</text>
</svg>`;
}

// --- Main ------------------------------------------------------------------
async function run() {
  const langMap = new Map(), langColors = new Map(), langCounter = { repos: 0 };
  const profile = await getProfile(langMap, langColors, langCounter);
  await getContributedLangs(langMap, langColors, langCounter);
  const { totals, days } = await getYearly(profile.createdAt);
  const { current, longest } = computeStreaks(days);
  const extraStars = await getExtraStars(EXTRA_REPOS);
  const { top, otherPct } = topLanguages(langMap, langColors, 8);

  const createdYear = new Date(profile.createdAt).getUTCFullYear();
  const years = ((Date.now() - new Date(profile.createdAt).getTime()) /
    (365.25 * 24 * 3600 * 1000)).toFixed(1);

  const stats = {
    commits: totals.commits, prs: totals.prs, reviews: totals.reviews,
    issues: totals.issues, reposContributedTo: profile.reposContributedTo,
    restricted: totals.restricted, stars: profile.ownedStars + extraStars,
    followers: profile.followers, currentStreak: current, longestStreak: longest,
    createdYear, years,
  };
  return { stats, top, otherPct, repoCount: langCounter.repos };
}

const DEMO_STATS = {
  commits: 1045, prs: 167, reviews: 1, issues: 1, reposContributedTo: 17,
  restricted: 148, stars: 6, followers: 4, currentStreak: 5, longestStreak: 34,
  createdYear: 2015, years: "11.2",
};
const DEMO_LANGS = {
  top: [
    { name: "C#", pct: 55.0, color: "#178600" },
    { name: "HCL", pct: 20.9, color: "#844FBA" },
    { name: "HTML", pct: 10.0, color: "#e34c26" },
    { name: "PowerShell", pct: 5.6, color: "#012456" },
    { name: "Python", pct: 3.0, color: "#3572A5" },
    { name: "Shell", pct: 2.4, color: "#89e051" },
    { name: "TypeScript", pct: 1.6, color: "#3178c6" },
    { name: "JavaScript", pct: 1.5, color: "#f1e05a" },
  ],
  otherPct: 0,
  repoCount: 42,
};

(async () => {
  const { writeFile } = await import("node:fs/promises");
  if (DEMO) {
    await writeFile("metrics.demo.svg", buildStatsSVG(DEMO_STATS), "utf8");
    await writeFile("languages.demo.svg", buildLangSVG(DEMO_LANGS.top, DEMO_LANGS.otherPct, DEMO_LANGS.repoCount), "utf8");
    console.log("Wrote metrics.demo.svg + languages.demo.svg (demo mode)");
    return;
  }
  const missing = [];
  if (!TOKEN) missing.push("GH_TOKEN");
  if (!LOGIN) missing.push("GH_LOGIN");
  if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(", ")}`);
    process.exit(1);
  }
  const { stats, top, otherPct, repoCount } = await run();
  await writeFile("metrics.svg", buildStatsSVG(stats), "utf8");
  await writeFile("languages.svg", buildLangSVG(top, otherPct, repoCount), "utf8");
  console.log("Wrote metrics.svg + languages.svg", JSON.stringify({ stats, top, repoCount }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
