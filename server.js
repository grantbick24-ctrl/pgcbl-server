const express   = require('express');
const cors      = require('cors');
const NodeCache = require('node-cache');

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── PostgreSQL (optional — graceful fallback to in-memory) ───────────────────
let pg = null;
const memScouts = {};  // fallback when DB unavailable

async function dbReady() {
  if (pg) return true;
  if (!process.env.DATABASE_URL) return false;
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scouting (
        player_key  TEXT PRIMARY KEY,
        player_name TEXT,
        team        TEXT,
        uploads     JSONB    DEFAULT '[]',
        analysis    TEXT     DEFAULT '',
        is_hot      BOOLEAN  DEFAULT FALSE,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    pg = pool;
    console.log('PostgreSQL connected');
    return true;
  } catch (e) {
    console.warn('PostgreSQL unavailable — using in-memory store:', e.message);
    return false;
  }
}
dbReady();

// ─── Season helper ────────────────────────────────────────────────────────────
function getSeason() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  if (month < 6) return `${year - 1}-${String(year).slice(2)}`;
  return `${year}-${String(year + 1).slice(2)}`;
}

// ─── Teams ────────────────────────────────────────────────────────────────────
// slugAlt = alternate slug to try if primary fails (empty string = none)
const TEAMS = [
  { name: 'Auburn Doubledays',       slug: 'auburndoubledays',       slugAlt: 'auburn-doubledays' },
  { name: 'Batavia Muckdogs',        slug: 'bataviamuckdogs',        slugAlt: 'batavia-muckdogs' },
  { name: 'Elmira Pioneers',         slug: 'elmirapioneers',         slugAlt: 'elmira-pioneers' },
  { name: 'Geneva Red Wings',        slug: 'genevaredwings',         slugAlt: 'geneva-red-wings' },
  { name: 'Jamestown Tarp Skunks',   slug: 'jamestowntarpskunks',    slugAlt: 'jamestown-tarp-skunks' },
  { name: 'Newark Pilots',           slug: 'newarkpilots',           slugAlt: 'newark-pilots' },
  { name: 'Niagara Falls Americans', slug: 'niagarafallsamericans',  slugAlt: 'niagara-falls-americans' },
  { name: 'Niagara Ironbacks',       slug: 'niagaraironbacks',       slugAlt: 'niagara-ironbacks' },
  { name: 'Olean Oilers',            slug: 'oleanoilers',            slugAlt: 'olean-oilers' },
];

// ─── Standings scraper ────────────────────────────────────────────────────────
async function fetchStandings(season) {
  try {
    const html = await fetchPage(`https://pgcbl.com/sports/bsb/${season}/standings`);
    // Standings tables use <th scope="row"> for team names + <td> for stats
    // parseTables only grabs <td>, so we parse standings specially
    const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) || [];
    let westRows = [];
    for (const t of tableMatches) {
      const rowMatches = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
      const parsed = rowMatches.map(row => {
        // Grab both <th> and <td> cell content
        const cells = (row.match(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi) || [])
          .map(c => stripTags(c));
        return cells;
      }).filter(r => r.length >= 5);
      // West Division table contains 'Batavia'
      if (parsed.some(r => r[0]?.toLowerCase().includes('batavia'))) {
        westRows = parsed;
        break;
      }
    }
    return westRows
      .filter(r => r[0] && !['team',''].includes(r[0].toLowerCase()))
      .map(r => ({
        name:   r[0].trim(),
        w:      parseInt2(r[1]) ?? 0,
        l:      parseInt2(r[2]) ?? 0,
        t:      parseInt2(r[3]) ?? 0,
        pct:    parseFloat2(r[4]) ?? 0,
        gb:     r[5]?.trim() || '—',
        streak: r[6]?.trim() || '',
        last10: r[7]?.trim() || '',
      }));
  } catch (e) {
    console.warn('Standings scrape failed:', e.message);
    return [];
  }
}

// ─── HTML fetch + table parse (no Puppeteer) ─────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').replace(/&amp;/g, '&').trim();
}
function cleanName(s) {
  // Remove trailing dot-padding used in monospace print template: "Walter Garrett......"
  return s.replace(/\.+$/, '').trim();
}

