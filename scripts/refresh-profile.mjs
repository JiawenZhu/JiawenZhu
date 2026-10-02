// Rebuilds the live parts of the profile: the "now building" card, the commit
// city, the banner, and now.json (which the portfolio site reads too).
//
//   GITHUB_TOKEN=... node scripts/refresh-profile.mjs
//
// Only public, non-fork, non-archived repos are considered, so nothing private
// ever lands in the README.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const USER = process.env.PROFILE_USER || 'JiawenZhu'
const TIME_ZONE = 'America/Chicago'
// Repos that should never be shown as "the thing I'm working on".
const EXCLUDE = new Set([USER, 'notion-template-assets'])

const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) {
  console.error('GITHUB_TOKEN is required.')
  process.exit(1)
}

const C = {
  sky: '#cfe3f7',
  skyPale: '#e6f0fb',
  paper: '#f7fbff',
  ink: '#13203a',
  inkSoft: '#4a5a78',
  red: '#e8453c',
  yellow: '#f5b82e',
  green: '#2ea65a',
  blue: '#2f6fe0',
}
const BLOCKS = [C.green, C.blue, C.yellow, C.red]
const FONT = `ui-rounded, 'SF Pro Rounded', 'Nunito', 'Segoe UI', system-ui, -apple-system, sans-serif`

// ---------------------------------------------------------------- data

async function graphql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (!res.ok || body.errors) {
    throw new Error(`GitHub GraphQL failed: ${JSON.stringify(body.errors || body)}`)
  }
  return body.data
}

const PROFILE_QUERY = `
query($login: String!) {
  user(login: $login) {
    repositories(first: 30, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC,
                 orderBy: { field: PUSHED_AT, direction: DESC }) {
      nodes {
        name url description homepageUrl pushedAt stargazerCount isArchived isPrivate
        primaryLanguage { name color }
        repositoryTopics(first: 6) { nodes { topic { name } } }
        defaultBranchRef {
          target {
            ... on Commit {
              history(first: 1) { nodes { messageHeadline oid url committedDate } }
            }
          }
        }
      }
    }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`

const ACTIVITY_QUERY = `
query($owner: String!, $name: String!, $since: GitTimestamp!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target { ... on Commit { history(first: 100, since: $since) { nodes { committedDate } } } }
    }
  }
}`

const toRepo = (node) => ({
  name: node.name,
  url: node.url,
  description: node.description || '',
  homepage: node.homepageUrl || null,
  language: node.primaryLanguage?.name || null,
  languageColor: node.primaryLanguage?.color || null,
  pushedAt: node.pushedAt,
  stars: node.stargazerCount,
  topics: node.repositoryTopics.nodes.map((t) => t.topic.name),
})

const dayKey = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(date))

async function repoActivity(name, days = 14) {
  const since = new Date(Date.now() - days * 86400e3)
  const data = await graphql(ACTIVITY_QUERY, { owner: USER, name, since: since.toISOString() })
  const commits = data.repository?.defaultBranchRef?.target?.history?.nodes || []
  const counts = new Map()
  for (const c of commits) counts.set(dayKey(c.committedDate), (counts.get(dayKey(c.committedDate)) || 0) + 1)

  return Array.from({ length: days }, (_, i) => {
    const date = dayKey(Date.now() - (days - 1 - i) * 86400e3)
    return { date, count: counts.get(date) || 0 }
  })
}

function summarizeCalendar(calendar) {
  const days = calendar.weeks.flatMap((w) => w.contributionDays)
  const today = days.at(-1)

  // Today isn't over yet, so an empty today doesn't break the streak.
  let current = 0
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) current++
    else if (days[i] !== today) break
  }

  let longest = 0
  let run = 0
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0
    longest = Math.max(longest, run)
  }

  const busiest = days.reduce((a, b) => (b.contributionCount > a.contributionCount ? b : a), days[0])

  return {
    total: calendar.totalContributions,
    currentStreak: current,
    longestStreak: longest,
    busiest: { date: busiest.date, count: busiest.contributionCount },
    weeks: calendar.weeks.map((w) => w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount }))),
  }
}

// ---------------------------------------------------------------- svg helpers

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

function wrap(text, maxChars, maxLines) {
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if ((line + ' ' + word).trim().length > maxChars) {
      lines.push(line)
      line = word
    } else {
      line = `${line} ${word}`.trim()
    }
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    lines.length = maxLines
    lines[maxLines - 1] = truncate(lines[maxLines - 1] + ' …', maxChars)
  }
  return lines
}

