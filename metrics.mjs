// metrics.mjs — generates an all-time, cross-org GitHub stats card as SVG.
// No npm dependencies; uses Node 18+ global fetch.
//
// Env vars:
//   GH_TOKEN     (required)  PAT with read:user, read:org, repo
//   GH_LOGIN     (required)  your GitHub username, e.g. "henniefrancis"
//   EXTRA_REPOS  (optional)  comma-separated "owner/name" repos whose stars
//                            should be folded in (org repos you maintain)

const LOGIN = process.env.GH_LOGIN;
const TOKEN = process.env.GH_TOKEN;
const EXTRA_REPOS = (process.env.EXTRA_REPOS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

if (!TOKEN || !LOGIN) {
  console.error("Missing GH_TOKEN or GH_LOGIN");
  process.exit(1);
}

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

// --- Profile + owned-repo stars (paginated) -------------------------------
async function getProfile() {
  let after = null;
  let createdAt, followers, following, ownedStars = 0, ownedCount = 0;
  do {
    const data = await gql(
      `query($login:String!,$after:String){
        user(login:$login){
          createdAt
          followers{ totalCount }
          following{ totalCount }
          repositories(ownerAffiliations:OWNER, isFork:false, first:100, after:$after){
            totalCount
            pageInfo{ hasNextPage endCursor }
            nodes{ stargazerCount }
          }
        }
      }`,
      { login: LOGIN, after }
    );
    const u = data.user;
    createdAt = u.createdAt;
    followers = u.followers.totalCount;
    following = u.following.totalCount;
    ownedCount = u.repositories.totalCount;
    for (const n of u.repositories.nodes) ownedStars += n.stargazerCount;
    after = u.repositories.pageInfo.hasNextPage ? u.repositories.pageInfo.endCursor : null;
  } while (after);
  return { createdAt, followers, following, ownedStars, ownedCount };
}

// --- All-time contributions: sum contributionsCollection per year ---------
async function getContributions(createdAt) {
  const startYear = new Date(createdAt).getUTCFullYear();
  const nowYear = new Date().getUTCFullYear();
  const t = { commits: 0, prs: 0, reviews: 0, issues: 0, restricted: 0 };
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
  }
  return t;
}

async function getExtraStars(repos) {
  let sum = 0;
  for (const full of repos) {
    const [owner, name] = full.split("/");
    if (!owner || !name) continue;
    const data = await gql(
      `query($owner:String!,$name:String!){
        repository(owner:$owner,name:$name){ stargazerCount }
      }`,
      { owner, name }
    );
    sum += data.repository?.stargazerCount || 0;
  }
  return sum;
}

// --- Formatting + SVG ------------------------------------------------------
const fmt = (n) =>
  n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n);

function buildSVG(stats) {
  const {
    commits, prs, reviews, issues, stars, followers, restricted,
  } = stats;

  // Theme — matches your green / magenta terminal palette
  const title = "#00FF00";
  const value = "#FF00FF";
  const label = "#00FF00";
  const icon = "#00FF00";
  const stroke = "#00FF00";

  const rows = [
    { i: "\u2756", k: "Total Commits (all orgs, all-time)", v: fmt(commits) },
    { i: "\u2387", k: "Pull Requests", v: fmt(prs) },
    { i: "\u2611", k: "Code Reviews", v: fmt(reviews) },
    { i: "\u26A0", k: "Issues", v: fmt(issues) },
    { i: "\u2605", k: "Stars Earned", v: fmt(stars) },
    { i: "\u26AC", k: "Followers", v: fmt(followers) },
  ];

  const W = 520;
  const top = 58;
  const lh = 30;
  const H = top + rows.length * lh + 30;

  const lines = rows
    .map((r, idx) => {
      const y = top + idx * lh;
      return `
    <g transform="translate(25 ${y})" class="row" style="animation-delay:${idx * 120}ms">
      <text x="0"   y="0" class="icon">${r.i}</text>
      <text x="28"  y="0" class="label">${r.k}</text>
      <text x="${W - 30}" y="0" class="value" text-anchor="end">${r.v}</text>
    </g>`;
    })
    .join("");

  const note = restricted
    ? `<text x="25" y="${H - 14}" class="foot">+${fmt(restricted)} private contributions counted</text>`
    : `<text x="25" y="${H - 14}" class="foot">synced ${new Date().toISOString().slice(0, 10)}</text>`;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img">
  <style>
    text { font-family: 'Segoe UI', 'JetBrains Mono', Consolas, monospace; }
    .title { font-size: 18px; font-weight: 700; fill: ${title}; }
    .icon  { font-size: 14px; fill: ${icon}; }
    .label { font-size: 14px; fill: ${label}; }
    .value { font-size: 14px; font-weight: 700; fill: ${value}; }
    .foot  { font-size: 10px; fill: ${label}; opacity: .6; }
    .row { opacity: 0; animation: fadein .5s ease forwards; }
    @keyframes fadein { from { opacity: 0; transform: translateY(6px);} to { opacity: 1; } }
  </style>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="10"
        fill="none" stroke="${stroke}" stroke-width="1.5" opacity="0.9"/>
  <text x="25" y="34" class="title">${LOGIN} :: contribution stats</text>
  ${lines}
  ${note}
</svg>`;
}

// --- Main ------------------------------------------------------------------
(async () => {
  const profile = await getProfile();
  const contrib = await getContributions(profile.createdAt);
  const extraStars = await getExtraStars(EXTRA_REPOS);

  const stats = {
    commits: contrib.commits,
    prs: contrib.prs,
    reviews: contrib.reviews,
    issues: contrib.issues,
    restricted: contrib.restricted,
    stars: profile.ownedStars + extraStars,
    followers: profile.followers,
  };

  const { writeFile } = await import("node:fs/promises");
  await writeFile("metrics.svg", buildSVG(stats), "utf8");
  console.log("Wrote metrics.svg", JSON.stringify(stats));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