function parseFloat2(s) { const v = parseFloat(s); return isNaN(v) ? null : v; }
function parseInt2(s)   { const v = parseInt(s);   return isNaN(v) ? null : v; }

function parseTables(html) {
  // Returns array of { headers: string[], rows: string[][] }
  const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  return tableMatches.map(t => {
    const headers = (t.match(/<th[^>]*>([\s\S]*?)<\/th>/gi) || [])
      .map(h => stripTags(h).toLowerCase());
    const rowMatches = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const rows = rowMatches.map(row => {
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
        .map(c => stripTags(c));
      return cells;
    }).filter(r => r.length > 2);
    return { headers, rows };
  });
}

// ─── Box score scraper — pitch counts ────────────────────────────────────────
async function fetchBoxScorePitchCounts(season) {
  // Get Batavia game log to find box score URLs
  try {
    const logHtml = await fetchPage(
      `https://pgcbl.com/sports/bsb/${season}/teams/bataviamuckdogs?view=gamelog`
    );
    // Box score links look like: boxscores/20260529_6w3u.xml
    const boxLinks = [...new Set(
      (logHtml.match(/boxscores\/[^"'\s<>]+\.xml/g) || [])
        .map(l => `https://pgcbl.com/sports/bsb/${season}/${l}`)
    )];

    // Per-pitcher pitch data: { "Name": [{date, pitches, ip}] }
    const pitchMap = {};

    await Promise.allSettled(boxLinks.map(async url => {
      try {
        const html = await fetchPage(url);
        // Extract game date from URL (e.g. 20260529 → 2026-05-29)
        const dateM = url.match(/(\d{8})_/);
        const date  = dateM ? `${dateM[1].slice(0,4)}-${dateM[1].slice(4,6)}-${dateM[1].slice(6,8)}` : null;

        // Find Batavia pitcher table — it has columns including 'np' (num pitches)
        const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) || [];
        for (const t of tableMatches) {
          const rowMatches = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
          const allRows = rowMatches.map(row => {
            const cells = (row.match(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi) || [])
              .map(c => stripTags(c));
            return cells;
          });
          // Header row: find if this table has 'np' column
          const header = allRows[0] || [];
          const hLow   = header.map(h => h.toLowerCase());
          if (!hLow.includes('np') || !hLow.includes('pitchers') && !hLow.includes('ip')) continue;
          const npIdx   = hLow.indexOf('np');
          const ipIdx   = hLow.indexOf('ip');
          const nameIdx = 0;

          // Only process rows where the pitcher is on Batavia (heuristic: check if name appears in Batavia roster)
          for (const row of allRows.slice(1)) {
            const rawName = row[nameIdx];
            if (!rawName || rawName.toLowerCase() === 'pitchers') continue;
            const name    = cleanName(rawName);
            const pitches = parseInt2(row[npIdx]);
            const ip      = parseFloat2(row[ipIdx]);
            if (!name || pitches == null || pitches <= 0) continue;
            if (!pitchMap[name]) pitchMap[name] = [];
            pitchMap[name].push({ date, pitches, ip });
          }
        }
      } catch { /* skip bad box scores */ }
    }));

    return pitchMap;
  } catch (e) {
    console.warn('Box score pitch scrape failed:', e.message);
    return {};
  }
}

async function fetchTeamStats(teamName, slug, season, slugAlt) {
  // Try primary slug first, then alternate slug if primary returns tiny response
  const TMPL = 'tmpl=teaminfo-network-monospace-template';

  async function trySlug(s) {
    const BASE = `https://pgcbl.com/sports/bsb/${season}/teams/${s}`;
    const [htmlH, htmlP] = await Promise.all([
      fetchPage(`${BASE}?${TMPL}&sort=ab&pos=h`).catch(() => ''),
      fetchPage(`${BASE}?${TMPL}&sort=era&pos=p`).catch(() => ''),
    ]);
    const hitters  = parseHitters(htmlH,  teamName);
    const pitchers = parsePitchers(htmlP, teamName);
    return { hitters, pitchers, htmlH, htmlP };
  }

  let result = await trySlug(slug);

  // If primary returned no players but we got tiny responses, try alternate slug
  if (result.hitters.length === 0 && result.pitchers.length === 0 && slugAlt) {
    const hSize = result.htmlH.length, pSize = result.htmlP.length;
    if (hSize < 2000 || pSize < 2000) {
      console.log(`${teamName}: primary slug '${slug}' returned ${hSize}/${pSize} bytes — trying '${slugAlt}'`);
      result = await trySlug(slugAlt);
    }
  }

  // If still no data, try fetching the plain team page and scraping tables from it
  if (result.hitters.length === 0 && result.pitchers.length === 0) {
    try {
      const BASE = `https://pgcbl.com/sports/bsb/${season}/teams/${slug}`;
      const [htmlH2, htmlP2] = await Promise.all([
        fetchPage(`${BASE}?view=hitting`).catch(() => ''),
        fetchPage(`${BASE}?view=pitching`).catch(() => ''),
      ]);
      result.hitters  = parseHitters(htmlH2,  teamName);
      result.pitchers = parsePitchers(htmlP2, teamName);
      if (result.hitters.length === 0 && result.pitchers.length === 0) {
        // Try the stats page directly
        const htmlS = await fetchPage(`${BASE}?view=stats`).catch(() => '');
        result.hitters  = parseHitters(htmlS,  teamName);
        result.pitchers = parsePitchers(htmlS, teamName);
      }
    } catch(e) {}
  }

  if (result.hitters.length || result.pitchers.length) {
    console.log(`${teamName} [${slug}]: ${result.pitchers.length} pitchers, ${result.hitters.length} hitters`);
  } else {
    console.warn(`${teamName} [${slug}]: NO DATA — may not have played yet`);
  }

  return { hitters: result.hitters, pitchers: result.pitchers };
}

function parseHitters(html, teamName) {
  const tables = parseTables(html);
  const players = [];

  for (const { headers, rows } of tables) {
    if (!headers.includes('avg') || !headers.includes('ab')) continue;
    const idx = {};
    headers.forEach((h, i) => { idx[h] = i; });

    for (const cells of rows) {
      const name = cleanName(cells[idx['player'] ?? 1] || '');
      if (!name || name.length < 2) continue;
      if (/^(total|opponent|opp\b)/i.test(name) || /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(name)) continue;

      const ab  = parseFloat2(cells[idx['ab']]) ?? 0;
      if (ab < 1 && (parseInt2(cells[idx['pa']]) ?? 0) < 1) continue;

      const h   = parseInt2(cells[idx['h']])   ?? 0;
      const bb  = parseInt2(cells[idx['bb']])  ?? 0;
      const obp = parseFloat2(cells[idx['ob%']]) ?? parseFloat2(cells[idx['obp']]) ?? 0;
      const slg = parseFloat2(cells[idx['slg%']]) ?? parseFloat2(cells[idx['slg']]) ?? 0;

      players.push({
        name,
        team: teamName,
        gp:  parseInt2(cells[idx['gp']]) ?? 0,
        ab,
        h,
        avg: parseFloat2(cells[idx['avg']]) ?? 0,
        obp,
        slg,
        ops: parseFloat(((obp || 0) + (slg || 0)).toFixed(3)),
        hr:  parseInt2(cells[idx['hr']])  ?? 0,
        rbi: parseInt2(cells[idx['rbi']]) ?? 0,
        sb:  parseInt2(cells[idx['sb']])  ?? 0,
        bb,
        k:   parseInt2(cells[idx['so']])  ?? 0,
      });
    }
    if (players.length) break;  // found the right table
  }
  return players;
}

function parsePitchers(html, teamName) {
  const tables = parseTables(html);
  const players = [];

  for (const { headers, rows } of tables) {
    if (!headers.includes('era') || !headers.includes('ip')) continue;
    const idx = {};
    headers.forEach((h, i) => { idx[h] = i; });

    for (const cells of rows) {
      const name = cleanName(cells[idx['player'] ?? 1] || '');
      if (!name || name.length < 2) continue;
      if (/^(total|opponent|opp\b)/i.test(name) || /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(name)) continue;

      const ip = parseFloat2(cells[idx['ip']]) ?? 0;
      // Keep pitchers with any appearance (even 0 IP recorded — e.g. ejected)
      if (ip < 0 || cells.every(c => !c)) continue;

      const h  = parseInt2(cells[idx['h']])  ?? 0;
      const bb = parseInt2(cells[idx['bb']]) ?? 0;
      const k  = parseInt2(cells[idx['so']]) ?? 0;

      players.push({
        name,
        team: teamName,
        gp:   parseInt2(cells[idx['app']]) ?? parseInt2(cells[idx['gp']]) ?? 0,
        ip,
        era:  parseFloat2(cells[idx['era']]) ?? 0,
        whip: ip > 0 ? parseFloat(((h + bb) / ip).toFixed(3)) : null,
        k,
        bb,
        h,
        w:    parseInt2(cells[idx['w']])  ?? 0,
        sv:   parseInt2(cells[idx['sv']]) ?? 0,
        k9:   ip > 0 ? parseFloat((k / ip * 9).toFixed(2)) : null,
        bb9:  ip > 0 ? parseFloat((bb / ip * 9).toFixed(2)) : null,
      });
    }
    if (players.length) break;
  }
  return players;
}

// ─── Main stats fetch ─────────────────────────────────────────────────────────
async function fetchAllStats() {
  const cached = cache.get('stats');
  if (cached) return cached;

  console.log('Fetching PGCBL stats via fetch (no Puppeteer)…');
  const season = getSeason();

  const [results, standings, pitchCounts] = await Promise.all([
    Promise.allSettled(TEAMS.map(t => fetchTeamStats(t.name, t.slug, season, t.slugAlt))),
    fetchStandings(season),
    fetchBoxScorePitchCounts(season),
  ]);

  const allHitters = [], allPitchers = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      allHitters.push(...r.value.hitters);
      allPitchers.push(...r.value.pitchers);
    } else {
      console.error(`${TEAMS[i].name}: ${r.reason?.message}`);
    }
  });

  // Real league averages from qualified pitchers (lower threshold early in season)
  const qualified = allPitchers.filter(p => p.ip >= 2);
  const totalIP   = qualified.reduce((s, p) => s + p.ip, 0);
  const totalK    = qualified.reduce((s, p) => s + p.k, 0);
  const totalH    = qualified.reduce((s, p) => s + p.h, 0);
  const totalBB   = qualified.reduce((s, p) => s + p.bb, 0);
  const laWhip = totalIP > 0 ? parseFloat(((totalH + totalBB) / totalIP).toFixed(3)) : 1.37;
  const laK9   = totalIP > 0 ? parseFloat((totalK / totalIP * 9).toFixed(2))         : 8.21;

  // Build Batavia pitcher name set for filtering pitch counts
  // Also include any pitcher in pitchCounts that doesn't appear in the opponent's stats
  // Strategy: keep only names that appear in Batavia's hitters+pitchers roster
  const bataviaRoster = new Set([
    ...allHitters.filter(p => p.team === 'Batavia Muckdogs').map(p => p.name),
    ...allPitchers.filter(p => p.team === 'Batavia Muckdogs').map(p => p.name),
  ]);
  // Filter pitchCounts: remove 'Totals'/aggregate rows, keep only Batavia players
  const filteredPitchCounts = {};
  Object.entries(pitchCounts).forEach(([name, outings]) => {
    if (!name || /^total/i.test(name) || name.length < 3) return;
    // Accept if in Batavia roster, or if not found in ANY team's roster (new pitcher with 0 IP)
    const inAnyRoster = allPitchers.some(p => p.name === name) || allHitters.some(p => p.name === name);
    if (bataviaRoster.has(name) || !inAnyRoster) {
      filteredPitchCounts[name] = outings;
    }
  });

  // Attach per-game pitch history to Batavia pitchers
  allPitchers.forEach(p => {
    if (p.team === 'Batavia Muckdogs' && filteredPitchCounts[p.name]) {
      p.pitchHistory = filteredPitchCounts[p.name].sort((a,b) => (a.date||'') > (b.date||'') ? 1 : -1);
    }
  });

  const result = {
    hitters:   allHitters,
    pitchers:  allPitchers,
    standings,
    pitchCounts: filteredPitchCounts,  // Batavia-only pitch counts to auto-seed availability tab
    season,
    laWhip:    (isNaN(laWhip) || laWhip < 0.5 || laWhip > 2.5) ? 1.37 : laWhip,
    laK9:      (isNaN(laK9)   || laK9   < 4   || laK9   > 14)  ? 8.21 : laK9,
    updatedAt: new Date().toISOString(),
  };

  cache.set('stats', result);
  console.log(`Done. ${allHitters.length} hitters, ${allPitchers.length} pitchers | LA_WHIP=${result.laWhip} LA_K9=${result.laK9}`);
  return result;
}