function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16)
  const ch = (shift) => Math.round(((n >> shift) & 255) * factor)
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`
}

// Deterministic, so unchanged data produces byte-identical SVGs (and no commit).
function rng(seed) {
  let s = seed
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
}

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TIME_ZONE })

// A chunky toy-block card: hard ink shadow, thick ink outline.
const card = (w, h, fill) => `
  <rect x="8" y="8" width="${w - 8}" height="${h - 8}" rx="28" fill="${C.ink}"/>
  <rect x="2" y="2" width="${w - 12}" height="${h - 12}" rx="26" fill="${fill}" stroke="${C.ink}" stroke-width="4"/>`

// ---------------------------------------------------------------- banner

function bannerSvg(latest) {
  const W = 1200
  const H = 300
  const lines = [
    'I build AI products that feel easy to use.',
    latest ? `Right now I'm building ${latest.name}.` : 'Always building something new.',
    'I turn messy data into things people trust.',
    'Creator of CareerVivid.',
  ]
  const cycle = lines.length * 3

  // A little pile of foam blocks that drops in on load.
  const rand = rng(7)
  const blocks = []
  let order = 0
  for (let col = 0; col < 6; col++) {
    const x = 790 + col * 60 + rand() * 8
    const stack = 2 + Math.floor(rand() * 3) + (col === 2 || col === 3 ? 1 : 0)
    let y = 262
    for (let i = 0; i < stack; i++) {
      const color = BLOCKS[(col + i * 3) % 4]
      const h = 30 + Math.floor(rand() * 12)
      const w = 50 + Math.floor(rand() * 8)
      const rot = ((rand() - 0.5) * 10).toFixed(1)
      y -= h
      const round = i === stack - 1 && rand() > 0.55
      const shape = round
        ? `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${h / 2 + 2}" fill="${color}" stroke="${C.ink}" stroke-width="3"/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${color}" stroke="${C.ink}" stroke-width="3" transform="rotate(${rot} ${x + w / 2} ${y + h / 2})"/>`
      blocks.push(`<g class="drop" style="animation-delay:${(0.2 + order++ * 0.07).toFixed(2)}s">${shape}</g>`)
      y -= 2
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Hi, I'm Jiawen. ${esc(lines[0])}">
<style>
  text { font-family: ${FONT}; fill: ${C.ink}; }
  .line { opacity: 0; animation: cycle ${cycle}s infinite; }
  @keyframes cycle { 0% { opacity: 0; transform: translateY(10px); } 3%, 22% { opacity: 1; transform: none; } 25%, 100% { opacity: 0; transform: translateY(-8px); } }
  .wave { transform-origin: 70% 80%; transform-box: fill-box; animation: wave 2.4s ease-in-out infinite; }
  @keyframes wave { 0%, 60%, 100% { transform: rotate(0); } 10%, 30% { transform: rotate(16deg); } 20%, 40% { transform: rotate(-8deg); } }
  .drop { animation: drop 0.9s cubic-bezier(.3,1.4,.5,1) both; }
  @keyframes drop { from { transform: translateY(-320px); } to { transform: none; } }
  @media (prefers-reduced-motion: reduce) { .line, .wave, .drop { animation: none; } .line:first-of-type { opacity: 1; } }
</style>
${card(W, H, C.sky)}
<rect x="40" y="262" width="${W - 92}" height="4" rx="2" fill="${C.ink}" opacity="0.15"/>
<text x="56" y="118" font-size="76" font-weight="800" letter-spacing="-2">Hi, I'm Jiawen <tspan class="wave">👋</tspan></text>
${lines.map((l, i) => `<text class="line" x="58" y="182" font-size="32" font-weight="600" style="animation-delay:${i * 3}s">${esc(l)}</text>`).join('\n')}
<text x="58" y="234" font-size="20" fill="${C.inkSoft}" style="fill:${C.inkSoft}">Full-stack engineer. Creator of CareerVivid.</text>
${blocks.join('\n')}
</svg>
`
}

// ---------------------------------------------------------------- now building

function nowBuildingSvg(latest) {
  const W = 1200
  const H = 310
  const desc = wrap(latest.description || 'No description yet. Probably too busy building it.', 58, 2)
  const commit = latest.commit ? truncate(latest.commit.message, 56) : null
  const max = Math.max(1, ...latest.activity.map((d) => d.count))
  const total = latest.activity.reduce((s, d) => s + d.count, 0)

  const bars = latest.activity
    .map((d, i) => {
      const h = d.count ? 14 + (d.count / max) * 120 : 6
      const x = 862 + i * 20
      const color = d.count ? BLOCKS[i % 4] : C.skyPale
      return `<rect class="grow" style="animation-delay:${(0.3 + i * 0.04).toFixed(2)}s" x="${x}" y="${250 - h}" width="15" height="${h}" rx="4" fill="${color}" stroke="${C.ink}" stroke-width="2.5"><title>${d.date}: ${d.count} commits</title></rect>`
    })
    .join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Building right now: ${esc(latest.name)}. ${esc(latest.description)}">
<style>
  text { font-family: ${FONT}; fill: ${C.ink}; }
  .soft { fill: ${C.inkSoft}; }
  .pulse { transform-origin: center; transform-box: fill-box; animation: pulse 1.6s ease-out infinite; }
  @keyframes pulse { from { transform: scale(1); opacity: .7; } to { transform: scale(2.6); opacity: 0; } }
  .grow { transform-origin: bottom; transform-box: fill-box; animation: grow .7s cubic-bezier(.3,1.4,.5,1) both; }
  @keyframes grow { from { transform: scaleY(0); } }
  .cursor { animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .pulse, .grow, .cursor { animation: none; } .pulse { opacity: 0; } }
</style>
${card(W, H, C.paper)}
<circle cx="62" cy="56" r="8" fill="${C.green}" class="pulse"/>
<circle cx="62" cy="56" r="8" fill="${C.green}" stroke="${C.ink}" stroke-width="2.5"/>
<text x="82" y="63" font-size="21" font-weight="700" class="soft">Building right now</text>
<text x="52" y="128" font-size="58" font-weight="800" letter-spacing="-1.5">${esc(latest.name)}<tspan class="cursor" fill="${C.blue}" style="fill:${C.blue}">_</tspan></text>
${desc.map((l, i) => `<text x="54" y="${170 + i * 30}" font-size="23">${esc(l)}</text>`).join('\n')}
${commit ? `<text x="54" y="${170 + desc.length * 30 + 6}" font-size="18" class="soft">Latest commit: “${esc(commit)}”</text>` : ''}
${latest.language ? `<circle cx="62" cy="266" r="8" fill="${latest.languageColor || C.blue}" stroke="${C.ink}" stroke-width="2"/>
<text x="78" y="272" font-size="18" font-weight="700">${esc(latest.language)}</text>` : ''}
<text x="${latest.language ? 260 : 54}" y="272" font-size="18" class="soft">Last push ${formatDate(latest.pushedAt)}</text>
<line x1="830" y1="40" x2="830" y2="262" stroke="${C.ink}" stroke-width="2" stroke-dasharray="2 8" stroke-linecap="round" opacity=".35"/>
<text x="862" y="63" font-size="18" font-weight="700" class="soft">${total} commit${total === 1 ? '' : 's'} in the last 14 days</text>
<line x1="856" y1="252" x2="1150" y2="252" stroke="${C.ink}" stroke-width="3" stroke-linecap="round"/>
${bars}
</svg>
`
}

// ---------------------------------------------------------------- commit city

// Isometric tile geometry, shared shape with the portfolio site's version.
function prism(sx, sy, tile, h) {
  const hw = tile / 2
  const hh = tile / 4
  const pts = (arr) => arr.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  return {
    top: pts([[sx, sy - h], [sx + hw, sy + hh - h], [sx, sy + 2 * hh - h], [sx - hw, sy + hh - h]]),
    left: pts([[sx - hw, sy + hh - h], [sx, sy + 2 * hh - h], [sx, sy + 2 * hh], [sx - hw, sy + hh]]),
    right: pts([[sx, sy + 2 * hh - h], [sx + hw, sy + hh - h], [sx + hw, sy + hh], [sx, sy + 2 * hh]]),
  }
}

// Quartiles of the active days, like GitHub's own calendar, so a few huge
// days don't flatten everything else into one colour.
function levelThresholds(counts) {
  const active = counts.filter(Boolean).sort((a, b) => a - b)
  const q = (p) => active[Math.floor((active.length - 1) * p)] ?? 0
  return [q(0.25), q(0.5), q(0.75)]
}

function levelOf(count, thresholds) {
  if (!count) return 0
  return 1 + thresholds.filter((t) => count > t).length
}

function citySvg(stats) {
  const W = 1200
  const H = 470
  const tile = 22
  const counts = stats.weeks.flat().map((d) => d.count)
  const max = Math.max(1, ...counts)
  const thresholds = levelThresholds(counts)
  const ox = 560
  const oy = 96
  const faces = { 0: C.skyPale, 1: C.green, 2: C.blue, 3: C.yellow, 4: C.red }

  const towers = []
  stats.weeks.forEach((week, x) => {
    week.forEach((day) => {
      // Partial first/last weeks still need the right weekday row.
      const y = new Date(`${day.date}T12:00:00Z`).getUTCDay()
      const level = levelOf(day.count, thresholds)
      const h = day.count ? 7 + Math.sqrt(day.count / max) * 84 : 3
      const sx = ox + (x - y) * (tile / 2)
      const sy = oy + (x + y) * (tile / 4)
      const p = prism(sx, sy, tile, h)
      const top = faces[level]
      towers.push({
        order: x + y,
        svg: `<g class="b w${x}"><title>${day.date}: ${day.count} contributions</title><polygon points="${p.left}" fill="${shade(top, 0.8)}"/><polygon points="${p.right}" fill="${shade(top, 0.64)}"/><polygon points="${p.top}" fill="${top}"/></g>`,
      })
    })
  })
  towers.sort((a, b) => a.order - b.order)

  const delays = stats.weeks.map((_, x) => `.w${x}{animation-delay:${(x * 0.022).toFixed(3)}s}`).join('')

  const stat = (y, value, label, color) => `
<rect x="52" y="${y - 30}" width="14" height="36" rx="4" fill="${color}" stroke="${C.ink}" stroke-width="2.5"/>
<text x="82" y="${y + 2}" font-size="36" font-weight="800" letter-spacing="-1">${value}</text>
<text x="82" y="${y + 28}" font-size="17" class="soft">${label}</text>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Commit city: ${stats.total} contributions in the last year, one block per day.">
<style>
  text { font-family: ${FONT}; fill: ${C.ink}; }
  .soft { fill: ${C.inkSoft}; }
  .b { transform-origin: bottom; transform-box: fill-box; animation: rise .8s cubic-bezier(.3,1.3,.5,1) both; }
  @keyframes rise { from { transform: scaleY(0); } }
  ${delays}
  @media (prefers-reduced-motion: reduce) { .b { animation: none; } }
</style>
${card(W, H, C.sky)}
<text x="52" y="80" font-size="40" font-weight="800" letter-spacing="-1">My commit city</text>
<text x="52" y="112" font-size="18" class="soft">One block per day for the past year.</text>
<text x="52" y="136" font-size="18" class="soft">Taller blocks, busier days.</text>
${stat(200, stats.total.toLocaleString('en-US'), 'contributions this year', C.green)}
${stat(274, `${stats.currentStreak} day${stats.currentStreak === 1 ? '' : 's'}`, 'current streak', C.blue)}
${stat(348, `${stats.longestStreak} days`, 'longest streak', C.yellow)}
${towers.map((t) => t.svg).join('\n')}
<text x="52" y="${H - 46}" font-size="16" class="soft">Busiest day: ${formatDate(`${stats.busiest.date}T12:00:00Z`)}, ${stats.busiest.count} contributions</text>
</svg>
`
}

// ---------------------------------------------------------------- readme

function replaceSection(readme, name, content) {
  const start = `<!-- ${name}:start -->`
  const end = `<!-- ${name}:end -->`
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`)
  if (!pattern.test(readme)) throw new Error(`README is missing the ${start} … ${end} markers.`)
  return readme.replace(pattern, `${start}\n${content}\n${end}`)
}

const version = (s) => createHash('sha1').update(s).digest('hex').slice(0, 8)

function nowBuildingMarkdown(latest, recent, cardSvg) {
  const link = latest.homepage || latest.url
  const others = recent
    .map((r) => {
      const blurb = r.description ? ` – ${truncate(r.description, 90)}` : ''
      return `- **[${r.name}](${r.url})**${blurb} <sub>(${formatDate(r.pushedAt)})</sub>`
    })
    .join('\n')

  return `<a href="${link}"><img src="assets/now-building.svg?v=${version(cardSvg)}" alt="Building right now: ${esc(latest.name)}. ${esc(latest.description)}" width="100%"></a>

<details>
<summary><b>What else I've touched lately</b></summary>

${others}

</details>`
}

// ---------------------------------------------------------------- main

const data = await graphql(PROFILE_QUERY, { login: USER })
const repos = data.user.repositories.nodes
  .filter((r) => !r.isArchived && !r.isPrivate && !EXCLUDE.has(r.name))

if (!repos.length) throw new Error('No public repos found to feature.')

const [latestNode, ...rest] = repos
const commit = latestNode.defaultBranchRef?.target?.history?.nodes?.[0]
const latest = {
  ...toRepo(latestNode),
  commit: commit
    ? { message: commit.messageHeadline, sha: commit.oid.slice(0, 7), url: commit.url, date: commit.committedDate }
    : null,
  activity: await repoActivity(latestNode.name),
}
const recent = rest.slice(0, 5).map(toRepo)
const contributions = summarizeCalendar(data.user.contributionsCollection.contributionCalendar)

const nowCard = nowBuildingSvg(latest)

await mkdir('assets', { recursive: true })
await Promise.all([
  writeFile('assets/banner.svg', bannerSvg(latest)),
  writeFile('assets/now-building.svg', nowCard),
  writeFile('assets/commit-city.svg', citySvg(contributions)),
  writeFile('now.json', JSON.stringify({ user: USER, latest, recent, contributions }, null, 2) + '\n'),
])

const readme = await readFile('README.md', 'utf8')
await writeFile('README.md', replaceSection(readme, 'now-building', nowBuildingMarkdown(latest, recent, nowCard)))

console.log(`Featured ${latest.name} (pushed ${latest.pushedAt}); ${contributions.total} contributions this year.`)