// ─── Scoreboard scraper — all team game logs ─────────────────────────────────
async function fetchScoreboard(season) {
  const cached = cache.get('scoreboard');
  if (cached) return cached;

  const games = [];
  const seen  = new Set();

  // Fetch game logs for all teams, extract scores
  await Promise.allSettled(TEAMS.map(async ({ name, slug }) => {
    try {
      const html = await fetchPage(
        `https://pgcbl.com/sports/bsb/${season}/teams/${slug}?view=gamelog`
      );
      // Game log rows — look for table rows containing score data
      // pgcbl game log format: Date | Opponent | W/L | Score | ...
      const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) || [];
      for (const t of tableMatches) {
        const rowMatches = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
        const header = rowMatches[0] ? (rowMatches[0].match(/<th[^>]*>([\s\S]*?)<\/th>/gi) || []).map(h => stripTags(h).toLowerCase()) : [];
        // Look for game log table: has 'date', 'opponent', and 'score' or 'r' columns
        if (!header.some(h => h.includes('opp') || h.includes('opponent'))) continue;
        const dateIdx  = header.findIndex(h => h.includes('date'));
        const oppIdx   = header.findIndex(h => h.includes('opp'));
        const scoreIdx = header.findIndex(h => h === 'score' || h === 'r' || h.includes('score'));
        const resultIdx = header.findIndex(h => h === 'w/l' || h === 'result' || h === 'w' || h === 'l');

        for (const row of rowMatches.slice(1)) {
          const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(c => stripTags(c));
          if (cells.length < 3) continue;
          const rawDate = dateIdx >= 0 ? cells[dateIdx] : cells[0];
          const rawOpp  = oppIdx  >= 0 ? cells[oppIdx]  : cells[1];
          if (!rawDate || !rawOpp || rawDate.toLowerCase() === 'date') continue;

          // Parse date
          const dateStr = rawDate.trim();
          // Parse score — look for "W 9-6" or "L 3-5" or raw score cell
          let homeScore = null, awayScore = null, status = 'Final', gameDate = dateStr;
          const scoreCell = scoreIdx >= 0 ? cells[scoreIdx] : '';
          const resultCell = resultIdx >= 0 ? cells[resultIdx] : '';
          const combined = (resultCell + ' ' + scoreCell).trim();
          const scoreMatch = combined.match(/(\d+)\s*[-–]\s*(\d+)/);
          if (scoreMatch) {
            const a = parseInt(scoreMatch[1]), b = parseInt(scoreMatch[2]);
            const won = /^w/i.test(combined);
            // "W 9-6" means THIS team scored 9, opponent scored 6
            homeScore = won ? a : b;
            awayScore = won ? b : a;
          }

          // Build consistent game key (sort team slugs so duplicates get deduped)
          const oppClean = rawOpp.replace(/^[@at\s]+/i,'').trim();
          const isAway   = /^@/i.test(rawOpp);
          const home = isAway ? oppClean : name;
          const away = isAway ? name     : oppClean;
          const homeAbbr = home.split(/\s+/).map(w=>w[0]).join('').slice(0,3).toUpperCase();
          const awayAbbr = away.split(/\s+/).map(w=>w[0]).join('').slice(0,3).toUpperCase();
          const key = `${gameDate}|${awayAbbr}|${homeAbbr}`;
          if (seen.has(key)) continue;
          seen.add(key);

          games.push({
            date:       gameDate,
            away:       awayAbbr,
            home:       homeAbbr,
            away_name:  away,
            home_name:  home,
            away_score: isAway ? (homeScore != null ? awayScore : null) : (awayScore),
            home_score: isAway ? (homeScore != null ? homeScore : null) : (homeScore),
            status:     scoreMatch ? 'Final' : (dateStr ? 'Scheduled' : status),
          });
        }
        break; // found the game log table
      }
    } catch(e) { /* skip team if scrape fails */ }
  }));

  // Sort most recent first
  games.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));

  const result = { games: games.slice(0, 40), updatedAt: new Date().toISOString(), season };
  cache.set('scoreboard', result, 300); // 5-min cache for scoreboard
  return result;
}

// ─── Schedule scraper — upcoming games ───────────────────────────────────────
async function fetchSchedule(season) {
  const cached = cache.get('schedule');
  if (cached) return cached;

  const upcoming = [];
  const seen = new Set();
  const today = new Date().toISOString().slice(0, 10);

  await Promise.allSettled(TEAMS.map(async ({ name, slug }) => {
    try {
      const html = await fetchPage(
        `https://pgcbl.com/sports/bsb/${season}/teams/${slug}?view=schedule`
      );
      const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) || [];
      for (const t of tableMatches) {
        const rowMatches = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
        const header = rowMatches[0] ? (rowMatches[0].match(/<th[^>]*>([\s\S]*?)<\/th>/gi) || []).map(h => stripTags(h).toLowerCase()) : [];
        if (!header.some(h => h.includes('opp') || h.includes('opponent'))) continue;
        const dateIdx = header.findIndex(h => h.includes('date'));
        const oppIdx  = header.findIndex(h => h.includes('opp'));
        const timeIdx = header.findIndex(h => h.includes('time'));

        for (const row of rowMatches.slice(1)) {
          const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(c => stripTags(c));
          if (cells.length < 2) continue;
          const rawDate = dateIdx >= 0 ? cells[dateIdx] : cells[0];
          const rawOpp  = oppIdx  >= 0 ? cells[oppIdx]  : cells[1];
          const rawTime = timeIdx >= 0 ? cells[timeIdx]  : '';
          if (!rawDate || !rawOpp) continue;

          // Only include upcoming games
          const gameDate = rawDate.trim();
          if (!gameDate || gameDate.toLowerCase() === 'date') continue;

          const oppClean = rawOpp.replace(/^[@at\s]+/i,'').trim();
          const isAway   = /^@/i.test(rawOpp);
          const home = isAway ? oppClean : name;
          const away = isAway ? name     : oppClean;
          const homeAbbr = home.split(/\s+/).map(w=>w[0]).join('').slice(0,3).toUpperCase();
          const awayAbbr = away.split(/\s+/).map(w=>w[0]).join('').slice(0,3).toUpperCase();
          const key = `${gameDate}|${awayAbbr}|${homeAbbr}`;
          if (seen.has(key)) continue;
          seen.add(key);

          upcoming.push({ date: gameDate, away: awayAbbr, home: homeAbbr,
            away_name: away, home_name: home, time: rawTime.trim() || 'TBD' });
        }
        break;
      }
    } catch(e) {}
  }));

  upcoming.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
  const result = { games: upcoming.slice(0, 30), updatedAt: new Date().toISOString(), season };
  cache.set('schedule', result, 600);
  return result;
}

// ─── Static app ───────────────────────────────────────────────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'PGCBL Stats Server running (fetch-based)', season: getSeason() });
});

app.get('/api/stats', async (req, res) => {
  try {
    res.json(await fetchAllStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  cache.del('stats');
  cache.del('scoreboard');
  cache.del('schedule');
  try {
    const stats = await fetchAllStats();
    res.json({ success: true, updatedAt: stats.updatedAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Debug: test each team URL from Railway's IP ─────────────────────────────
app.get('/api/debug/teams', async (req, res) => {
  const season = getSeason();
  const TMPL = 'tmpl=teaminfo-network-monospace-template';
  const results = await Promise.allSettled(TEAMS.map(async ({ name, slug, slugAlt }) => {
    const BASE = `https://pgcbl.com/sports/bsb/${season}/teams/${slug}`;
    const BASE2 = slugAlt ? `https://pgcbl.com/sports/bsb/${season}/teams/${slugAlt}` : null;
    const [hRes, pRes] = await Promise.allSettled([
      fetchPage(`${BASE}?${TMPL}&sort=ab&pos=h`),
      fetchPage(`${BASE}?${TMPL}&sort=era&pos=p`),
    ]);
    const hSize = hRes.status === 'fulfilled' ? hRes.value.length : 0;
    const pSize = pRes.status === 'fulfilled' ? pRes.value.length : 0;
    const hParsed = hRes.status === 'fulfilled' ? parseHitters(hRes.value, name).length : 0;
    const pParsed = pRes.status === 'fulfilled' ? parsePitchers(pRes.value, name).length : 0;

    let altResult = null;
    if ((hParsed === 0 && pParsed === 0) && BASE2) {
      const [hAlt, pAlt] = await Promise.allSettled([
        fetchPage(`${BASE2}?${TMPL}&sort=ab&pos=h`),
        fetchPage(`${BASE2}?${TMPL}&sort=era&pos=p`),
      ]);
      altResult = {
        hSize: hAlt.status === 'fulfilled' ? hAlt.value.length : 0,
        pSize: pAlt.status === 'fulfilled' ? pAlt.value.length : 0,
        hParsed: hAlt.status === 'fulfilled' ? parseHitters(hAlt.value, name).length : 0,
        pParsed: pAlt.status === 'fulfilled' ? parsePitchers(pAlt.value, name).length : 0,
      };
    }

    return { name, slug, slugAlt, hSize, pSize, hParsed, pParsed, altResult };
  }));
  res.json(results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message }));
});

app.get('/api/scoreboard', async (req, res) => {
  try {
    res.json(await fetchScoreboard(getSeason()));
  } catch (e) {
    res.status(500).json({ error: e.message, games: [] });
  }
});

app.get('/api/schedule', async (req, res) => {
  try {
    res.json(await fetchSchedule(getSeason()));
  } catch (e) {
    res.status(500).json({ error: e.message, games: [] });
  }
});

// ─── Scouting (Dewey shared DB) ───────────────────────────────────────────────
app.get('/api/scouting', async (req, res) => {
  try {
    if (await dbReady()) {
      const { rows } = await pg.query('SELECT player_key, player_name, team, uploads, analysis, is_hot FROM scouting');
      const result = {};
      rows.forEach(r => {
        result[r.player_key] = { uploads: r.uploads, analysis: r.analysis, hot: r.is_hot };
      });
      return res.json(result);
    }
    // In-memory fallback
    res.json(memScouts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/scouting/:key', async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const { playerName, team, uploads = [], analysis = '', hot = false } = req.body;

  try {
    if (await dbReady()) {
      await pg.query(`
        INSERT INTO scouting (player_key, player_name, team, uploads, analysis, is_hot, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (player_key) DO UPDATE SET
          player_name = EXCLUDED.player_name,
          team        = EXCLUDED.team,
          uploads     = EXCLUDED.uploads,
          analysis    = EXCLUDED.analysis,
          is_hot      = EXCLUDED.is_hot,
          updated_at  = NOW()
      `, [key, playerName, team, JSON.stringify(uploads), analysis, hot]);
      return res.json({ success: true });
    }
    // In-memory fallback
    memScouts[key] = { uploads, analysis, hot };
    res.json({ success: true, storage: 'memory' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Pitch Availability ───────────────────────────────────────────────────────
async function ensurePitchTable() {
  if (!await dbReady()) return;
  await pg.query(`
    CREATE TABLE IF NOT EXISTS pitch_avail (
      pitcher_name TEXT PRIMARY KEY,
      team         TEXT,
      outings      JSONB DEFAULT '[]',
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(()=>{});
}
ensurePitchTable();

app.get('/api/pitches', async (req, res) => {
  try {
    if (await dbReady()) {
      const { rows } = await pg.query('SELECT pitcher_name, team, outings FROM pitch_avail');
      const result = {};
      rows.forEach(r => { result[r.pitcher_name] = { name: r.pitcher_name, team: r.team, outings: r.outings }; });
      return res.json(result);
    }
    res.json({});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pitches/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { team = 'Batavia Muckdogs', outings = [] } = req.body;
  try {
    if (await dbReady()) {
      await pg.query(`
        INSERT INTO pitch_avail (pitcher_name, team, outings, updated_at)
        VALUES ($1,$2,$3,NOW())
        ON CONFLICT (pitcher_name) DO UPDATE SET team=$2, outings=$3, updated_at=NOW()
      `, [name, team, JSON.stringify(outings)]);
      return res.json({ success: true });
    }
    res.json({ success: true, storage: 'none' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Game Sheets ──────────────────────────────────────────────────────────────
async function ensureSheetsTable() {
  if (!await dbReady()) return;
  await pg.query(`
    CREATE TABLE IF NOT EXISTS game_sheets (
      sheet_id   TEXT PRIMARY KEY,
      opponent   TEXT,
      game_date  DATE,
      photos     JSONB DEFAULT '[]',
      batters    JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(()=>{});
}
ensureSheetsTable();

app.get('/api/sheets', async (req, res) => {
  try {
    if (await dbReady()) {
      const { rows } = await pg.query('SELECT sheet_id AS id, opponent, game_date AS date, photos, batters, created_at AS "createdAt" FROM game_sheets ORDER BY game_date DESC');
      return res.json(rows.map(r => ({ ...r, date: r.date?.toISOString?.().slice(0,10) || r.date })));
    }
    res.json([]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sheets', async (req, res) => {
  const { id, opponent, date, photos = [], batters = [], createdAt } = req.body;
  if (!id || !opponent || !date) return res.status(400).json({ error: 'id, opponent, date required' });
  try {
    if (await dbReady()) {
      await pg.query(`
        INSERT INTO game_sheets (sheet_id, opponent, game_date, photos, batters, created_at)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (sheet_id) DO UPDATE SET opponent=$2, game_date=$3, photos=$4, batters=$5
      `, [id, opponent, date, JSON.stringify(photos), JSON.stringify(batters), createdAt || new Date()]);
      return res.json({ success: true });
    }
    res.json({ success: true, storage: 'none' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI Pitch Chart Parser ────────────────────────────────────────────────────
app.post('/api/parse-chart', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No AI key', pitchers: [], bullpen: [], notes: '' });

  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'image required' });

  try {
    const base64    = image.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-20250307',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: `This is a baseball in-game pitching chart. It has three bottom sections:
- BULLPEN (bottom left): lists relievers with their pitch counts
- PITCHER/TOTALS (bottom middle): columns Name, P# (total pitches), H, HBP/BB, K — one row per pitcher
- NOTES (bottom right): free-text notes

Extract every pitcher you can read clearly. Return ONLY this JSON (no other text):
{"pitchers":[{"name":"LastName","pitches":72}],"bullpen":[{"name":"LastName","pitches":18}],"notes":"any notes text"}

Rules: name = last name only, pitches = integer pitch count. Skip any row where you cannot read both name and a number. Empty sections = empty array or "".` }
          ]
        }]
      }),
      signal: AbortSignal.timeout(22000),
    });

    const d    = await r.json();
    const text = d.content?.[0]?.text || '{}';
    const obj  = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    res.json({ pitchers: obj.pitchers || [], bullpen: obj.bullpen || [], notes: obj.notes || '' });
  } catch (e) {
    console.error('parse-chart:', e.message);
    res.json({ pitchers: [], bullpen: [], notes: '' });
  }
});

// ─── AI Sheet Parser ──────────────────────────────────────────────────────────
app.post('/api/parse-sheet', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No AI key configured', batters: [] });

  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'image required' });

  try {
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-20250307',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'This is a baseball scouting sheet. It has rows for each batter with columns: batter name/spray chart, plan of attack, results, and a checkmark if the plan worked. Extract each batter row and return ONLY a JSON array like: [{"name":"Last, First","notes":"plan notes","result":"what happened"}]. If you cannot read the sheet clearly, return []. No other text.' }
          ]
        }]
      }),
      signal: AbortSignal.timeout(20000),
    });

    const data = await r.json();
    const text = data.content?.[0]?.text || '[]';
    const batters = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || '[]');
    res.json({ batters });
  } catch (e) {
    console.error('parse-sheet error:', e.message);
    res.json({ batters: [] });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PGCBL server on port ${PORT} — fetch-based scraper active`));
