'use strict';
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const cron     = require('node-cron');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Season helper ────────────────────────────────────────────────────────────
// PGCBL uses academic year format: summer 2026 = "2025-26"
function getSeason() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1;
  // If June or later, we're in the current summer season (e.g. June 2026 → 2025-26)
  // If before June, we reference the previous summer season (e.g. Jan 2027 → 2025-26)
  const seasonEnd = m >= 6 ? y : y - 1;
  return `${seasonEnd - 1}-${String(seasonEnd).slice(2)}`;
}

// ─── West Division teams ──────────────────────────────────────────────────────
const TEAMS = [
  { name: 'Batavia Muckdogs',        slug: 'bataviamuckdogs' },
  { name: 'Jamestown Tarp Skunks',   slug: 'jamestowntarpskunks' },
  { name: 'Auburn Doubledays',       slug: 'auburndoubledays' },
  { name: 'Geneva Red Wings',        slug: 'genevaredwings' },
  { name: 'Newark Pilots',           slug: 'newarkpilots' },
  { name: 'Niagara Falls Americans', slug: 'niagarafallsamericans' },
  { name: 'Niagara Ironbacks',       slug: 'niagaraironbacks' },
  { name: 'Elmira Pioneers',         slug: 'elmirapioneers' },
  { name: 'Olean Oilers',            slug: 'oleanoilers' },
];
const WEST_SET = new Set(TEAMS.map(t => t.name));

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
let pg = null;

async function initDB() {
  if (!process.env.DATABASE_URL) { console.warn('No DATABASE_URL'); return false; }
  try {
    pg = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
    await pg.query('SELECT 1');
    await pg.query(`
      CREATE TABLE IF NOT EXISTS scrape_meta (
        key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS standings (
        season TEXT, rank INTEGER DEFAULT 0, name TEXT NOT NULL,
        w INTEGER DEFAULT 0, l INTEGER DEFAULT 0, t INTEGER DEFAULT 0,
        pct DECIMAL(5,3) DEFAULT 0, gb TEXT DEFAULT '-',
        streak TEXT DEFAULT '', last10 TEXT DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (season, name)
      );
      CREATE TABLE IF NOT EXISTS hitter_stats (
        season TEXT, name TEXT NOT NULL, team TEXT NOT NULL,
        gp INTEGER DEFAULT 0, ab DECIMAL DEFAULT 0, h INTEGER DEFAULT 0,
        rbi INTEGER DEFAULT 0, bb INTEGER DEFAULT 0,
        doubles INTEGER DEFAULT 0, triples INTEGER DEFAULT 0,
        hr INTEGER DEFAULT 0, xbh INTEGER DEFAULT 0, k INTEGER DEFAULT 0,
        avg DECIMAL(6,4) DEFAULT 0, obp DECIMAL(6,4) DEFAULT 0,
        slg DECIMAL(6,4) DEFAULT 0, pa INTEGER DEFAULT 0,
        ops DECIMAL(6,4) DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (season, name, team)
      );
      CREATE TABLE IF NOT EXISTS pitcher_stats (
        season TEXT, name TEXT NOT NULL, team TEXT NOT NULL,
        era DECIMAL(6,2) DEFAULT 0, w INTEGER DEFAULT 0, l INTEGER DEFAULT 0,
        app INTEGER DEFAULT 0, gs INTEGER DEFAULT 0, sv INTEGER DEFAULT 0,
        ip DECIMAL(6,1) DEFAULT 0, h INTEGER DEFAULT 0, r INTEGER DEFAULT 0,
        er INTEGER DEFAULT 0, bb INTEGER DEFAULT 0, k INTEGER DEFAULT 0,
        k9 DECIMAL(6,2) DEFAULT 0, hr INTEGER DEFAULT 0,
        whip DECIMAL(6,3) DEFAULT 0, bf INTEGER DEFAULT 0,
        wp INTEGER DEFAULT 0, hbp INTEGER DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (season, name, team)
      );
      CREATE TABLE IF NOT EXISTS rosters (
        season TEXT, team TEXT NOT NULL, player_name TEXT NOT NULL,
        number TEXT DEFAULT '', position TEXT DEFAULT '',
        player_year TEXT DEFAULT '', hometown TEXT DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (season, team, player_name)
      );
      CREATE TABLE IF NOT EXISTS pitch_availability (
        season TEXT, pitcher_name TEXT NOT NULL,
        team TEXT DEFAULT 'Batavia Muckdogs',
        last_outing_date DATE, last_outing_pitches INTEGER DEFAULT 0,
        last_outing_ip DECIMAL(4,1) DEFAULT 0,
        is_manual BOOLEAN DEFAULT FALSE,
        outing_type TEXT DEFAULT 'Game',
        notes TEXT DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (season, pitcher_name)
      );
      CREATE TABLE IF NOT EXISTS box_scores (
        season TEXT, game_id TEXT NOT NULL,
        home_team TEXT DEFAULT '', away_team TEXT DEFAULT '',
        home_score INTEGER DEFAULT 0, away_score INTEGER DEFAULT 0,
        game_date DATE, status TEXT DEFAULT 'F',
        innings JSONB DEFAULT '[]',
        pitcher_lines JSONB DEFAULT '[]',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (season, game_id)
      );
      CREATE TABLE IF NOT EXISTS game_stats (
        id SERIAL PRIMARY KEY,
        season TEXT NOT NULL,
        game_id TEXT NOT NULL,
        game_date DATE,
        opponent TEXT DEFAULT '',
        is_home BOOLEAN DEFAULT TRUE,
        batavia_score INTEGER,
        opp_score INTEGER,
        result TEXT DEFAULT '',
        innings JSONB DEFAULT '[]',
        batavia_batting JSONB DEFAULT '[]',
        batavia_pitching JSONB DEFAULT '[]',
        opp_batting JSONB DEFAULT '[]',
        opp_pitching JSONB DEFAULT '[]',
        wp TEXT DEFAULT '',
        lp TEXT DEFAULT '',
        box_score_url TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (season, game_id)
      );
      CREATE INDEX IF NOT EXISTS idx_gs_date ON game_stats(season, game_date);
      CREATE TABLE IF NOT EXISTS schedule (
        season TEXT, game_id TEXT NOT NULL,
        game_date DATE, game_time TEXT DEFAULT '',
        home_team TEXT DEFAULT '', away_team TEXT DEFAULT '',
        location TEXT DEFAULT '',
        batavia_score INTEGER, opp_score INTEGER,
        result TEXT DEFAULT '',
        is_home BOOLEAN DEFAULT TRUE,
        status TEXT DEFAULT 'scheduled',
        box_score_url TEXT DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (season, game_id)
      );
      CREATE TABLE IF NOT EXISTS scouting (
        player_key TEXT PRIMARY KEY, player_name TEXT, team TEXT,
        uploads JSONB DEFAULT '[]', analysis TEXT DEFAULT '',
        is_hot BOOLEAN DEFAULT FALSE, updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pitch_avail (
        pitcher_name TEXT PRIMARY KEY, team TEXT,
        outings JSONB DEFAULT '[]', updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS game_sheets (
        sheet_id TEXT PRIMARY KEY, opponent TEXT, game_date DATE,
        photos JSONB DEFAULT '[]', batters JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS game_scouting_reports (
        id SERIAL PRIMARY KEY,
        season TEXT,
        opponent TEXT,
        game_date DATE,
        jersey_number TEXT DEFAULT '',
        player_name TEXT DEFAULT '',
        handedness TEXT DEFAULT '',
        shade_notes TEXT DEFAULT '',
        plan_of_attack TEXT DEFAULT '',
        results TEXT DEFAULT '',
        success BOOLEAN,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS charting_sessions (
        id SERIAL PRIMARY KEY,
        season TEXT NOT NULL,
        game_id TEXT,
        game_date DATE NOT NULL,
        opponent TEXT DEFAULT '',
        home_away TEXT DEFAULT '',
        session_type TEXT DEFAULT 'game',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pitches (
        id SERIAL PRIMARY KEY,
        client_id TEXT UNIQUE NOT NULL,
        session_id INTEGER REFERENCES charting_sessions(id),
        season TEXT NOT NULL,
        pitcher_name TEXT NOT NULL, pitcher_team TEXT NOT NULL,
        batter_name  TEXT NOT NULL, batter_team  TEXT NOT NULL,
        inning INTEGER, half TEXT, balls INTEGER, strikes INTEGER, outs INTEGER,
        pitch_type TEXT,
        velo NUMERIC(4,1),
        zone_x NUMERIC(4,3), zone_y NUMERIC(4,3),
        result TEXT NOT NULL,
        batted_ball_type TEXT,
        in_play_outcome TEXT,
        spray_x NUMERIC(4,3), spray_y NUMERIC(4,3),
        ts TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pitcher_repertoire (
        season TEXT, team TEXT, player_name TEXT,
        pitch_types JSONB DEFAULT '["FB","SI","CH","CB","SL","CT"]',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (season, team, player_name)
      );
    `);
    await pg.query(`
      CREATE INDEX IF NOT EXISTS idx_pitches_pitcher ON pitches(season, pitcher_team, pitcher_name);
      CREATE INDEX IF NOT EXISTS idx_pitches_batter  ON pitches(season, batter_team, batter_name);
      CREATE INDEX IF NOT EXISTS idx_pitches_matchup ON pitches(pitcher_name, pitcher_team, batter_name, batter_team);
      CREATE INDEX IF NOT EXISTS idx_pitches_session ON pitches(session_id);
    `).catch(() => {});
    await pg.query(`
      CREATE INDEX IF NOT EXISTS idx_gsr_opponent ON game_scouting_reports(season, opponent);
      CREATE INDEX IF NOT EXISTS idx_gsr_player   ON game_scouting_reports(season, player_name);
    `).catch(() => {});
    await pg.query(`
      CREATE TABLE IF NOT EXISTS pitcher_tendency_reports (
        id SERIAL PRIMARY KEY,
        season TEXT,
        opponent TEXT,
        game_date DATE,
        pitcher_name TEXT DEFAULT '',
        pitcher_number TEXT DEFAULT '',
        handedness TEXT DEFAULT '',
        runner_1b JSONB DEFAULT '{}',
        runner_2b JSONB DEFAULT '{}',
        pre_pitch TEXT DEFAULT '',
        set_position TEXT DEFAULT '',
        first_moves TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ptr_opponent ON pitcher_tendency_reports(season, opponent);
      CREATE INDEX IF NOT EXISTS idx_ptr_pitcher  ON pitcher_tendency_reports(season, pitcher_name);
    `).catch(() => {});
    // Migrate existing tables — ADD COLUMN IF NOT EXISTS is idempotent
    await pg.query(`
      ALTER TABLE pitch_availability ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT FALSE;
      ALTER TABLE pitch_availability ADD COLUMN IF NOT EXISTS outing_type TEXT DEFAULT 'Game';
      ALTER TABLE pitch_availability ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';
      ALTER TABLE box_scores ADD COLUMN IF NOT EXISTS innings JSONB DEFAULT '[]';
      ALTER TABLE box_scores ADD COLUMN IF NOT EXISTS pitcher_lines JSONB DEFAULT '[]';
      ALTER TABLE game_stats ADD COLUMN IF NOT EXISTS home_team TEXT DEFAULT '';
      ALTER TABLE game_stats ADD COLUMN IF NOT EXISTS away_team TEXT DEFAULT '';
      ALTER TABLE game_stats ADD COLUMN IF NOT EXISTS home_score INTEGER;
      ALTER TABLE game_stats ADD COLUMN IF NOT EXISTS away_score INTEGER;
      ALTER TABLE game_stats ADD COLUMN IF NOT EXISTS home_batting JSONB DEFAULT '[]';
      ALTER TABLE game_stats ADD COLUMN IF NOT EXISTS away_batting JSONB DEFAULT '[]';
      ALTER TABLE game_stats ADD COLUMN IF NOT EXISTS home_pitching JSONB DEFAULT '[]';
      ALTER TABLE game_stats ADD COLUMN IF NOT EXISTS away_pitching JSONB DEFAULT '[]';
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS in_play_outcome TEXT;
    `).catch(e => console.warn('Migration warning:', e.message));
    // Index for querying by team and date across all West Division games
    await pg.query(`
      CREATE INDEX IF NOT EXISTS idx_gs_home_team ON game_stats(season, home_team, game_date);
      CREATE INDEX IF NOT EXISTS idx_gs_away_team ON game_stats(season, away_team, game_date);
    `).catch(() => {});
    await pg.query(`
      CREATE TABLE IF NOT EXISTS scrape_log (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMPTZ DEFAULT NOW(),
        trigger TEXT DEFAULT 'cron',
        games_before INT DEFAULT 0,
        games_after INT DEFAULT 0,
        new_games INT DEFAULT 0,
        success BOOLEAN DEFAULT true,
        error TEXT DEFAULT ''
      );
    `).catch(() => {});
    console.log('PostgreSQL ready — all tables created');
    return true;
  } catch (e) {
    console.error('DB init failed:', e.message);
    pg = null; return false;
  }
}

// ─── Scrape state ─────────────────────────────────────────────────────────────
let isScraping = false;
let scrapeStartedAt = null; // tracks when current scrape began; used to detect stuck runs
let scrapeLog  = [];
function logScrape(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  scrapeLog.push(line);
  if (scrapeLog.length > 200) scrapeLog.shift();
}

async function getMetaValue(key) {
  if (!pg) return null;
  try {
    const { rows } = await pg.query("SELECT value FROM scrape_meta WHERE key=$1", [key]);
    return rows[0]?.value || null;
  } catch { return null; }
}
async function setMetaValue(key, value) {
  if (!pg) return;
  await pg.query(
    "INSERT INTO scrape_meta(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()",
    [key, String(value)]
  ).catch(() => {});
}

// ─── HTML fetch helpers (fallback when Puppeteer unavailable) ─────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchHTML(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml,*/*' },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g,'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#\d+;/g,'').replace(/\s+/g,' ').trim();
}
function cleanName(s) {
  return (s||'')
    .replace(/\s*\([^)]*\)\s*/g, ' ') // strip (W, 1-0), (L, 0-1), (S, 1), etc.
    .replace(/\.+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function pf(s) { const v = parseFloat(s); return isNaN(v) ? null : v; }
function pi(s) { const v = parseInt(s);   return isNaN(v) ? null : v; }

// Known name misspellings in PrestoSports box scores → canonical full name
// Add entries here whenever a pitcher shows up with two different spellings
const PITCHER_NAME_ALIASES = {
  'eric woodly':    'Eric Woodley',
  'e woodly':       'Eric Woodley',
  'e woodley':      'Eric Woodley',
};
function canonicalizePitcherName(name) {
  const lower = (name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return PITCHER_NAME_ALIASES[lower] || name.trim().replace(/\s+/g, ' ');
}

// Baseball IP: X.Y where Y is outs (0,1,2) — NOT decimal tenths
// e.g. 3.2 IP = 3 full innings + 2 outs = 11 outs total
function ipToOuts(ip) {
  const full = Math.floor(ip);
  const partial = Math.round((ip - full) * 10);
  return full * 3 + Math.min(partial, 2);
}
function outsToIpStr(outs) {
  return Math.floor(outs / 3) + '.' + (outs % 3);
}
function outsToRealInnings(outs) {
  return outs / 3;
}

function parseHTMLTables(html) {
  const tables = [];
  const tMatches = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const t of tMatches) {
    const headers = (t.match(/<th[^>]*>([\s\S]*?)<\/th>/gi)||[]).map(h => stripTags(h).toLowerCase());
    const rowMatches = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const rows = rowMatches.map(row => {
      return (row.match(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)||[]).map(c => stripTags(c));
    }).filter(r => r.length > 1);
    tables.push({ headers, rows, raw: t });
  }
  return tables;
}

// ─── Puppeteer launcher ───────────────────────────────────────────────────────
let browser = null;
let puppeteer = null;
let puppeteerAvailable = false;

async function loadPuppeteer() {
  if (puppeteer !== null) return puppeteerAvailable;
  try {
    puppeteer = require('puppeteer');
    puppeteerAvailable = true;
    logScrape('Puppeteer module loaded');
  } catch (e) {
    puppeteer = false;
    puppeteerAvailable = false;
    logScrape('Puppeteer not available, using fetch fallback: ' + e.message);
  }
  return puppeteerAvailable;
}

async function getBrowser() {
  if (!await loadPuppeteer()) return null;
  if (browser) {
    try { await browser.version(); return browser; } catch { browser = null; }
  }
  logScrape('Launching Chrome browser...');
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-accelerated-2d-canvas', '--no-first-run',
        '--no-zygote', '--single-process',
        '--disable-extensions', '--disable-background-networking',
        '--disable-default-apps', '--disable-sync',
        '--disable-translate', '--hide-scrollbars',
        '--metrics-recording-only', '--mute-audio',
        '--safebrowsing-disable-auto-update',
        '--js-flags=--max-old-space-size=256',
        '--window-size=1280,800',
      ],
      timeout: 30000,
    });
    logScrape('Chrome launched successfully');
    return browser;
  } catch (e) {
    logScrape('Chrome launch failed: ' + e.message + ' — falling back to fetch');
    browser = null; puppeteerAvailable = false;
    return null;
  }
}

async function closeBrowser() {
  if (browser) { try { await browser.close(); } catch {} browser = null; }
}

function delay(min = 3000, max = 7000) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

// Get page HTML: try Puppeteer first, fall back to fetch
// Hard 60s outer timeout so a Chrome crash can never hang this forever
async function getPageHTML(url, br, extraWaitMs = 0) {
  if (br) {
    const puppeteerResult = await Promise.race([
      (async () => {
        let page = null;
        try {
          page = await br.newPage();
          await page.setUserAgent(UA);
          await page.setViewport({ width: 1280, height: 800 });
          await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

          // Block images, fonts, stylesheets, media — we only need HTML + JS for table data
          await page.setRequestInterception(true);
          page.on('request', req => {
            const type = req.resourceType();
            if (['image','stylesheet','font','media','other'].includes(type)) {
              req.abort();
            } else {
              req.continue();
            }
          });

          await delay(1500, 3000);
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch {
            await page.goto(url, { waitUntil: 'load', timeout: 30000 });
          }
          // Wait for Presto Sports JS to render table data
          try {
            await page.waitForSelector('table tbody tr', { timeout: 8000 });
          } catch {}
          // Extra wait for any async data rendering
          await delay(1000, 2000);
          // Optional additional wait for slow-rendering pages
          if (extraWaitMs > 0) await new Promise(r => setTimeout(r, extraWaitMs));
          // Accept cookie banners
          try {
            for (const sel of ['#onetrust-accept-btn-handler','.accept-cookies','button[aria-label*="Accept"]']) {
              const btn = await page.$(sel);
              if (btn) { await btn.click(); await delay(500, 1000); break; }
            }
          } catch {}
          const html = await page.content();
          await page.close();
          return html;
        } catch (e) {
          if (page) try { await page.close(); } catch {}
          logScrape(`  Puppeteer failed for ${url}: ${e.message} — trying fetch`);
          return null;
        }
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Puppeteer 60s hard timeout')), 60000)),
    ]).catch(async e => {
      // Hard timeout — browser is hung/crashed; close it so fetch fallback is instant for remaining calls
      logScrape(`  Puppeteer hard timeout for ${url} — closing crashed browser, using fetch`);
      await closeBrowser().catch(() => {});
      return null;
    });

    if (puppeteerResult) return puppeteerResult;
  }
  // fetch fallback
  await delay(2000, 4000);
  return fetchHTML(url);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SCRAPERS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 1. Standings ─────────────────────────────────────────────────────────────
async function scrapeStandings(season, br) {
  logScrape('Scraping standings...');
  const html = await getPageHTML(`https://pgcbl.com/sports/bsb/${season}/standings`, br);
  const tables = parseHTMLTables(html);
  let westRows = [];
  for (const { rows } of tables) {
    const flat = rows.map(r=>r.join(' ').toLowerCase()).join(' ');
    if (flat.includes('batavia')) { westRows = rows; break; }
  }
  const data = westRows
    .filter(r => r[0] && !['team',''].includes(r[0].toLowerCase()))
    .map((r, i) => ({
      rank: i+1, name: r[0].trim(),
      w: pi(r[1])??0, l: pi(r[2])??0, t: pi(r[3])??0,
      pct: pf(r[4])??0, gb: r[5]?.trim()||'-',
      streak: r[6]?.trim()||'', last10: r[7]?.trim()||'',
    }));
  if (!data.length) { logScrape('  No standings data'); return; }
  if (!pg) return;
  await pg.query('DELETE FROM standings WHERE season=$1', [season]);
  for (const row of data) {
    await pg.query(
      `INSERT INTO standings(season,rank,name,w,l,t,pct,gb,streak,last10)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(season,name) DO UPDATE SET rank=$2,w=$4,l=$5,t=$6,pct=$7,gb=$8,streak=$9,last10=$10,updated_at=NOW()`,
      [season, row.rank, row.name, row.w, row.l, row.t, row.pct, row.gb, row.streak, row.last10]
    ).catch(() => {});
  }
  logScrape(`  ✓ ${data.length} standings rows`);
}

// ─── 2. Hitter stats ──────────────────────────────────────────────────────────
async function scrapeHitters(season, br) {
  logScrape('Scraping hitter stats...');
  const html = await getPageHTML(`https://pgcbl.com/sports/bsb/${season}/players?pos=h&sort=avg`, br);
  const tables = parseHTMLTables(html);
  let saved = 0;
  for (const { headers, rows } of tables) {
    if (!headers.includes('avg') || !headers.includes('ab')) continue;
    const idx = Object.fromEntries(headers.map((h,i) => [h,i]));
    for (const r of rows) {
      const name = cleanName(r[idx['player']??idx['name']??0]);
      const team = r[idx['team']??1]||'';
      if (!name || name.length < 2 || /^(total|opponent)/i.test(name)) continue;
      if (!WEST_SET.has(team)) continue;
      const ab = pf(r[idx['ab']])||0;
      if (ab < 1) continue;
      const h  = pi(r[idx['h']])||0;
      const obp = pf(r[idx['ob%']]??r[idx['obp']])||0;
      const slg = pf(r[idx['slg%']]??r[idx['slg']])||0;
      if (!pg) continue;
      await pg.query(
        `INSERT INTO hitter_stats(season,name,team,gp,ab,h,rbi,bb,doubles,triples,hr,xbh,k,avg,obp,slg,pa,ops)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT(season,name,team) DO UPDATE SET
           gp=$4,ab=$5,h=$6,rbi=$7,bb=$8,doubles=$9,triples=$10,hr=$11,xbh=$12,k=$13,
           avg=$14,obp=$15,slg=$16,pa=$17,ops=$18,updated_at=NOW()`,
        [season, name, team,
         pi(r[idx['gp']])||0, ab, h,
         pi(r[idx['rbi']])||0, pi(r[idx['bb']])||0,
         pi(r[idx['2b']])||0, pi(r[idx['3b']])||0,
         pi(r[idx['hr']])||0, pi(r[idx['xbh']])||0,
         pi(r[idx['so']]??r[idx['k']])||0,
         pf(r[idx['avg']])||0, obp, slg,
         pi(r[idx['pa']])||0,
         parseFloat((obp+slg).toFixed(4)),
        ]
      ).catch(() => {});
      saved++;
    }
    if (saved) break;
  }
  logScrape(`  ✓ ${saved} hitters`);
}

// ─── 3. Pitcher stats ─────────────────────────────────────────────────────────
async function scrapePitchers(season, br) {
  logScrape('Scraping pitcher stats...');
  const html = await getPageHTML(`https://pgcbl.com/sports/bsb/${season}/players?pos=p&sort=era`, br);
  const tables = parseHTMLTables(html);
  let saved = 0;
  for (const { headers, rows } of tables) {
    if (!headers.includes('era') || !headers.includes('ip')) continue;
    const idx = Object.fromEntries(headers.map((h,i) => [h,i]));
    for (const r of rows) {
      const name = cleanName(r[idx['player']??idx['name']??0]);
      const team = r[idx['team']??1]||'';
      if (!name || name.length < 2 || /^(total|opponent)/i.test(name)) continue;
      if (!WEST_SET.has(team)) continue;
      const ip = pf(r[idx['ip']])||0;
      if (ip < 0.1) continue;
      const h_val = pi(r[idx['h']])||0;
      const bb    = pi(r[idx['bb']])||0;
      const k     = pi(r[idx['so']]??r[idx['k']])||0;
      const era   = pf(r[idx['era']])||0;
      const whip  = ip > 0 ? parseFloat(((h_val+bb)/ip).toFixed(3)) : 0;
      // PGCBL header is "k/9" not "k9"
      const k9    = ip > 0 ? parseFloat((k/ip*9).toFixed(2)) : (pf(r[idx['k/9']]??r[idx['k9']])||0);
      if (!pg) continue;
      await pg.query(
        `INSERT INTO pitcher_stats(season,name,team,era,w,l,app,gs,sv,ip,h,r,er,bb,k,k9,hr,whip,bf,wp,hbp)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT(season,name,team) DO UPDATE SET
           era=$4,w=$5,l=$6,app=$7,gs=$8,sv=$9,ip=$10,h=$11,r=$12,er=$13,bb=$14,k=$15,
           k9=$16,hr=$17,whip=$18,bf=$19,wp=$20,hbp=$21,updated_at=NOW()`,
        [season, name, team, era,
         pi(r[idx['w']])||0, pi(r[idx['l']])||0,
         pi(r[idx['app']]??r[idx['g']])||0,
         pi(r[idx['gs']])||0, pi(r[idx['sv']])||0,
         ip, h_val, pi(r[idx['r']])||0, pi(r[idx['er']])||0,
         bb, k, k9, pi(r[idx['hr']])||0, whip,
         pi(r[idx['bf']])||0, pi(r[idx['wp']])||0, pi(r[idx['hbp']])||0,
        ]
      ).catch(() => {});
      saved++;
    }
    if (saved) break;
  }
  logScrape(`  ✓ ${saved} pitchers`);
}

// ─── 4. Rosters ───────────────────────────────────────────────────────────────
// PGCBL lineup pages use DataTables which splits into a header-only table and
// a body-only table (all <td>, no <th>). We detect the body table by column count.
async function scrapeRosters(season, br) {
  logScrape('Scraping rosters...');
  // Build team list dynamically from standings DB + hardcoded fallback
  let teams = TEAMS;
  if (pg) {
    const { rows } = await pg.query('SELECT name FROM standings WHERE season=$1 ORDER BY rank', [season]).catch(() => ({ rows: [] }));
    if (rows.length) {
      teams = rows.map(r => ({
        name: r.name,
        slug: r.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      }));
    }
  }
  for (const team of teams) {
    try {
    // Scrape lineup (hitters), roster (full team incl. pitchers), and hitter-specific lineup
    // Also try pgcbl.prestosports.com with extra 5s wait for teams that may render slower
    const urlSets = [
      { url: `https://pgcbl.com/sports/bsb/${season}/teams/${team.slug}?view=lineup`,          wait: 0 },
      { url: `https://pgcbl.com/sports/bsb/${season}/teams/${team.slug}?view=roster`,          wait: 0 },
      { url: `https://pgcbl.com/sports/bsb/${season}/teams/${team.slug}?view=lineup&r=1&pos=h`,wait: 0 },
      { url: `https://pgcbl.prestosports.com/sports/bsb/${season}/teams/${team.slug}?view=lineup&r=1&pos=h`, wait: 5000 },
    ];
    const allTables = [];
    for (const { url, wait } of urlSets) {
      const html = await getPageHTML(url, br, wait).catch(e => { logScrape(`  ${team.name} fetch failed (${url.split('?')[1]}): ${e.message}`); return ''; });
      allTables.push(...parseHTMLTables(html));
    }
    const tables = allTables;
    let saved = 0;

    // Find the header row first (from the header-only table)
    let colHeaders = [];
    for (const { headers } of tables) {
      if (headers.includes('name') || headers.includes('player')) {
        colHeaders = headers; break;
      }
    }
    const idx = Object.fromEntries(colHeaders.map((h,i) => [h,i]));
    const nameCol = idx['name']??idx['player']??1; // default col 1 (after jersey #)

    // Collect all valid player rows from all pages before touching the DB
    // Use a Map keyed by normalized name to deduplicate across multiple URL fetches
    const playerMap = new Map();
    for (const { headers, rows } of tables) {
      const dataRows = rows.filter(r => {
        if (r.length < 4) return false;
        if (!/^\d{1,3}$/.test(r[0])) return false; // col 0 must be jersey number
        const name = cleanName(r[nameCol] || r[1]);
        return name && name.length >= 3 && /^[A-Z][a-z]/.test(name);
      });
      for (const r of dataRows) {
        const name = cleanName(r[nameCol]);
        if (!name || name.length < 2) continue;
        const key = name.toLowerCase().replace(/[^a-z]/g, '');
        if (!playerMap.has(key)) {
          playerMap.set(key, {
            name,
            number:   r[idx['#']??idx['no']??idx['num']??0]||'',
            position: r[idx['pos']??idx['position']??3]||'',
            year:     r[idx['yr']??idx['year']??idx['cl']??-1]||'',
            hometown: r[idx['hometown']??idx['city']??idx['from']??-1]||'',
          });
        }
      }
    }
    const newPlayers = [...playerMap.values()];

    if (newPlayers.length > 0 && pg) {
      // Pure upsert — never DELETE. Manually-seeded players that aren't on PGCBL yet
      // stay in the DB; PGCBL data fills in/updates number, position, year, hometown.
      for (const p of newPlayers) {
        const res = await pg.query(
          `INSERT INTO rosters(season,team,player_name,number,position,player_year,hometown)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(season,team,player_name) DO UPDATE SET
             number=COALESCE(NULLIF($4,''),rosters.number),
             position=COALESCE(NULLIF($5,''),rosters.position),
             player_year=COALESCE(NULLIF($6,''),rosters.player_year),
             hometown=COALESCE(NULLIF($7,''),rosters.hometown),
             updated_at=NOW()`,
          [season, team.name, p.name, p.number, p.position, p.year, p.hometown]
        ).catch(() => null);
        if (res) saved++;
      }
    }
    logScrape(`  ${team.name}: ${saved} players${newPlayers.length===0?' (no roster on PGCBL yet — keeping existing data)':''}`);
    } catch (e) {
      logScrape(`  ${team.name}: roster scrape failed (skipping) — ${e.message}`);
    }
  }
}

// ─── 5. Pitch counts from box scores ─────────────────────────────────────────
async function scrapePitchCounts(season, br) {
  logScrape('Scraping Batavia pitch counts...');

  // Get gamelog page to find HTML box score links
  // We intentionally skip .xml data files — those contain season-accumulated stats.
  // The HTML box score pages show per-game pitch counts (NP column).
  const logHTML = await getPageHTML(
    `https://pgcbl.com/sports/bsb/${season}/teams/bataviamuckdogs?view=gamelog`, br
  );

  // Extract HTML box score page links (skip .xml data feeds)
  const linkSet = new Set();
  // Pattern 1: href="/sports/bsb/2025-26/boxscores/GAMEID"
  for (const m of logHTML.matchAll(/href="([^"]*\/boxscores\/[^"?#]+)"/gi)) {
    const path = m[1];
    if (path.includes('.xml') || path.includes('.json')) continue;
    const url = path.startsWith('http') ? path : `https://pgcbl.com${path.startsWith('/') ? path : '/' + path}`;
    linkSet.add(url);
  }
  // Pattern 2: standalone game IDs embedded as YYYYMMDD_xxx strings in the page
  if (linkSet.size === 0) {
    for (const m of logHTML.matchAll(/\/boxscores\/(\d{8}[^"'\s<>.]+)/gi)) {
      linkSet.add(`https://pgcbl.com/sports/bsb/${season}/boxscores/${m[1]}`);
    }
  }
  // Fallback: try the .xml links but load their HTML viewer equivalent
  if (linkSet.size === 0) {
    for (const m of logHTML.matchAll(/boxscores\/([^"'\s<>]+\.xml)/g)) {
      // Strip .xml — PrestoSports often serves HTML at the path without extension
      const id = m[1].replace(/\.xml$/, '');
      linkSet.add(`https://pgcbl.com/sports/bsb/${season}/boxscores/${id}`);
    }
  }

  const links = [...linkSet].slice(0, 30);
  logScrape(`  Found ${links.length} box score links`);

  // Track most recent single-game outing per Batavia pitcher
  const pitchMap = {}; // { name: { date, pitches, ip } }

  for (const url of links) {
    // Parse date from URL (YYYYMMDD anywhere in the path)
    const dateM = url.match(/(\d{8})/);
    const date  = dateM ? `${dateM[1].slice(0,4)}-${dateM[1].slice(4,6)}-${dateM[1].slice(6,8)}` : null;

    const html = await getPageHTML(url, br);
    const tables = parseHTMLTables(html);

    // PrestoSports DataTables splits header + body into separate <table> elements.
    // We need to match them: collect all header tables with NP, then all body tables.
    // Simpler: find tables whose raw HTML contains NP and look for team context nearby.
    for (const { raw, rows, headers } of tables) {
      const colRow = headers.length ? headers : (rows[0]?.map(c => c.toLowerCase()) || []);
      const hasNP  = colRow.some(h => h === 'np') || raw.includes('>NP<') || raw.includes('>np<');
      if (!hasNP) continue;

      // Determine if this table belongs to Batavia — check caption, preceding heading,
      // or first 600 chars of raw HTML for team name context.
      const ctx = (
        raw.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i)?.[1] ||
        raw.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] ||
        raw.slice(0, 600)
      );
      const isBatavia = /batavia/i.test(stripTags(ctx));
      if (!isBatavia) continue;

      const hdrRow = colRow;
      const npIdx  = hdrRow.findIndex(h => h === 'np');
      const ipIdx  = hdrRow.findIndex(h => h === 'ip');
      if (npIdx < 0) continue;

      const dataRows = headers.length ? rows : rows.slice(1);
      for (const row of dataRows) {
        const rawName = row[0];
        if (!rawName || /^(pitchers?|totals?|name)$/i.test(rawName.trim())) continue;
        const name    = cleanName(rawName);
        const pitches = pi(row[npIdx]);
        const ip      = pf(row[ipIdx]) ?? 0;
        if (!name || name.length < 2 || !pitches || pitches <= 0) continue;

        // Only keep the most recent outing (highest date string)
        if (!pitchMap[name] || (date && (!pitchMap[name].date || date > pitchMap[name].date))) {
          pitchMap[name] = { date, pitches, ip };
          logScrape(`    ${name}: ${pitches} pitches on ${date} (${ip} IP) [from ${url.split('/').pop()}]`);
        }
      }
    }
  }

  if (!pg) return;
  // Clean up stale rows with uncleaned names (parens from W/L decisions)
  await pg.query(`DELETE FROM pitch_availability WHERE pitcher_name ~ '\\([WLS],?'`).catch(()=>{});
  let saved = 0;
  for (const [name, d] of Object.entries(pitchMap)) {
    await pg.query(
      // Only update if NOT a manual entry — coaches' manual logs take priority over scraped data
      `INSERT INTO pitch_availability(season,pitcher_name,team,last_outing_date,last_outing_pitches,last_outing_ip,is_manual,outing_type,notes)
       VALUES($1,$2,'Batavia Muckdogs',$3,$4,$5,FALSE,'Game','')
       ON CONFLICT(season,pitcher_name) DO UPDATE SET
         last_outing_date=$3,last_outing_pitches=$4,last_outing_ip=$5,updated_at=NOW()
         WHERE NOT pitch_availability.is_manual`,
      [season, name, d.date, d.pitches, d.ip]
    ).catch(() => {});
    saved++;
  }
  logScrape(`  ✓ ${saved} Batavia pitch records`);
}

// ─── 6. Schedule scraper ─────────────────────────────────────────────────────
// Parse a canusamuckdogs.com rendered HTML schedule page (AngularJS / BaseballShift)
function parseCanusaScheduleHTML(html) {
  const games = [];
  // BaseballShift renders schedule as a list; look for game data in rendered text
  // Each game block contains date, time, opponent, location, score
  const MONTH_MAP = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};

  // Strategy: extract all text blocks and find patterns
  // Remove script/style tags, collapse whitespace
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ');

  // Date patterns: "May 29" / "May 29, 2026" / "5/29" / "5/29/2026"
  // Opponent patterns: "vs. Elmira" / "@ Olean" / "at Olean"
  // Score patterns: "W 9-6" / "L 7-10" / "9-6 W"
  // Time patterns: "7:05 PM" / "7:05pm ET"

  // Split on date boundaries
  const dateRe = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(20\d{2}))?\b|\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/gi;
  const matches = [...clean.matchAll(dateRe)];

  for (let mi = 0; mi < matches.length; mi++) {
    const m = matches[mi];
    const mStart = m.index;
    const mEnd   = mi+1 < matches.length ? matches[mi+1].index : clean.length;
    const block  = clean.slice(mStart, Math.min(mEnd, mStart+300));

    // Parse date
    let gameDate = '';
    if (m[1]) { // "May 29"
      const mon = MONTH_MAP[(m[1].toLowerCase().slice(0,3))];
      const day = parseInt(m[2]);
      const yr  = m[3] ? parseInt(m[3]) : new Date().getFullYear();
      if (mon && day) gameDate = `${yr}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    } else if (m[4]) { // "5/29"
      const mon = parseInt(m[4]), day = parseInt(m[5]);
      let yr = m[6] ? parseInt(m[6]) : new Date().getFullYear();
      if (yr < 100) yr += 2000;
      if (mon && day) gameDate = `${yr}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
    if (!gameDate || gameDate < '2026-01-01') continue;

    // Opponent and home/away
    const oppM = block.match(/\b(?:vs\.?\s*|vs\s+|@\s*|at\s+)([A-Z][A-Za-z ]+(?:Muckdogs|Pioneers|Oilers|Skunks|Ironbacks|Americans|Red Wings|Doubledays|Pilots|Diesel|Falcons|Express|Storm|Monarchs|Thunder)[^\d,]*)/i);
    if (!oppM) continue;
    const rawOpp = oppM[0].trim();
    const isHome = !/^[@]|^at\s/i.test(rawOpp.replace(/^vs\.?\s*/i,'').trim()) && !/^@/.test(oppM[0]);
    const opp    = oppM[1].replace(/\s+/g,' ').trim().replace(/[,.]*$/, '');
    if (!opp || opp.toLowerCase().includes('batavia')) continue;

    // Time
    const timeM = block.match(/\b(\d{1,2}:\d{2}\s*[AP]M)\b/i);
    const gameTime = timeM ? timeM[1] : '';

    // Score/result
    let result='', bataviaScore=null, oppScore=null, status='scheduled';
    const wlM = block.match(/\b([WL])\s+(\d{1,2})\s*-\s*(\d{1,2})\b/i)
             || block.match(/\b(\d{1,2})\s*-\s*(\d{1,2})\s+([WL])\b/i);
    if (wlM) {
      if (/^[WL]$/i.test(wlM[1])) {
        result=wlM[1].toUpperCase(); bataviaScore=Number(wlM[2]); oppScore=Number(wlM[3]);
      } else {
        result=wlM[3].toUpperCase(); bataviaScore=Number(wlM[1]); oppScore=Number(wlM[2]);
      }
      status='final';
    }

    // Location
    const locM = block.match(/\b(Dwyer Stadium|[A-Z][A-Za-z ]+(?:Stadium|Field|Park|Complex))[^,]*/i);
    const location = locM ? locM[0].trim() : (isHome ? 'Dwyer Stadium, Batavia NY' : '');

    const gameId = `bat_${gameDate.replace(/-/g,'')}`;
    if (!games.find(g=>g.gameId===gameId)) {
      games.push({ gameId, gameDate, gameTime, isHome,
        homeTeam: isHome?'Batavia Muckdogs':opp, awayTeam: isHome?opp:'Batavia Muckdogs',
        location, bataviaScore, oppScore, result, status, boxScoreUrl: '' });
    }
  }
  return games;
}

async function scrapeSchedule(season, br) {
  logScrape('Scraping Batavia schedule...');
  let games = [];

  // ── Primary: canusamuckdogs.com with Puppeteer + XHR interception ────────────
  if (br) {
    let page = null;
    try {
      page = await br.newPage();
      await page.setUserAgent(UA);
      await page.setViewport({ width: 1280, height: 800 });

      let capturedJson = null;

      // Allow all requests (XHR needed for AngularJS); capture schedule API response
      await page.setRequestInterception(true);
      page.on('request', req => {
        const t = req.resourceType();
        if (['image','font','media'].includes(t)) req.abort();
        else req.continue();
      });
      page.on('response', async resp => {
        const url = resp.url();
        if (/digitalshift\.ca.*schedule|schedule.*digitalshift\.ca/i.test(url)) {
          try { const j = await resp.json(); if (j) capturedJson = j; } catch {}
        }
      });

      await page.goto('https://www.canusamuckdogs.com/schedule', { waitUntil: 'networkidle2', timeout: 35000 })
        .catch(() => page.goto('https://www.canusamuckdogs.com/schedule', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{}));
      // Extra wait for Angular to render
      await new Promise(r => setTimeout(r, 4000));

      // Try to parse XHR-captured JSON first
      if (capturedJson) {
        logScrape('  Captured digitalshift schedule API response');
        const arr = Array.isArray(capturedJson) ? capturedJson
          : (capturedJson.games || capturedJson.schedule || capturedJson.data || []);
        for (const g of arr) {
          // digitalshift fields: date_time (ISO), home_team {name}, visiting_team {name},
          // home_score, visiting_score, status ('F'=final, 'S'=scheduled)
          const dt = g.date_time || g.game_date || g.date || '';
          const rawDate = dt.slice(0,10); // YYYY-MM-DD
          if (!rawDate.match(/^\d{4}-\d{2}-\d{2}/) || rawDate < '2026-01-01') continue;
          const homeTeam = (g.home_team?.name || g.home_team || '').trim();
          const awayTeam = (g.visiting_team?.name || g.visiting_team || g.away_team?.name || g.away_team || '').trim();
          const isHome = /batavia/i.test(homeTeam);
          const opp = isHome ? awayTeam : homeTeam;
          if (!opp || /batavia/i.test(opp)) continue;
          const isFinal = /^F$/i.test(g.status) || g.status==='final' || (g.home_score!=null && g.visiting_score!=null && g.status!=='scheduled');
          const homeScore = g.home_score != null ? Number(g.home_score) : null;
          const visitScore = g.visiting_score != null ? Number(g.visiting_score) : null;
          const batScore = isHome ? homeScore : visitScore;
          const oppScore = isHome ? visitScore : homeScore;
          const result = isFinal && batScore!=null ? (batScore > oppScore ? 'W' : batScore < oppScore ? 'L' : '') : '';
          const gameTime = dt.length>10 ? new Date(dt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) : (g.time||'');
          const gameId = `bat_${rawDate.replace(/-/g,'')}`;
          if (!games.find(x=>x.gameId===gameId))
            games.push({ gameId, gameDate: rawDate, gameTime, isHome,
              homeTeam: isHome?'Batavia Muckdogs':opp, awayTeam: isHome?opp:'Batavia Muckdogs',
              location: isHome?'Dwyer Stadium, Batavia NY':'', bataviaScore: batScore,
              oppScore, result, status: isFinal?'final':'scheduled', boxScoreUrl:'' });
        }
      }

      // If XHR not captured, parse rendered DOM
      if (!games.length) {
        logScrape('  No XHR captured — parsing rendered DOM');
        const html = await page.content();
        games = parseCanusaScheduleHTML(html);
        logScrape(`  DOM parse: ${games.length} games`);
      }

      await page.close();
    } catch(e) {
      if (page) try { await page.close(); } catch {}
      logScrape('  canusamuckdogs Puppeteer error: ' + e.message);
    }
  }

  // ── Fallback: PrestoSports scraping if canusamuckdogs failed ─────────────────
  if (!games.length) {
    logScrape('  Falling back to PrestoSports schedule...');
    const urls = [
      `https://pgcbl.prestosports.com/sports/bsb/${season}/teams/bataviamuckdogs?view=schedule`,
      `https://pgcbl.com/sports/bsb/${season}/teams/bataviamuckdogs?view=schedule`,
      `https://pgcbl.com/sports/bsb/${season}/teams/bataviamuckdogs?view=sched`,
    ];
    let schedHTML = '';
    for (const url of urls) {
      try { schedHTML = await getPageHTML(url, br); if (schedHTML.length > 2000) break; } catch {}
    }

    const bsLinks = [];
    for (const m of (schedHTML||'').matchAll(/href="([^"]*\/boxscores\/[^"?#.]+)"/gi))
      bsLinks.push(m[1].startsWith('http')?m[1]:`https://pgcbl.com${m[1]}`);

    for (const { headers, rows } of parseHTMLTables(schedHTML)) {
      const hL = headers.map(h => h.toLowerCase());
      if (!hL.some(h => /date/i.test(h))) continue;
      const dIdx=hL.findIndex(h=>/date/i.test(h)), tIdx=hL.findIndex(h=>/time/i.test(h));
      const oIdx=hL.findIndex(h=>/opp/i.test(h)), rIdx=hL.findIndex(h=>/result|score|w\/l/i.test(h));
      const lIdx=hL.findIndex(h=>/loc|site/i.test(h));
      if (dIdx < 0) continue;
      rows.forEach((row,i) => {
        const dm=(row[dIdx]||'').match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
        if(!dm) return;
        const yr=dm[3].length===2?'20'+dm[3]:dm[3];
        const gameDate=`${yr}-${dm[1].padStart(2,'0')}-${dm[2].padStart(2,'0')}`;
        const rawOpp=oIdx>=0?(row[oIdx]||''):'';
        const isHome=!rawOpp.startsWith('@')&&!/\bat\s/i.test(rawOpp);
        const opp=rawOpp.replace(/[@*#]/g,'').replace(/^\s*at\s+/i,'').trim();
        const gameTime=tIdx>=0?(row[tIdx]||''):'';
        let result='',bataviaScore=null,oppScore=null,status='scheduled';
        const rawRes=rIdx>=0?(row[rIdx]||''):'';
        const rm=rawRes.match(/([WL])\D*(\d+)\D*-\D*(\d+)/i);
        if(rm){result=rm[1].toUpperCase();bataviaScore=Number(rm[2]);oppScore=Number(rm[3]);status='final';}
        else{const sm=rawRes.match(/(\d+)-(\d+)/);if(sm){bataviaScore=Number(sm[1]);oppScore=Number(sm[2]);status='final';}}
        const gameId=`bat_${gameDate.replace(/-/g,'')}`;
        if(!games.find(g=>g.gameId===gameId))
          games.push({gameId,gameDate,gameTime,isHome,
            homeTeam:isHome?'Batavia Muckdogs':opp, awayTeam:isHome?opp:'Batavia Muckdogs',
            location:lIdx>=0?(row[lIdx]||''):(isHome?'Dwyer Stadium, Batavia NY':''),
            bataviaScore,oppScore,result,status,boxScoreUrl:bsLinks[i]||''});
      });
      if (games.length) break;
    }
  }

  logScrape(`  Schedule source: ${games.length} games found`);
  if (!pg) return games;
  let saved=0;
  for (const g of games) {
    await pg.query(
      `INSERT INTO schedule(season,game_id,game_date,game_time,home_team,away_team,location,batavia_score,opp_score,result,is_home,status,box_score_url,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT(season,game_id) DO UPDATE SET
         game_date=$3,game_time=$4,home_team=$5,away_team=$6,location=$7,
         batavia_score=$8,opp_score=$9,result=$10,is_home=$11,status=$12,
         box_score_url=COALESCE(NULLIF($13,''),schedule.box_score_url),updated_at=NOW()`,
      [season,g.gameId,g.gameDate,g.gameTime,g.homeTeam,g.awayTeam,g.location,
       g.bataviaScore,g.oppScore,g.result,g.isHome,g.status,g.boxScoreUrl]
    ).catch(()=>{});
    saved++;
  }
  logScrape(`  ✓ ${saved} schedule games (${games.filter(g=>g.status==='final').length} final, ${games.filter(g=>g.status==='scheduled').length} upcoming)`);
  return games;
}

// ─── 7. Full box scores with pitcher lines ────────────────────────────────────
async function scrapeBoxScores(season, br) {
  logScrape('Scraping Batavia box scores (pitcher lines)...');
  if (!pg) return;

  const logHTML = await getPageHTML(
    `https://pgcbl.com/sports/bsb/${season}/teams/bataviamuckdogs?view=gamelog`, br
  );
  const linkSet = new Set();
  for (const m of logHTML.matchAll(/href="([^"]*\/boxscores\/[^"?#]+)"/gi)) {
    const p = m[1];
    if (p.includes('.xml')||p.includes('.json')) continue;
    linkSet.add(p.startsWith('http')?p:`https://pgcbl.com${p.startsWith('/')?p:'/'+p}`);
  }
  if (!linkSet.size) {
    for (const m of logHTML.matchAll(/\/boxscores\/(\d{8}[^"'\s<>.]+)/gi))
      linkSet.add(`https://pgcbl.com/sports/bsb/${season}/boxscores/${m[1]}`);
  }
  if (!linkSet.size) {
    for (const m of logHTML.matchAll(/boxscores\/([^"'\s<>]+\.xml)/g))
      linkSet.add(`https://pgcbl.com/sports/bsb/${season}/boxscores/${m[1].replace(/\.xml$/,'')}`);
  }

  const links = [...linkSet].slice(0, 30);
  logScrape(`  Found ${links.length} box score links`);
  let saved = 0;

  for (const url of links) {
    const dateM = url.match(/(\d{8})/);
    const date  = dateM ? `${dateM[1].slice(0,4)}-${dateM[1].slice(4,6)}-${dateM[1].slice(6,8)}` : null;
    const gameId = dateM ? `bat_${dateM[1]}` : `bat_${url.split('/').pop()}`;

    const html = await getPageHTML(url, br);
    const tables = parseHTMLTables(html);

    let bataviaScore=null, oppScore=null, oppTeam='';
    const innings=[]; const pitcherLines=[];

    // Linescore (inning-by-inning)
    for (const { headers, rows } of tables) {
      const colRow = headers.length?headers:(rows[0]||[]);
      const hasInnings = colRow.some(h=>/^[1-9]$/.test(String(h).trim()));
      if (!hasInnings) continue;
      const dataRows = headers.length?rows:rows.slice(1);
      for (const row of dataRows) {
        const teamName=(row[0]||'').trim();
        if(!teamName||/^team$/i.test(teamName)) continue;
        const rIdx=colRow.findIndex(h=>/^r$/i.test(String(h).trim()));
        const totalR=rIdx>=0?pi(row[rIdx]):null;
        if(/batavia/i.test(teamName)) bataviaScore=totalR;
        else { oppTeam=oppTeam||teamName; oppScore=totalR; }
        innings.push({team:teamName, runs:row.slice(1,rIdx>=0?rIdx:undefined).map(pi)});
      }
      break;
    }

    // Pitcher lines
    let curTeam='';
    for (const { raw, rows, headers } of tables) {
      const colRow=(headers.length?headers:(rows[0]||[])).map(h=>(h||'').toLowerCase().trim());
      if (!colRow.some(h=>h==='ip')) continue;
      const ctx=stripTags(raw.slice(0,600));
      if(/batavia/i.test(ctx)) curTeam='Batavia Muckdogs';
      else if(oppTeam) curTeam=oppTeam;
      const ipI=colRow.findIndex(h=>h==='ip'), hI=colRow.findIndex(h=>h==='h');
      const rI=colRow.findIndex(h=>h==='r'), erI=colRow.findIndex(h=>h==='er');
      const bbI=colRow.findIndex(h=>h==='bb'), kI=colRow.findIndex(h=>h==='so'||h==='k');
      const npI=colRow.findIndex(h=>h==='np'), bfI=colRow.findIndex(h=>h==='bf');
      if(ipI<0) continue;
      const dataRows=headers.length?rows:rows.slice(1);
      for (const row of dataRows) {
        const rawName=(row[0]||'').trim();
        if(!rawName||/^(pitchers?|totals?|name)$/i.test(rawName)) continue;
        const name=cleanName(rawName);
        if(!name||name.length<2) continue;
        const ip=pf(row[ipI])||0;
        if(!ip) continue;
        pitcherLines.push({team:curTeam,name,ip,h:pi(row[hI])||0,r:pi(row[rI])||0,er:pi(row[erI])||0,bb:pi(row[bbI])||0,k:pi(row[kI])||0,np:pi(row[npI])||0,bf:pi(row[bfI])||0});
      }
    }

    await pg.query(
      `INSERT INTO box_scores(season,game_id,home_team,away_team,home_score,away_score,game_date,status,innings,pitcher_lines,updated_at)
       VALUES($1,$2,'Batavia Muckdogs',$3,$4,$5,$6,'F',$7,$8,NOW())
       ON CONFLICT(season,game_id) DO UPDATE SET
         away_team=COALESCE(NULLIF($3,''),box_scores.away_team),
         home_score=COALESCE($4,box_scores.home_score),away_score=COALESCE($5,box_scores.away_score),
         game_date=COALESCE($6,box_scores.game_date),status='F',
         innings=CASE WHEN $7::jsonb='[]'::jsonb THEN box_scores.innings ELSE $7 END,
         pitcher_lines=CASE WHEN $8::jsonb='[]'::jsonb THEN box_scores.pitcher_lines ELSE $8 END,
         updated_at=NOW()`,
      [season,gameId,oppTeam||'Unknown',bataviaScore,oppScore,date||null,
       JSON.stringify(innings),JSON.stringify(pitcherLines)]
    ).catch(()=>{});
    const batPitchers=pitcherLines.filter(p=>/batavia/i.test(p.team));
    if(batPitchers.length) logScrape(`    ${gameId}: ${batPitchers.map(p=>`${p.name} ${p.np}p`).join(', ')}`);
    saved++;
  }
  logScrape(`  ✓ ${saved} box scores`);
}

// ─── 8. Game stats from HTML box scores ──────────────────────────────────────
// Scrapes ALL West Division games — every team's gamelog is checked every cron run.
// URLs: pgcbl.com/sports/bsb/SEASON/boxscores/GAMEID.xml  (served as full HTML via Puppeteer)
// Seed game IDs for Batavia — discovered dynamically from gamelogs every run too
const KNOWN_BOX_SCORES = [
  '20260529_6w3u','20260530_wfcc','20260531_6t25','20260603_umsj',
  '20260605_l32y','20260607_ys97','20260611_qdhj','20260613_aod0',
];

async function scrapeGameStats(season, br) {
  logScrape('Scraping West Division game stats — all teams...');
  if (!pg) return;

  // ── 1. Collect all unique box score game IDs from every team's gamelog ────
  const allGameIds = new Set(KNOWN_BOX_SCORES);
  for (const team of TEAMS) {
    const html = await getPageHTML(
      `https://pgcbl.com/sports/bsb/${season}/teams/${team.slug}?view=gamelog`, br
    ).catch(() => '');
    if (!html || html.length < 500) continue;
    let found = 0;
    for (const m of html.matchAll(/boxscores\/(\d{8}_\w+)(?:\.xml)?/gi))
      if (!allGameIds.has(m[1])) { allGameIds.add(m[1]); found++; }
    if (found) logScrape(`  ${team.name}: +${found} game IDs`);
  }
  logScrape(`  ${allGameIds.size} unique games across West Division`);

  // ── 2. Which games still need scraping? ───────────────────────────────────
  const { rows: existing } = await pg.query(
    `SELECT game_id,
       COALESCE(jsonb_array_length(home_batting), jsonb_array_length(batavia_batting), 0) as has_data
     FROM game_stats WHERE season=$1`, [season]
  ).catch(() => ({ rows: [] }));
  const scrapedSet = new Set(existing.filter(r => Number(r.has_data||0) > 0).map(r => r.game_id));
  const toScrape = [...allGameIds].filter(gid => !scrapedSet.has(gid));
  logScrape(`  ${toScrape.length}/${allGameIds.size} games need scraping`);

  const cI = (cols, ...names) => cols.findIndex(h => names.some(n => h === n));

  // Reuse a single browser session across all games — relaunching Chrome per-game
  // takes 15+ minutes for a full season and Railway kills long-running scrapes
  let gameBr = await getBrowser();
  let saved = 0;
  for (const gameId of toScrape) {
    const ds = gameId.slice(0, 8);
    const date = `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`;
    const htmlUrl = `https://pgcbl.com/sports/bsb/${season}/boxscores/${gameId}.xml`;
    logScrape(`  Scraping ${gameId} (${date})...`);
    try {
      // On crash, relaunch browser once and retry
      let html = await getPageHTML(htmlUrl, gameBr).catch(async () => {
        logScrape(`    Browser crashed — relaunching...`);
        await closeBrowser(); gameBr = await getBrowser();
        return getPageHTML(htmlUrl, gameBr).catch(() => '');
      });
      if (!html || html.length < 5000) {
        logScrape(`    Tiny/empty (${html?.length||0} chars) — skipping`);
        continue;
      }

      const tables = parseHTMLTables(html);
      let awayTeam = '', homeTeam = '', awayScore = null, homeScore = null;
      const innings = [];

      // ── Linescore — PrestoSports: visitor row first, home row second ──────
      for (const { headers, rows } of tables) {
        const colRow = headers.length ? headers : (rows[0]||[]);
        if (!colRow.some(h => /^[1-9]$/.test(String(h).trim())) &&
            !colRow.some(h => /^final$/i.test(String(h).trim()))) continue;
        const data = headers.length ? rows : rows.slice(1);
        let rowN = 0;
        for (const row of data) {
          const t = (row[0]||'').trim();
          if (!t || /^(team|r|h|e|final)$/i.test(t)) continue;
          const rI = colRow.findIndex(h => /^r$/i.test(String(h).trim()));
          const score = rI >= 0 ? pi(row[rI]) : null;
          innings.push({ team: t, score, runs: row.slice(1, rI>=0?rI:undefined).map(v=>pi(v)||0) });
          if (rowN === 0) { awayTeam = awayTeam || t; awayScore = awayScore ?? score; }
          else            { homeTeam = homeTeam || t; homeScore = homeScore ?? score; }
          rowN++;
        }
        if (innings.length) break;
      }

      // ── Batting tables (visitor first, home second) ───────────────────────
      const parseBat = (headers, rows) => {
        const col=(headers.length?headers:(rows[0]||[])).map(h=>(h||'').toLowerCase().trim());
        if (!col.some(h=>h==='ab')) return null;
        const abI=col.indexOf('ab'),rI=cI(col,'r'),hI=cI(col,'h'),rbiI=col.indexOf('rbi'),
              bbI=col.indexOf('bb'),soI=cI(col,'so','k'),hrI=col.indexOf('hr'),
              sfI=col.indexOf('sf'),hbpI=col.indexOf('hbp');
        const data=headers.length?rows:rows.slice(1),arr=[];
        for (const row of data) {
          const raw=(row[0]||'').trim();
          if (!raw||/^(totals?|name|batters?|player|hitters?)$/i.test(raw)) continue;
          const name=cleanName(raw); if(!name||name.length<2) continue;
          arr.push({name,ab:pi(row[abI])||0,r:rI>=0?pi(row[rI])||0:0,h:hI>=0?pi(row[hI])||0:0,
            rbi:rbiI>=0?pi(row[rbiI])||0:0,bb:bbI>=0?pi(row[bbI])||0:0,k:soI>=0?pi(row[soI])||0:0,
            hr:hrI>=0?pi(row[hrI])||0:0,sf:sfI>=0?pi(row[sfI])||0:0,hbp:hbpI>=0?pi(row[hbpI])||0:0});
        }
        return arr.length?arr:null;
      };
      const batTbls=tables.map(({headers,rows})=>parseBat(headers,rows)).filter(Boolean);
      const [awayBatting,homeBatting]=batTbls.length>=2?[batTbls[0],batTbls[1]]:batTbls.length===1?[batTbls[0],[]]:[[],[]];

      // ── Pitching tables (visitor first, home second) ──────────────────────
      const parsePit = (headers, rows) => {
        const col=(headers.length?headers:(rows[0]||[])).map(h=>(h||'').toLowerCase().trim());
        if (!col.some(h=>h==='ip')||!col.some(h=>h==='er'||h==='bb')) return null;
        const ipI=col.indexOf('ip'),hI=cI(col,'h'),rI=cI(col,'r'),erI=col.indexOf('er'),
              bbI=col.indexOf('bb'),soI=cI(col,'so','k'),npI=col.indexOf('np'),bfI=col.indexOf('bf');
        if (ipI<0) return null;
        const data=headers.length?rows:rows.slice(1),arr=[];
        for (const row of data) {
          const raw=(row[0]||'').trim();
          if (!raw||/^(totals?|name|pitchers?)$/i.test(raw)) continue;
          const name=cleanName(raw); if(!name||name.length<2) continue;
          const ip=pf(row[ipI])||0; if(!ip) continue;
          arr.push({name,ip,h:hI>=0?pi(row[hI])||0:0,r:rI>=0?pi(row[rI])||0:0,
            er:erI>=0?pi(row[erI])||0:0,bb:bbI>=0?pi(row[bbI])||0:0,k:soI>=0?pi(row[soI])||0:0,
            np:npI>=0?pi(row[npI])||0:0,bf:bfI>=0?pi(row[bfI])||0:0});
        }
        return arr.length?arr:null;
      };
      const pitTbls=tables.map(({headers,rows})=>parsePit(headers,rows)).filter(Boolean);
      const [awayPitching,homePitching]=pitTbls.length>=2?[pitTbls[0],pitTbls[1]]:pitTbls.length===1?[pitTbls[0],[]]:[[],[]];

      // ── Batavia-specific aliases for backward compat ──────────────────────
      const batIsHome=/batavia/i.test(homeTeam), batIsAway=/batavia/i.test(awayTeam);
      const batavia_batting =batIsHome?homeBatting :batIsAway?awayBatting :[];
      const batavia_pitching=batIsHome?homePitching:batIsAway?awayPitching:[];
      const opp_batting     =batIsHome?awayBatting :batIsAway?homeBatting :[];
      const opp_pitching    =batIsHome?awayPitching:batIsAway?homePitching:[];
      const opponent        =batIsHome?awayTeam:batIsAway?homeTeam:(awayTeam||'');
      const bataviaScore    =batIsHome?homeScore:batIsAway?awayScore:null;
      const oppScore        =batIsHome?awayScore:batIsAway?homeScore:null;

      await pg.query(
        `INSERT INTO game_stats(
           season,game_id,game_date,
           home_team,away_team,home_score,away_score,
           home_batting,away_batting,home_pitching,away_pitching,
           opponent,is_home,batavia_score,opp_score,result,
           innings,batavia_batting,batavia_pitching,opp_batting,opp_pitching,
           wp,lp,box_score_url,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'',$16,$17,$18,$19,$20,'','','',NOW())
         ON CONFLICT(season,game_id) DO UPDATE SET
           game_date=$3,home_team=$4,away_team=$5,home_score=$6,away_score=$7,
           home_batting=$8,away_batting=$9,home_pitching=$10,away_pitching=$11,
           opponent=$12,is_home=$13,batavia_score=$14,opp_score=$15,
           innings=$16,batavia_batting=$17,batavia_pitching=$18,
           opp_batting=$19,opp_pitching=$20,updated_at=NOW()`,
        [season,gameId,date,homeTeam||'',awayTeam||'',homeScore,awayScore,
         JSON.stringify(homeBatting),JSON.stringify(awayBatting),
         JSON.stringify(homePitching),JSON.stringify(awayPitching),
         opponent,batIsHome,bataviaScore,oppScore,
         JSON.stringify(innings),
         JSON.stringify(batavia_batting),JSON.stringify(batavia_pitching),
         JSON.stringify(opp_batting),JSON.stringify(opp_pitching)]
      ).catch(e=>logScrape(`    DB error: ${e.message}`));

      // ── Update pitch_availability for Batavia pitchers ────────────────────
      for (const p of batavia_pitching) {
        if (!p.name||!p.np) continue;
        await pg.query(
          `INSERT INTO pitch_availability(season,pitcher_name,team,last_outing_date,last_outing_pitches,last_outing_ip,is_manual,outing_type,notes)
           VALUES($1,$2,'Batavia Muckdogs',$3,$4,$5,FALSE,'Game','')
           ON CONFLICT(season,pitcher_name) DO UPDATE SET
             last_outing_date=GREATEST(pitch_availability.last_outing_date,$3::date),
             last_outing_pitches=CASE WHEN $3::date>=COALESCE(pitch_availability.last_outing_date,'1900-01-01') THEN $4 ELSE pitch_availability.last_outing_pitches END,
             last_outing_ip=CASE WHEN $3::date>=COALESCE(pitch_availability.last_outing_date,'1900-01-01') THEN $5 ELSE pitch_availability.last_outing_ip END,
             updated_at=NOW()
           WHERE NOT pitch_availability.is_manual`,
          [season,p.name,date,p.np,p.ip]
        ).catch(()=>{});
      }

      logScrape(`    ✓ ${gameId}: home=${homeTeam||'?'} (${homeBatting.length}bat,${homePitching.length}pit) away=${awayTeam||'?'} (${awayBatting.length}bat,${awayPitching.length}pit)`);
      saved++;
      await delay(1500, 3000); // brief pause between games to avoid rate-limiting
    } catch (e) {
      logScrape(`    Error ${gameId}: ${e.message}`);
    }
  }
  await closeBrowser();
  logScrape(`  ✓ ${saved}/${toScrape.length} games saved`);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  MANUAL ROSTER SEED — manually-collected data for teams not yet on PGCBL
// ═══════════════════════════════════════════════════════════════════════════════
const MANUAL_ROSTERS = {
  'Olean Oilers': [
    {name:'Aidan Willard',   number:'26', position:'OF'},
    {name:'Brian Fleming',   number:'22', position:'OF'},
    {name:'Grant Fournier',  number:'30', position:'OF'},
    {name:'Cooper Tarlie',   number:'34', position:'OF'},
    {name:'Darek Staudt',    number:'23', position:'INF'},
    {name:'Anthony Radice',  number:'25', position:'C'},
    {name:'Thomas Bates',    number:'20', position:'INF'},
    {name:'Conner Vercollone',number:'45',position:'OF'},
    {name:'Brady Smith',     number:'31', position:'C'},
    {name:'Jackson Custer',  number:'11', position:'INF'},
    {name:'Jayden Asencio',  number:'9',  position:'C'},
    {name:'Armanis Romero',  number:'2',  position:'INF'},
    {name:"Connor O'Mara",   number:'7',  position:'INF'},
    {name:'Aiden Cowburn',   number:'4',  position:'INF'},
    {name:'Matt Boffalo',    number:'5',  position:'INF'},
    {name:'Christo Hunsicker',number:'8', position:'OF'},
    {name:'Dana Williams',   number:'12', position:'INF'},
    {name:'Brayden Rader',   number:'3',  position:'INF'},
    {name:'Will Watson',     number:'15', position:'OF'},
    {name:'Jaxon Diamond',   number:'28', position:'INF'},
    {name:'Jack Painter',    number:'50', position:'INF'},
    {name:'Logan Koslin',    number:'24', position:'INF'},
  ],
  'Niagara Ironbacks': [
    {name:'Josh Bullock',    number:'22', position:'C'},
    {name:'Cooper Martin',   number:'18', position:'INF'},
    {name:'Kieran Cutler',   number:'23', position:'C'},
    {name:'London Prashad',  number:'40', position:'OF'},
    {name:'Michael Gregus',  number:'3',  position:'OF'},
    {name:'Anderson Fenwick',number:'14', position:'C'},
    {name:'Bryce Bedrosian', number:'38', position:'INF'},
    {name:'Peyton Panozzo',  number:'1',  position:'INF'},
    {name:'Kaleb Locatelli', number:'8',  position:'OF'},
    {name:'Jordan Gallo',    number:'12', position:'OF'},
    {name:'Connor Gaitens',  number:'11', position:'C'},
    {name:'Josh Bushen',     number:'10', position:'OF'},
    {name:'Franklin Griffin',number:'0',  position:'OF'},
    {name:'Chase Hubbel',    number:'9',  position:'OF'},
    {name:'Devan Madore',    number:'4',  position:'INF'},
  ],
  'Elmira Pioneers': [
    {name:'Brett Baker',     number:'10', position:'OF'},
    {name:'Ryan Jones',      number:'44', position:'C'},
    {name:'Thomas Cheplick', number:'36', position:'RHP'},
    {name:'Alex Davis',      number:'5',  position:'INF'},
    {name:'Tyler Adamo',     number:'15', position:'UTL'},
    {name:'Michael Ferranti',number:'11', position:'OF'},
    {name:'Ryan Gabianelli', number:'16', position:'INF'},
    {name:'Michael Gardner', number:'1',  position:'INF'},
    {name:'Ryan Kristof',    number:'88', position:'INF'},
    {name:'Tysan Gingerich', number:'37', position:'OF'},
    {name:'Manoel Essley',   number:'7',  position:'UTL'},
    {name:'Jack Tubman',     number:'25', position:'INF'},
    {name:'Jalyn Tidwell',   number:'22', position:'INF'},
    {name:'Aubrey Peterson', number:'99', position:'INF'},
    {name:'Bradon Doubek',   number:'3',  position:'INF'},
  ],
  'Geneva Red Wings': [
    {name:'Grant Ingram',       number:'15', position:'UTL'},
    {name:'John Mendola',       number:'28', position:'INF'},
    {name:'Austin Deitz',       number:'10', position:'INF'},
    {name:'Noah Company',       number:'17', position:'OF'},
    {name:'Kenta Minakata',     number:'12', position:'OF'},
    {name:'Quinn Mahoney',      number:'16', position:'OF'},
    {name:'Christopher Gonzalo',number:'1',  position:'INF'},
    {name:'JC Gamble',          number:'29', position:'OF'},
    {name:'Nick Filipponi',     number:'37', position:'C'},
    {name:'Dillan Abbate',      number:'26', position:'INF'},
    {name:'Kaden Coutts',       number:'19', position:'C'},
    {name:'Dylan Briggs',       number:'3',  position:'OF'},
    {name:'Aiden Quintero',     number:'25', position:'INF'},
    {name:'Jadon Wanat',        number:'32', position:'OF'},
    {name:'Michael Ucci',       number:'34', position:'INF'},
  ],
  'Auburn Doubledays': [
    // Hitters
    {name:'Dustin Werthem',     number:'33', position:'UTL'},
    {name:'Brendan Smith',      number:'30', position:'UTL'},
    {name:'Teddy Monahan',      number:'20', position:'OF'},
    {name:'Collin Haug',        number:'21', position:'OF'},
    {name:'Chase Moore',        number:'15', position:'INF'},
    {name:'Nacho Gonzales',     number:'3',  position:'UTL'},
    {name:'Justin Batts',       number:'32', position:'INF'},
    {name:'Bert Maxim',         number:'25', position:'OF'},
    {name:'Zack Sperger',       number:'16', position:'UTL'},
    {name:'Brayden Michaelson', number:'22', position:'UTL'},
    {name:'Jonathan Griggs',    number:'23', position:'C'},
    {name:'William Ragland III',number:'4',  position:'INF'},
    {name:'Jake Bentivenga',    number:'27', position:'C'},
    {name:'Riley Ames',         number:'37', position:'INF'},
    // Pitchers
    {name:'Sam McKay',          number:'38', position:'RHP'},
    {name:'Tristan Rocha',      number:'94', position:'RHP'},
    {name:'Joseph Williams',    number:'8',  position:'RHP'},
    {name:'Matthew Chofay',     number:'17', position:'RHP'},
    {name:'Ryan Pettograsso',   number:'18', position:'RHP'},
    {name:'Will Seiler',        number:'36', position:'RHP'},
    {name:'Jacob Morrell',      number:'11', position:'RHP'},
    {name:'Ryan Roco',          number:'28', position:'RHP'},
    {name:'William Baker III',  number:'14', position:'RHP'},
    {name:'James Hauptfleisch', number:'12', position:'RHP'},
  ],
  'Niagara Falls Americans': [
    // Hitters
    {name:'Christian Mikulski', number:'7',  position:'INF'},
    {name:'Evan Shank',         number:'10', position:'UTL'},
    {name:'Yadiel Santos',      number:'25', position:'OF'},
    {name:'Jager Nailor',       number:'4',  position:'INF'},
    {name:'Justin Gladfelter',  number:'27', position:'UTL'},
    {name:'Matthew Ganschow',   number:'15', position:'OF'},
    {name:'Ryan Stalony',       number:'21', position:'OF'},
    {name:'Ryotaro Munakata',   number:'33', position:'UTL'},
    {name:'Derek Gesmondi',     number:'13', position:'OF'},
    {name:'Dominick Zangardi',  number:'3',  position:'OF'},
    {name:'Thomas Marcotte',    number:'19', position:'INF'},
    {name:'Anthony Savino',     number:'22', position:'INF'},
    {name:'Adam Weiss',         number:'26', position:'INF'},
    {name:'Loagan Stickler',    number:'17', position:'UTL'},
    {name:'David Harris',       number:'18', position:'INF'},
    // Pitchers (deduped — Santos & Ganschow already above)
    {name:'Jase Burdon',        number:'81', position:'RHP'},
    {name:'Colin Price',        number:'11', position:'RHP'},
    {name:'Vincent Favata',     number:'23', position:'RHP'},
    {name:'Jackson Learner',    number:'8',  position:'RHP'},
    {name:'Porter Slattery',    number:'41', position:'LHP'},
    {name:'Marcus Castellon',   number:'28', position:'RHP'},
    {name:'Mitchell Canuel',    number:'2',  position:'RHP'},
    {name:'Angel Nova-Lopez',   number:'42', position:'RHP'},
  ],
  'Batavia Muckdogs': [
    {name:'Logan Thomas', number:'44', position:'RHP'},
  ],
  'Newark Pilots': [
    // Hitters
    {name:'Myles Castillo',               number:'16', position:''},
    {name:'Michael DeRosa',               number:'8',  position:''},
    {name:'Will Webster',                 number:'18', position:''},
    {name:'Jayden Pena',                  number:'22', position:''},
    {name:'Christopher Babkowski',        number:'12', position:''},
    {name:'Connor Wright',                number:'30', position:''},
    {name:'Jason Romance',                number:'31', position:''},
    {name:'Aiden Bolan',                  number:'15', position:''},
    {name:'Angel Xavier Gomez Osoria',    number:'14', position:''},
    {name:'Nikolas Nelson',               number:'9',  position:''},
    {name:'Aiden Davenport',              number:'20', position:''},
    {name:'Brolin Haley',                 number:'11', position:''},
    {name:'Kyle Takahashi',               number:'21', position:''},
    {name:'Jara Carlos',                  number:'10', position:''},
    {name:'Liam Wagner',                  number:'3',  position:''},
    {name:'Shane Santaga',                number:'94', position:''},
    // Pitchers (deduped — Nelson, Wagner, Webster, Haley already above)
    {name:'Cam Harrison',                 number:'13', position:'RHP'},
    {name:'Lucas Orlovitz',               number:'97', position:'RHP'},
    {name:'Jackson Moore',                number:'17', position:'RHP'},
    {name:'Matthew Diottavio',            number:'28', position:'RHP'},
    {name:'Kyoungseo Min',                number:'7',  position:'RHP'},
    {name:'Liam Eshelman',                number:'93', position:'RHP'},
  ],
};

async function seedManualRosters() {
  if (!pg) return;
  const season = getSeason();
  let total = 0;
  let firstErr = null;
  for (const [team, players] of Object.entries(MANUAL_ROSTERS)) {
    let inserted = 0;
    for (const p of players) {
      try {
        await pg.query(
          `INSERT INTO rosters(season,team,player_name,number,position,player_year,hometown)
           VALUES($1,$2,$3,$4,$5,'','')
           ON CONFLICT(season,team,player_name) DO UPDATE SET
             number=EXCLUDED.number,
             position=EXCLUDED.position,
             updated_at=NOW()`,
          [season, team, p.name, p.number, p.position]
        );
        inserted++;
      } catch (e) {
        if (!firstErr) firstErr = e.message;
        logScrape(`[seed] ERROR inserting ${p.name} (${team}): ${e.message}`);
      }
    }
    logScrape(`[seed] ${team}: ${inserted}/${players.length} players seeded`);
    total += inserted;
  }
  if (firstErr) logScrape(`[seed] First error was: ${firstErr}`);
  logScrape(`[seed] Manual roster seed complete — ${total} total`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FULL SCRAPE ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════
async function countBataviaGames(season) {
  if (!pg) return 0;
  try {
    const { rows } = await pg.query(
      `SELECT COUNT(*) AS c FROM game_stats WHERE season=$1 AND (home_team='Batavia Muckdogs' OR away_team='Batavia Muckdogs')`,
      [season]
    );
    return parseInt(rows[0]?.c || 0);
  } catch { return 0; }
}

async function writeScrapeLog(trigger, gamesBefore, gamesAfter, success, error) {
  if (!pg) return;
  const newGames = Math.max(0, gamesAfter - gamesBefore);
  await pg.query(
    `INSERT INTO scrape_log(ts,trigger,games_before,games_after,new_games,success,error) VALUES(NOW(),$1,$2,$3,$4,$5,$6)`,
    [trigger, gamesBefore, gamesAfter, newGames, success, error || '']
  ).catch(() => {});
  logScrape(`── Health: ${newGames} new game(s) written (${gamesBefore}→${gamesAfter}) | trigger=${trigger} | success=${success}${error ? ' | err='+error : ''}`);
}

const SCRAPE_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes — if exceeded, scrape is killed and isScraping reset

async function runFullScrape(trigger = 'cron') {
  if (isScraping) { logScrape('Scrape already running — skipped'); return; }
  isScraping = true;
  scrapeStartedAt = Date.now();
  logScrape(`═══ Starting full scrape [${trigger}] ═══`);
  const season = getSeason();
  let br = null;
  const gamesBefore = await countBataviaGames(season);

  // Hard timeout: if scrape takes longer than SCRAPE_TIMEOUT_MS, force-reset isScraping
  const timeoutHandle = setTimeout(() => {
    logScrape(`[timeout] Scrape exceeded ${SCRAPE_TIMEOUT_MS/60000}min — force-resetting isScraping`);
    isScraping = false;
    scrapeStartedAt = null;
    closeBrowser().catch(() => {});
  }, SCRAPE_TIMEOUT_MS);

  try {
    br = await getBrowser(); // may be null if Puppeteer unavailable

    // ── Critical stats — if these fail, the whole scrape fails ──────────────
    await scrapeStandings(season, br);
    await scrapeHitters(season, br);
    await scrapePitchers(season, br);

    // Critical data is in DB — mark lastScrape NOW so Dewey/dawgdata see fresh data
    // even if the secondary scrapes below are slow or partially fail
    await setMetaValue('last_scrape', new Date().toISOString());
    await setMetaValue('last_scrape_error', '');
    logScrape('─── Critical stats saved — lastScrape updated ───');

    // ── Secondary scrapes — failures are logged but don't abort the run ─────
    await scrapeRosters(season, br).catch(e => logScrape('Roster scrape error (non-fatal): ' + e.message));
    await scrapePitchCounts(season, br).catch(e => logScrape('Pitch count scrape error (non-fatal): ' + e.message));
    await scrapeSchedule(season, br).catch(e => logScrape('Schedule scrape error (non-fatal): ' + e.message));
    await scrapeBoxScores(season, br).catch(e => logScrape('Box score scrape error (non-fatal): ' + e.message));
    await scrapeGameStats(season, br).catch(e => logScrape('Game stats scrape error (non-fatal): ' + e.message));

    const gamesAfter = await countBataviaGames(season);
    await writeScrapeLog(trigger, gamesBefore, gamesAfter, true, '');
    logScrape('═══ Scrape complete ═══');
  } catch (e) {
    logScrape('═══ Scrape failed: ' + e.message + ' ═══');
    await setMetaValue('last_scrape_error', e.message).catch(() => {});
    const gamesAfter = await countBataviaGames(season);
    await writeScrapeLog(trigger, gamesBefore, gamesAfter, false, e.message);
  } finally {
    clearTimeout(timeoutHandle);
    await closeBrowser();
    isScraping = false;
    scrapeStartedAt = null;
  }
}

// ─── Scrape every 3 hours — Railway may sleep between runs so 6am-only is unreliable ──
cron.schedule('0 */3 * * *', () => {
  logScrape('3h cron triggered');
  runFullScrape('cron').catch(e => logScrape('Cron error: ' + e.message));
}, { timezone: 'America/New_York' });

// ─── Self-ping every 5 minutes to keep the Railway process alive ─────────────
const SELF_PORT = process.env.PORT || 8080;
const SELF_URL  = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/health`
  : `http://localhost:${SELF_PORT}/api/health`;
let selfPingFailures = 0;
setInterval(async () => {
  try {
    await fetch(SELF_URL, { signal: AbortSignal.timeout(10000) });
    selfPingFailures = 0;
  } catch (e) {
    selfPingFailures++;
    if (selfPingFailures >= 3) logScrape(`[keep-alive] WARNING: ${selfPingFailures} consecutive self-ping failures — ${e.message}`);
  }
}, 5 * 60 * 1000);

// ─── Watchdog: detect stuck scrapes and auto-retry if data is stale ───────────
setInterval(async () => {
  // If scrape has been running longer than the hard timeout, it's stuck — force-reset
  if (isScraping && scrapeStartedAt && (Date.now() - scrapeStartedAt) > SCRAPE_TIMEOUT_MS) {
    logScrape(`[watchdog] Scrape stuck for ${((Date.now()-scrapeStartedAt)/60000).toFixed(1)}min — force-resetting isScraping`);
    isScraping = false;
    scrapeStartedAt = null;
    closeBrowser().catch(() => {});
  }

  if (isScraping) return; // genuinely in progress — leave it alone

  try {
    const last = await getMetaValue('last_scrape');
    if (!last) return;
    const ageHours = (Date.now() - new Date(last).getTime()) / 3600000;
    if (ageHours > 6) {
      logScrape(`[watchdog] Last scrape ${ageHours.toFixed(1)}h ago — triggering auto-retry`);
      runFullScrape('watchdog').catch(e => logScrape('[watchdog] Auto-retry error: ' + e.message));
    }
  } catch (e) {
    logScrape('[watchdog] Error: ' + e.message);
  }
}, 30 * 60 * 1000); // check every 30 minutes

// ═══════════════════════════════════════════════════════════════════════════════
//  DB → API ASSEMBLER
// ═══════════════════════════════════════════════════════════════════════════════
// Compute pitcher stats live from raw game_stats box score data with correct baseball IP math
async function computeLiveStats(season) {
  if (!pg) return { pitchers: [], leagueAvg: null };

  const { rows: games } = await pg.query(
    `SELECT game_date, home_team, away_team, home_pitching, away_pitching
     FROM game_stats WHERE season=$1 AND game_date IS NOT NULL ORDER BY game_date ASC`,
    [season]
  ).catch(() => ({ rows: [] }));

  const pitcherMap = {}; // key: normalizedName|team

  for (const g of games) {
    const sides = [
      { arr: g.home_pitching || [], teamName: g.home_team || '' },
      { arr: g.away_pitching || [], teamName: g.away_team || '' },
    ];
    for (const { arr, teamName } of sides) {
      for (const p of arr) {
        if (!p.name || !p.ip) continue;
        // Normalize name: trim, collapse spaces, apply known alias table
        const normName = canonicalizePitcherName(String(p.name));
        const key = `${normName.toLowerCase()}|${teamName}`;
        if (!pitcherMap[key]) {
          pitcherMap[key] = { name: normName, team: teamName, games: 0, outs: 0, h: 0, er: 0, bb: 0, k: 0, np: 0 };
        }
        const pm = pitcherMap[key];
        pm.games++;
        pm.outs += ipToOuts(parseFloat(p.ip) || 0);
        pm.h    += parseInt(p.h)  || 0;
        pm.er   += parseInt(p.er) || 0;
        pm.bb   += parseInt(p.bb) || 0;
        pm.k    += parseInt(p.k)  || 0;
        pm.np   += parseInt(p.np) || 0;
      }
    }
  }

  const pitchers = Object.values(pitcherMap).map(p => {
    const realIp = outsToRealInnings(p.outs);
    return {
      name:  p.name,
      team:  p.team,
      games: p.games,
      ip:    parseFloat(outsToIpStr(p.outs)),
      h:     p.h,
      er:    p.er,
      bb:    p.bb,
      k:     p.k,
      np:    p.np,
      era:   realIp > 0 ? parseFloat(((p.er / realIp) * 9).toFixed(2)) : 0,
      whip:  realIp > 0 ? parseFloat(((p.bb + p.h) / realIp).toFixed(3)) : 0,
      k9:    realIp > 0 ? parseFloat(((p.k  / realIp) * 9).toFixed(2))  : 0,
    };
  }).filter(p => p.ip >= 0.1);

  pitchers.sort((a, b) => a.era - b.era);

  // Compute league-wide averages from all pitchers with at least 1 IP
  const qualifiers = pitchers.filter(p => p.ip >= 1);
  const totalOuts = qualifiers.reduce((s, p) => s + ipToOuts(p.ip), 0);
  const totalRealIp = outsToRealInnings(totalOuts);
  const totalEr = qualifiers.reduce((s, p) => s + p.er, 0);
  const totalBb = qualifiers.reduce((s, p) => s + p.bb, 0);
  const totalH  = qualifiers.reduce((s, p) => s + p.h, 0);
  const totalK  = qualifiers.reduce((s, p) => s + p.k, 0);

  const leagueAvg = totalRealIp > 0 ? {
    era:  parseFloat(((totalEr / totalRealIp) * 9).toFixed(2)),
    whip: parseFloat(((totalBb + totalH) / totalRealIp).toFixed(3)),
    k9:   parseFloat(((totalK  / totalRealIp) * 9).toFixed(2)),
  } : null;

  return { pitchers, leagueAvg };
}

async function assembleStats() {
  if (!pg) return null;
  const season = getSeason();

  const [standR, hitR, pitR, pavR, rostR, lastScrape, scrapeErr, liveStats] = await Promise.all([
    pg.query('SELECT * FROM standings  WHERE season=$1 ORDER BY rank', [season]),
    pg.query('SELECT * FROM hitter_stats  WHERE season=$1 AND ab >= 1 ORDER BY avg DESC', [season]),
    pg.query('SELECT * FROM pitcher_stats WHERE season=$1 AND ip >= 0.1 ORDER BY era ASC', [season]),
    pg.query("SELECT * FROM pitch_availability WHERE season=$1 AND team='Batavia Muckdogs'", [season]),
    pg.query('SELECT team, player_name, number, position, player_year FROM rosters WHERE season=$1 ORDER BY team, CAST(NULLIF(regexp_replace(number,\'[^0-9]\',\'\',\'g\'),\'\') AS INTEGER) NULLS LAST, player_name', [season]),
    getMetaValue('last_scrape'),
    getMetaValue('last_scrape_error'),
    computeLiveStats(season),
  ]);

  // Build roster number lookup: { team: { lastName: number } }
  const rosterNums = {};
  for (const r of rostR.rows) {
    if (!r.number) continue;
    if (!rosterNums[r.team]) rosterNums[r.team] = {};
    const lastName = r.player_name.split(' ').slice(-1)[0].toLowerCase();
    rosterNums[r.team][lastName] = r.number;
    rosterNums[r.team][r.player_name.toLowerCase()] = r.number; // full name fallback
  }
  const getNum = (name, team) => {
    const m = rosterNums[team];
    if (!m) return '';
    const lastName = name.split(' ').slice(-1)[0].toLowerCase();
    return m[name.toLowerCase()] || m[lastName] || '';
  };

  const hitters = hitR.rows.map(r => ({
    name: r.name, team: r.team, gp: r.gp, ab: +r.ab, h: r.h,
    avg: +r.avg, obp: +r.obp, slg: +r.slg, ops: +r.ops,
    hr: r.hr, rbi: r.rbi, bb: r.bb, k: r.k,
    doubles: r.doubles, triples: r.triples,
    number: getNum(r.name, r.team),
  }));

  // Build a live-data lookup for Batavia pitchers keyed by normalized name
  const batLiveMap = {};
  for (const p of liveStats.pitchers) {
    if (/batavia/i.test(p.team)) {
      batLiveMap[p.name.toLowerCase()] = p;
      batLiveMap[canonicalizePitcherName(p.name).toLowerCase()] = p;
    }
  }

  // Deduplicate pitcher_stats rows for Batavia — aliases (e.g. "E Woodly" + "E Woodley") become one entry
  const seenBataviaNames = new Set();
  const deduped = pitR.rows.filter(r => {
    if (!/batavia/i.test(r.team)) return true;
    const canonical = canonicalizePitcherName(r.name).toLowerCase();
    if (seenBataviaNames.has(canonical)) return false;
    seenBataviaNames.add(canonical);
    return true;
  });

  const pitchers = deduped.map(r => {
    // For Batavia pitchers, prefer live-computed stats from game_stats (correct IP math, no cache)
    const live = /batavia/i.test(r.team)
      ? (batLiveMap[r.name.toLowerCase()] || batLiveMap[canonicalizePitcherName(r.name).toLowerCase()])
      : null;
    const base = live || r;
    const ip   = live ? live.ip   : +r.ip;
    const era  = live ? live.era  : +r.era;
    const whip = live ? live.whip : +r.whip;
    const k9   = live ? live.k9   : +r.k9;
    const realIp = live ? outsToRealInnings(ipToOuts(ip)) : (+r.ip);
    return {
      name: r.name, team: r.team, gp: live ? live.games : r.app,
      ip, era, whip, k9,
      k: live ? live.k : r.k, bb: live ? live.bb : r.bb,
      h: live ? live.h : r.h, w: r.w, sv: r.sv,
      bb9: realIp > 0 ? parseFloat(((live ? live.bb : r.bb) / realIp * 9).toFixed(2)) : 0,
      number: getNum(r.name, r.team),
      isLive: !!live,
    };
  });

  // Pitch counts from DB (most recent outing per Batavia pitcher)
  const pitchCounts = {};
  for (const row of pavR.rows) {
    if (row.last_outing_pitches > 0) {
      pitchCounts[row.pitcher_name] = [{
        date:       row.last_outing_date?.toISOString?.().slice(0,10) || null,
        pitches:    row.last_outing_pitches,
        ip:         +row.last_outing_ip,
        isManual:   row.is_manual || false,
        outingType: row.outing_type || 'Game',
        notes:      row.notes || '',
      }];
    }
  }

  // Attach pitch history to Batavia pitchers
  pitchers.forEach(p => {
    if (p.team === 'Batavia Muckdogs' && pitchCounts[p.name]) {
      p.pitchHistory = pitchCounts[p.name];
    }
  });

  const updatedAt    = lastScrape ? new Date(lastScrape).toISOString() : new Date().toISOString();
  const staleHours   = lastScrape ? (Date.now() - new Date(lastScrape).getTime()) / 3600000 : 999;

  // Full rosters grouped by team — used for Teams tab display
  const rosters = {};
  for (const r of rostR.rows) {
    if (!rosters[r.team]) rosters[r.team] = [];
    rosters[r.team].push({
      name: r.player_name,
      number: r.number || '',
      position: r.position || '',
      year: r.player_year || '',
    });
  }

  return {
    hitters,
    pitchers,
    standings: standR.rows.map(r => ({
      name: r.name, w: r.w, l: r.l, t: r.t, pct: +r.pct,
      gb: r.gb, streak: r.streak, last10: r.last10,
    })),
    rosters,
    pitchCounts,
    season,
    laEra:      liveStats.leagueAvg?.era  ?? null,
    laWhip:     liveStats.leagueAvg?.whip ?? 1.37,
    laK9:       liveStats.leagueAvg?.k9   ?? 8.21,
    leagueAvg:  liveStats.leagueAvg,
    bataviaPitchersLive: liveStats.pitchers.filter(p => /batavia/i.test(p.team)),
    updatedAt,
    isStale:    staleHours > 24,
    lastScrapeError: scrapeErr || null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── Spotify Client Credentials token proxy ───────────────────────────
// Returns a short-lived access token.  NOTE: Client Credentials scope does
// NOT include user-playback endpoints (user-modify-playback-state).
// Token is cached server-side and refreshed automatically before expiry.
let _spotifyTokenCache = null;
app.get('/api/spotify-token', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const SPOTIFY_CLIENT_ID     = 'ae037f5460dd4a598d62351336d4be99';
  const SPOTIFY_CLIENT_SECRET = 'e94b05de12504f1781a21a3799218325';
  try {
    // Serve cached token if still valid (>30s remaining)
    if (_spotifyTokenCache && Date.now() < _spotifyTokenCache.expiresAt - 30000) {
      return res.json({ access_token: _spotifyTokenCache.token, from_cache: true });
    }
    const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    const d = await r.json();
    if (!d.access_token) return res.status(502).json({ error: d.error_description || 'Spotify token error' });
    _spotifyTokenCache = { token: d.access_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000 };
    res.json({ access_token: d.access_token, expires_in: d.expires_in });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const lastScrape = await getMetaValue('last_scrape');
  const lastError  = await getMetaValue('last_scrape_error');
  const staleHours = lastScrape ? (Date.now() - new Date(lastScrape).getTime()) / 3600000 : 999;
  const scrapeRunningMins = isScraping && scrapeStartedAt ? parseFloat(((Date.now()-scrapeStartedAt)/60000).toFixed(1)) : null;
  res.json({
    status:  'PGCBL Stats Server v3 — Puppeteer + PostgreSQL',
    season:  getSeason(),
    db:      !!pg,
    isScraping,
    scrapeRunningMins,
    lastScrape,
    lastScrapeError: lastError || null,
    puppeteer: puppeteerAvailable,
    isStale: staleHours > 6,
    staleHours: parseFloat(staleHours.toFixed(1)),
  });
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await assembleStats();
    if (stats) return res.json(stats);
    res.status(503).json({ error: 'Database unavailable', hitters: [], pitchers: [], standings: [], pitchCounts: {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  if (isScraping) return res.json({ success: false, message: 'Scrape already in progress', isScraping: true });
  setImmediate(() => runFullScrape('manual').catch(e => logScrape('Manual refresh error: ' + e.message)));
  res.json({ success: true, message: 'Scrape started — check /api/health for status' });
});

app.post('/api/scrape-game-stats', async (req, res) => {
  res.json({ success: true, message: 'Game stats scrape started' });
  setImmediate(async () => {
    let br = null;
    try { br = await getBrowser(); await scrapeGameStats(getSeason(), br); }
    catch(e) { logScrape('Game stats scrape error: ' + e.message); }
    finally { await closeBrowser(); }
  });
});

app.post('/api/seed-rosters', async (req, res) => {
  try {
    await seedManualRosters();
    res.json({ success: true, message: 'Manual roster seed complete' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/api/scrape-log', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const textLog = scrapeLog.slice(-100);
  if (!pg) return res.json({ log: textLog, history: [] });
  try {
    const { rows } = await pg.query(
      `SELECT id, ts, trigger, games_before, games_after, new_games, success, error FROM scrape_log ORDER BY ts DESC LIMIT 50`
    );
    res.json({ log: textLog, history: rows });
  } catch (e) {
    res.json({ log: textLog, history: [], error: e.message });
  }
});

// Rosters endpoint
app.get('/api/rosters', async (req, res) => {
  if (!pg) return res.json({});
  const season = getSeason();
  try {
    const { rows } = await pg.query('SELECT * FROM rosters WHERE season=$1 ORDER BY team, player_name', [season]);
    const result = {};
    rows.forEach(r => {
      if (!result[r.team]) result[r.team] = [];
      result[r.team].push({ name: r.player_name, number: r.number, position: r.position, year: r.player_year, hometown: r.hometown });
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Pitch charting ───────────────────────────────────────────────────────────
app.post('/api/charting-sessions', async (req, res) => {
  if (!pg) return res.status(503).json({ error: 'DB unavailable' });
  const season = getSeason();
  let { gameId = null, date, opponent = '', homeAway = '', type = 'game' } = req.body;
  try {
    if (gameId) {
      const sched = await pg.query('SELECT * FROM schedule WHERE season=$1 AND game_id=$2', [season, gameId]);
      if (sched.rows[0]) {
        const s = sched.rows[0];
        date     = s.game_date?.toISOString?.().slice(0,10) || date;
        opponent = s.is_home ? s.away_team : s.home_team;
        homeAway = s.is_home ? 'home' : 'away';
      }
      const existing = await pg.query('SELECT id FROM charting_sessions WHERE season=$1 AND game_id=$2', [season, gameId]);
      if (existing.rows[0]) return res.json({ id: existing.rows[0].id });
    } else {
      const existing = await pg.query(
        'SELECT id FROM charting_sessions WHERE season=$1 AND game_date=$2 AND opponent=$3 AND session_type=$4 AND game_id IS NULL',
        [season, date, opponent, type]
      );
      if (existing.rows[0]) return res.json({ id: existing.rows[0].id });
    }
    const { rows } = await pg.query(
      `INSERT INTO charting_sessions(season, game_id, game_date, opponent, home_away, session_type)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [season, gameId, date, opponent, homeAway, type]
    );
    res.json({ id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/charting-sessions', async (req, res) => {
  if (!pg) return res.json([]);
  const season = req.query.season || getSeason();
  try {
    const { rows } = await pg.query(
      'SELECT * FROM charting_sessions WHERE season=$1 ORDER BY created_at DESC LIMIT 20',
      [season]
    );
    res.json(rows.map(r => ({
      id: r.id, gameId: r.game_id, date: r.game_date?.toISOString?.().slice(0,10) || null,
      opponent: r.opponent, homeAway: r.home_away, type: r.session_type,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/charting-sessions/:id/pitches', async (req, res) => {
  if (!pg) return res.json({ session: null, pitches: [] });
  const id = req.params.id;
  try {
    const sessRes = await pg.query('SELECT * FROM charting_sessions WHERE id=$1', [id]);
    if (!sessRes.rows[0]) return res.status(404).json({ error: 'Session not found' });
    const s = sessRes.rows[0];
    const { rows } = await pg.query('SELECT * FROM pitches WHERE session_id=$1 ORDER BY ts ASC', [id]);
    res.json({
      session: {
        id: s.id, gameId: s.game_id, date: s.game_date?.toISOString?.().slice(0,10) || null,
        opponent: s.opponent, homeAway: s.home_away, type: s.session_type,
      },
      pitches: rows.map(r => ({
        id: r.id, pitcherName: r.pitcher_name, pitcherTeam: r.pitcher_team,
        batterName: r.batter_name, batterTeam: r.batter_team,
        inning: r.inning, half: r.half, balls: r.balls, strikes: r.strikes, outs: r.outs,
        pitchType: r.pitch_type, velo: r.velo != null ? Number(r.velo) : null,
        zoneX: r.zone_x != null ? Number(r.zone_x) : null, zoneY: r.zone_y != null ? Number(r.zone_y) : null,
        result: r.result, battedBallType: r.batted_ball_type, inPlayOutcome: r.in_play_outcome,
        sprayX: r.spray_x != null ? Number(r.spray_x) : null, sprayY: r.spray_y != null ? Number(r.spray_y) : null,
        ts: r.ts,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/repertoire/:team/:name', async (req, res) => {
  if (!pg) return res.json({ pitchTypes: ['FB','SI','CH','CB','SL','CT'] });
  const team = decodeURIComponent(req.params.team), name = decodeURIComponent(req.params.name);
  const season = req.query.season || getSeason();
  try {
    const { rows } = await pg.query(
      'SELECT pitch_types FROM pitcher_repertoire WHERE season=$1 AND team=$2 AND player_name=$3',
      [season, team, name]
    );
    res.json({ pitchTypes: rows[0]?.pitch_types || ['FB','SI','CH','CB','SL','CT'] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/repertoire/:team/:name', async (req, res) => {
  if (!pg) return res.json({ success: true, storage: 'none' });
  const team = decodeURIComponent(req.params.team), name = decodeURIComponent(req.params.name);
  const season = req.query.season || getSeason();
  const { pitchTypes = [] } = req.body;
  try {
    await pg.query(
      `INSERT INTO pitcher_repertoire(season,team,player_name,pitch_types,updated_at)
       VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT(season,team,player_name) DO UPDATE SET pitch_types=$4, updated_at=NOW()`,
      [season, team, name, JSON.stringify(pitchTypes)]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pitches', async (req, res) => {
  if (!pg) return res.status(503).json({ error: 'DB unavailable' });
  const { pitches = [] } = req.body;
  if (!Array.isArray(pitches) || !pitches.length) return res.json({ inserted: 0, skipped: 0 });
  let inserted = 0, skipped = 0;
  try {
    for (const p of pitches) {
      const { rowCount } = await pg.query(
        `INSERT INTO pitches(
           client_id, session_id, season, pitcher_name, pitcher_team, batter_name, batter_team,
           inning, half, balls, strikes, outs, pitch_type, velo, zone_x, zone_y,
           result, batted_ball_type, in_play_outcome, spray_x, spray_y, ts
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (client_id) DO NOTHING`,
        [
          p.clientId, p.sessionId || null, p.season || getSeason(), p.pitcherName, p.pitcherTeam,
          p.batterName, p.batterTeam, p.inning || null, p.half || null, p.balls ?? null,
          p.strikes ?? null, p.outs ?? null, p.pitchType || null, p.velo || null,
          p.zoneX ?? null, p.zoneY ?? null, p.result, p.battedBallType || null, p.inPlayOutcome || null,
          p.sprayX ?? null, p.sprayY ?? null, p.ts || new Date().toISOString(),
        ]
      );
      if (rowCount) inserted++; else skipped++;
    }
    res.json({ inserted, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/players/:team/:name/pitch-data', async (req, res) => {
  if (!pg) return res.json({});
  const team = decodeURIComponent(req.params.team), name = decodeURIComponent(req.params.name);
  const season = req.query.season || getSeason();
  try {
    const { rows } = await pg.query(
      `SELECT pitch_type, velo, balls, strikes, result, zone_x, zone_y, ts
       FROM pitches WHERE season=$1 AND pitcher_team=$2 AND pitcher_name=$3`,
      [season, team, name]
    );
    const total = rows.length;
    const byType = {};
    for (const r of rows) {
      const t = r.pitch_type || 'UNK';
      if (!byType[t]) byType[t] = { count: 0, veloSum: 0, veloN: 0 };
      byType[t].count++;
      if (r.velo != null) { byType[t].veloSum += Number(r.velo); byType[t].veloN++; }
    }
    const usage = Object.entries(byType).map(([type, v]) => ({
      pitchType: type, count: v.count, usagePct: total ? +(v.count / total * 100).toFixed(1) : 0,
      avgVelo: v.veloN ? +(v.veloSum / v.veloN).toFixed(1) : null,
    }));

    const trendMap = {};
    for (const r of rows) {
      if (r.velo == null) continue;
      const day = new Date(r.ts).toISOString().slice(0,10);
      const key = day + '|' + (r.pitch_type || 'UNK');
      if (!trendMap[key]) trendMap[key] = { date: day, pitchType: r.pitch_type || 'UNK', sum: 0, n: 0 };
      trendMap[key].sum += Number(r.velo); trendMap[key].n++;
    }
    const veloTrend = Object.values(trendMap).map(v => ({ date: v.date, pitchType: v.pitchType, avgVelo: +(v.sum/v.n).toFixed(1) })).sort((a,b)=>a.date.localeCompare(b.date));

    const firstPitch = rows.filter(r => r.balls === 0 && r.strikes === 0);
    const fpStrikes = firstPitch.filter(r => r.result !== 'ball');
    const firstPitchStrikePct = firstPitch.length ? +(fpStrikes.length / firstPitch.length * 100).toFixed(1) : null;

    const putAwayRows = rows.filter(r => r.strikes === 2 && (r.result === 'swinging_strike' || r.result === 'called_strike'));
    const putAwayByType = {};
    for (const r of putAwayRows) { const t = r.pitch_type || 'UNK'; putAwayByType[t] = (putAwayByType[t]||0) + 1; }
    const putAway = Object.entries(putAwayByType)
      .map(([type, count]) => ({ pitchType: type, count, pct: putAwayRows.length ? +(count/putAwayRows.length*100).toFixed(1) : 0 }))
      .sort((a,b) => b.count - a.count);

    const zoneGrid = {};
    for (const r of rows) {
      if (r.zone_x == null || r.zone_y == null) continue;
      const gx = Math.min(2, Math.max(0, Math.floor(Number(r.zone_x) * 3)));
      const gy = Math.min(2, Math.max(0, Math.floor(Number(r.zone_y) * 3)));
      const key = gx + ',' + gy;
      zoneGrid[key] = (zoneGrid[key]||0) + 1;
    }
    const zoneHeatmap = Object.entries(zoneGrid).map(([k,count]) => { const [gx,gy]=k.split(',').map(Number); return { gx, gy, count }; });

    res.json({ totalPitches: total, usage, veloTrend, firstPitchStrikePct, putAway, zoneHeatmap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/players/:team/:name/spray-chart', async (req, res) => {
  if (!pg) return res.json({});
  const team = decodeURIComponent(req.params.team), name = decodeURIComponent(req.params.name);
  const season = req.query.season || getSeason();
  try {
    const { rows } = await pg.query(
      `SELECT pitch_type, result, batted_ball_type, spray_x, spray_y, balls, strikes
       FROM pitches WHERE season=$1 AND batter_team=$2 AND batter_name=$3`,
      [season, team, name]
    );
    const battedBalls = rows
      .filter(r => r.result === 'in_play' && r.spray_x != null && r.spray_y != null)
      .map(r => ({ sprayX: Number(r.spray_x), sprayY: Number(r.spray_y), battedBallType: r.batted_ball_type, pitchType: r.pitch_type }));

    const seenByType = {}, whiffByType = {};
    for (const r of rows) {
      const t = r.pitch_type || 'UNK';
      seenByType[t] = (seenByType[t]||0) + 1;
      if (r.result === 'swinging_strike') whiffByType[t] = (whiffByType[t]||0) + 1;
    }
    const whiffRate = Object.entries(seenByType).map(([type, seen]) => ({
      pitchType: type, seen, whiffs: whiffByType[type]||0,
      whiffPct: seen ? +((whiffByType[type]||0)/seen*100).toFixed(1) : 0,
    }));

    const countMap = {};
    for (const r of rows) {
      const key = `${r.balls ?? '?'}-${r.strikes ?? '?'}|${r.pitch_type||'UNK'}|${r.result}`;
      countMap[key] = (countMap[key]||0) + 1;
    }
    const tendencies = Object.entries(countMap).map(([k,count]) => {
      const [count_, pitchType, result] = k.split('|');
      const [balls, strikes] = count_.split('-');
      return { balls, strikes, pitchType, result, count };
    });

    res.json({ battedBalls, whiffRate, tendencies });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/matchup/:pitcherTeam/:pitcherName/:batterTeam/:batterName', async (req, res) => {
  if (!pg) return res.json([]);
  const pitcherTeam = decodeURIComponent(req.params.pitcherTeam), pitcherName = decodeURIComponent(req.params.pitcherName);
  const batterTeam  = decodeURIComponent(req.params.batterTeam),  batterName  = decodeURIComponent(req.params.batterName);
  const season = req.query.season || getSeason();
  try {
    const { rows } = await pg.query(
      `SELECT p.*, cs.game_date, cs.opponent
       FROM pitches p LEFT JOIN charting_sessions cs ON cs.id = p.session_id
       WHERE p.season=$1 AND p.pitcher_team=$2 AND p.pitcher_name=$3 AND p.batter_team=$4 AND p.batter_name=$5
       ORDER BY p.ts ASC`,
      [season, pitcherTeam, pitcherName, batterTeam, batterName]
    );
    res.json(rows.map(r => ({
      id: r.id, sessionId: r.session_id, gameDate: r.game_date?.toISOString?.().slice(0,10) || null, opponent: r.opponent,
      inning: r.inning, half: r.half, balls: r.balls, strikes: r.strikes, outs: r.outs,
      pitchType: r.pitch_type, velo: r.velo != null ? Number(r.velo) : null,
      zoneX: r.zone_x != null ? Number(r.zone_x) : null, zoneY: r.zone_y != null ? Number(r.zone_y) : null,
      result: r.result, battedBallType: r.batted_ball_type,
      sprayX: r.spray_x != null ? Number(r.spray_x) : null, sprayY: r.spray_y != null ? Number(r.spray_y) : null,
      ts: r.ts,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Scouting ─────────────────────────────────────────────────────────────────
app.get('/api/scouting', async (req, res) => {
  if (!pg) return res.json({});
  try {
    const { rows } = await pg.query('SELECT player_key,player_name,team,uploads,analysis,is_hot FROM scouting');
    const result = {};
    rows.forEach(r => { result[r.player_key] = { uploads: r.uploads, analysis: r.analysis, hot: r.is_hot }; });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scouting/:key', async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const { playerName, team, uploads=[], analysis='', hot=false } = req.body;
  if (!pg) return res.json({ success: true, storage: 'none' });
  try {
    await pg.query(
      `INSERT INTO scouting(player_key,player_name,team,uploads,analysis,is_hot,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT(player_key) DO UPDATE SET
         player_name=$2,team=$3,uploads=$4,analysis=$5,is_hot=$6,updated_at=NOW()`,
      [key, playerName, team, JSON.stringify(uploads), analysis, hot]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Manual pitch logs ────────────────────────────────────────────────────────
app.get('/api/pitches', async (req, res) => {
  if (!pg) return res.json({});
  try {
    const { rows } = await pg.query("SELECT pitcher_name,team,outings FROM pitch_avail WHERE team='Batavia Muckdogs'");
    const result = {};
    rows.forEach(r => { result[r.pitcher_name] = { name: r.pitcher_name, team: r.team, outings: r.outings }; });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pitches/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { team='Batavia Muckdogs', outings=[] } = req.body;
  if (!pg) return res.json({ success: true, storage: 'none' });
  try {
    await pg.query(
      `INSERT INTO pitch_avail(pitcher_name,team,outings,updated_at)
       VALUES($1,$2,$3,NOW())
       ON CONFLICT(pitcher_name) DO UPDATE SET team=$2,outings=$3,updated_at=NOW()`,
      [name, team, JSON.stringify(outings)]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Game sheets ──────────────────────────────────────────────────────────────
app.get('/api/sheets', async (req, res) => {
  if (!pg) return res.json([]);
  try {
    const { rows } = await pg.query(
      `SELECT sheet_id AS id, opponent, game_date AS date, photos, batters, created_at AS "createdAt"
       FROM game_sheets ORDER BY game_date DESC`
    );
    res.json(rows.map(r => ({ ...r, date: r.date?.toISOString?.().slice(0,10)||r.date })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sheets', async (req, res) => {
  const { id, opponent, date, photos=[], batters=[], createdAt } = req.body;
  if (!id || !opponent || !date) return res.status(400).json({ error: 'id, opponent, date required' });
  if (!pg) return res.json({ success: true, storage: 'none' });
  try {
    await pg.query(
      `INSERT INTO game_sheets(sheet_id,opponent,game_date,photos,batters,created_at)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(sheet_id) DO UPDATE SET opponent=$2,game_date=$3,photos=$4,batters=$5`,
      [id, opponent, date, JSON.stringify(photos), JSON.stringify(batters), createdAt||new Date()]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI chart parser ──────────────────────────────────────────────────────────
app.post('/api/parse-chart', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No AI key', pitchers:[], bullpen:[], notes:'' });
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'image required' });
  try {
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 512,
        messages: [{ role: 'user', content: [
          { type:'image', source:{ type:'base64', media_type:mediaType, data:base64 } },
          { type:'text', text:`Baseball pitching chart. Extract pitchers and pitch counts. Return ONLY JSON:
{"pitchers":[{"name":"LastName","pitches":72}],"bullpen":[{"name":"LastName","pitches":18}],"notes":""}
Rules: last name only, integer pitch count. Skip unreadable rows.` }
        ]}]
      }),
      signal: AbortSignal.timeout(22000),
    });
    const d    = await r.json();
    const text = d.content?.[0]?.text || '{}';
    const obj  = JSON.parse((text.match(/\{[\s\S]*\}/)||['{}'])[0]);
    res.json({ pitchers: obj.pitchers||[], bullpen: obj.bullpen||[], notes: obj.notes||'' });
  } catch (e) {
    console.error('parse-chart:', e.message);
    res.json({ pitchers:[], bullpen:[], notes:'' });
  }
});

app.post('/api/parse-sheet', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No AI key', batters:[] });
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'image required' });
  try {
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
        messages: [{ role: 'user', content: [
          { type:'image', source:{ type:'base64', media_type:mediaType, data:base64 } },
          { type:'text', text:'Baseball scouting sheet. Extract batter rows. Return ONLY JSON array: [{"name":"Last, First","notes":"plan","result":"what happened"}]. Return [] if unreadable. No other text.' }
        ]}]
      }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json();
    const text = data.content?.[0]?.text || '[]';
    const batters = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0]||'[]');
    res.json({ batters });
  } catch (e) {
    console.error('parse-sheet:', e.message);
    res.json({ batters:[] });
  }
});

// ─── Parse scouting report photo ─────────────────────────────────────────────
app.post('/api/parse-scouting-report', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No AI key', rows: [] });
  const { image, opponent } = req.body;
  if (!image) return res.status(400).json({ error: 'image required' });
  try {
    const base64    = image.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

    // Build roster lookup for matching jersey numbers → player names
    let rosterMap = {}; // { number: player_name }
    if (pg && opponent) {
      const season = getSeason();
      const { rows } = await pg.query(
        'SELECT player_name, number FROM rosters WHERE team=$1 AND season=$2',
        [opponent, season]
      ).catch(() => ({ rows: [] }));
      rows.forEach(r => { if (r.number) rosterMap[r.number.toString().trim()] = r.player_name; });
    }

    const prompt = `You are reading a HANDWRITTEN baseball scouting report. The writing may be messy, rushed, abbreviated, or hard to read — that is completely normal and expected. Do your absolute best to interpret every row.

This sheet has one row per batter. For EVERY row you can find, extract:
- number: jersey number (usually a 1–2 digit number on the far left, digits only, e.g. "7", "23")
- handedness: "L" or "R" (look for L/R or a circled letter near the jersey number)
- shade_notes: describe any shading, pencil marks, or X marks on the LEFT diamond/spray chart (indicates where the batter tends to hit — e.g. "shaded pull side", "X up middle", "all fields shaded")
- plan_of_attack: transcribe ALL handwritten words/abbreviations in the middle notes column as literally as possible — even if unclear, write your best guess with a "?" for letters you can't make out. Common baseball abbreviations: FB=fastball, CB=curveball, SL=slider, CH=changeup, IN=inside, AW=away, UP=up, DN=down, GB=groundball, K=strikeout, BB=walk
- results: describe any marks on the RIGHT diamond and any outcome text (K, BB, 1B, 2B, HR, DP, etc.)
- success: true if you see a check mark ✓ or the word "yes" in the rightmost column, false if you see X or "no", null if blank

CRITICAL RULES:
1. NEVER return an empty array. If you can see ANY rows at all, return them.
2. If a field is truly illegible, use your best guess and add "(?)" — do NOT skip the row.
3. Partial information is always better than omitting a row entirely.
4. Jersey numbers are almost always visible even when notes are messy — find them.
5. Do not let imperfect handwriting stop you from extracting data.

Return ONLY a valid JSON array with no markdown fences, no explanation. Fields: number, handedness, shade_notes, plan_of_attack, results, success.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-5', max_tokens: 4096,
        system: 'You are an expert at reading handwritten baseball scouting reports. You always extract every row you can find, even when handwriting is messy, abbreviated, or partially illegible. You never give up on a row — partial data is always returned.',
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: prompt }
        ]}]
      }),
      signal: AbortSignal.timeout(45000),
    });
    const data = await r.json();
    if (data.error) console.error('Claude API error:', JSON.stringify(data.error));
    const text = data.content?.[0]?.text || '';
    console.log('Scout parse raw:', text.substring(0, 300));
    let parsed = [];
    try { parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || '[]'); } catch {}

    // Attempt roster match for each parsed row
    const rows = parsed.map(row => {
      const num = (row.number || '').toString().trim();
      const matched = rosterMap[num] || null;
      return { ...row, number: num, matched_player: matched, unmatched: !matched };
    });

    console.log(`Scout parse: ${rows.length} rows extracted`);
    res.json({ rows, rosterMap });
  } catch (e) {
    console.error('parse-scouting-report:', e.message);
    res.json({ rows: [], rosterMap: {} });
  }
});

// ─── Save confirmed scouting report ──────────────────────────────────────────
app.post('/api/game-scouting', async (req, res) => {
  const { opponent, game_date, rows } = req.body;
  if (!opponent || !game_date || !rows?.length) return res.status(400).json({ error: 'opponent, game_date, rows required' });
  if (!pg) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const season = getSeason();
    // Upsert each row — key on (season, opponent, game_date, jersey_number)
    for (const row of rows) {
      await pg.query(
        `INSERT INTO game_scouting_reports
           (season, opponent, game_date, jersey_number, player_name, handedness,
            shade_notes, plan_of_attack, results, success, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT DO NOTHING`,
        [season, opponent, game_date, row.number||'', row.player_name||row.matched_player||'',
         row.handedness||'', row.shade_notes||'', row.plan_of_attack||'',
         row.results||'', row.success===true]
      ).catch(() => {});
    }
    res.json({ success: true, saved: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Get scouting reports (by opponent or player) ────────────────────────────
app.get('/api/game-scouting', async (req, res) => {
  if (!pg) return res.json([]);
  try {
    const season   = getSeason();
    const opponent = req.query.opponent || null;
    const player   = req.query.player   || null;
    let q = 'SELECT * FROM game_scouting_reports WHERE season=$1';
    const params = [season];
    if (opponent) { q += ` AND opponent=$${params.length+1}`; params.push(opponent); }
    if (player)   { q += ` AND player_name ILIKE $${params.length+1}`; params.push(`%${player}%`); }
    q += ' ORDER BY game_date DESC, player_name';
    const { rows } = await pg.query(q, params);
    res.json(rows.map(r => ({
      id: r.id, opponent: r.opponent,
      date: r.game_date?.toISOString?.().slice(0,10) || null,
      number: r.jersey_number, player: r.player_name,
      handedness: r.handedness, shadeNotes: r.shade_notes,
      plan: r.plan_of_attack, results: r.results, success: r.success,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Parse Pitcher Tendency SWAT Chart via Claude Vision ─────────────────────
app.post('/api/parse-tendency-report', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No AI key', data: null });
  const { image, opponent } = req.body;
  if (!image) return res.status(400).json({ error: 'image required' });
  try {
    const base64    = image.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

    // Build roster lookup so we can auto-match pitcher number
    let rosterMap = {};
    if (pg && opponent) {
      const season = getSeason();
      const { rows } = await pg.query(
        'SELECT player_name, number FROM rosters WHERE team=$1 AND season=$2',
        [opponent, season]
      ).catch(() => ({ rows: [] }));
      rows.forEach(r => { if (r.number) rosterMap[r.number.toString().trim()] = r.player_name; });
    }

    const prompt = `You are reading a handwritten Pitcher/Catcher Tendency SWAT Chart used by a baseball team. The handwriting may be messy or abbreviated — do your absolute best to transcribe everything.

Extract ALL of the following fields. Return a single JSON object (not an array):

{
  "pitcher_name": "name written at top of chart",
  "pitcher_number": "jersey number (digits only)",
  "handedness": "R or L",
  "date": "date if visible, YYYY-MM-DD format or null",
  "runner_1b": {
    "delivery_tendencies": "checked or noted set positions (Set/1001/1002/1003/1004) and any tendency notes",
    "fb_time": "fastball delivery time if noted",
    "os_time": "offspeed delivery time if noted",
    "pick_descriptions": "all pick move descriptions written",
    "pick_counts": "pick tendencies by count (e.g. 0-0, 1-0, etc.)"
  },
  "runner_2b": {
    "looks": "number of looks to 2B",
    "delivery_times": "delivery times with runner at 2B",
    "picks": "pick types used — timing, inside turn, daylight — with any notes"
  },
  "pre_pitch": "all checked or noted items in the Pre-Pitch Movements section (ball in hand, glove position, elbow, breathing, posture, foot width, knee height, tempo, delivery rhythm — transcribe everything checked or written)",
  "set_position": "all checked or noted items in Set Position Tendencies (glove height/angle, foot width, posture, breathing, looks/head rhythm, elbows, pitch grips — transcribe everything)",
  "first_moves": "all checked or noted items in First Moves to Trigger the Pitch (body lean, chin up, breathing, front shoulder, glove/hands — transcribe everything)",
  "notes": "full text of the Notes section at the bottom verbatim"
}

RULES:
- Never return null for a section — use empty string "" if truly blank
- Transcribe handwriting as literally as possible; use (?) for illegible letters
- Common abbreviations: FB=fastball, OS=offspeed, CH=changeup, SL=slider, CB=curveball, LF=left foot, RF=right foot, GL=glove, BH=ball hand
- Return ONLY valid JSON, no markdown fences, no explanation`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-5', max_tokens: 2048,
        system: 'You are an expert at reading handwritten baseball scouting documents. You extract every detail precisely, never skip sections, and always return valid JSON.',
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: prompt }
        ]}]
      }),
      signal: AbortSignal.timeout(45000),
    });
    const apiData = await r.json();
    if (apiData.error) console.error('Claude tendency error:', JSON.stringify(apiData.error));
    const text = apiData.content?.[0]?.text || '{}';
    console.log('Tendency parse raw:', text.substring(0, 400));
    let parsed = {};
    try { parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch {}

    // Auto-match pitcher by jersey number
    const num = (parsed.pitcher_number || '').toString().trim();
    const matched_name = rosterMap[num] || null;
    if (matched_name && !parsed.pitcher_name) parsed.pitcher_name = matched_name;

    console.log(`Tendency parse: ${parsed.pitcher_name||'unknown'} #${num}`);
    res.json({ data: parsed, rosterMap, matched_name });
  } catch (e) {
    console.error('parse-tendency-report:', e.message);
    res.json({ data: null, rosterMap: {} });
  }
});

// ─── Save Pitcher Tendency Report ────────────────────────────────────────────
app.post('/api/pitcher-tendency', async (req, res) => {
  const { opponent, game_date, data } = req.body;
  if (!opponent || !data) return res.status(400).json({ error: 'opponent and data required' });
  if (!pg) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const season = getSeason();
    await pg.query(
      `INSERT INTO pitcher_tendency_reports
         (season, opponent, game_date, pitcher_name, pitcher_number, handedness,
          runner_1b, runner_2b, pre_pitch, set_position, first_moves, notes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
      [season, opponent, game_date || null,
       data.pitcher_name || '', data.pitcher_number || '', data.handedness || '',
       JSON.stringify(data.runner_1b || {}), JSON.stringify(data.runner_2b || {}),
       data.pre_pitch || '', data.set_position || '', data.first_moves || '', data.notes || '']
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Get Pitcher Tendency Reports ────────────────────────────────────────────
app.get('/api/pitcher-tendency', async (req, res) => {
  if (!pg) return res.json([]);
  try {
    const season   = getSeason();
    const pitcher  = req.query.pitcher  || null;
    const opponent = req.query.opponent || null;
    let q = 'SELECT * FROM pitcher_tendency_reports WHERE season=$1';
    const params = [season];
    if (pitcher)  { q += ` AND pitcher_name ILIKE $${params.length+1}`; params.push(`%${pitcher}%`); }
    if (opponent) { q += ` AND opponent=$${params.length+1}`; params.push(opponent); }
    q += ' ORDER BY game_date DESC NULLS LAST, created_at DESC';
    const { rows } = await pg.query(q, params);
    res.json(rows.map(r => ({
      id: r.id, opponent: r.opponent,
      date: r.game_date?.toISOString?.().slice(0,10) || null,
      pitcherName: r.pitcher_name, number: r.pitcher_number, handedness: r.handedness,
      runner1b: r.runner_1b, runner2b: r.runner_2b,
      prePitch: r.pre_pitch, setPosition: r.set_position,
      firstMoves: r.first_moves, notes: r.notes,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Combined scouting endpoint (for Dewey) ──────────────────────────────────
// Returns all batter scouting reports + pitcher tendency reports for this season
app.get('/api/scouting-data', async (req, res) => {
  if (!pg) return res.json({ batters: [], pitchers: [] });
  try {
    const season = getSeason();

    // Batter scouting reports
    const { rows: batterRows } = await pg.query(
      `SELECT * FROM game_scouting_reports WHERE season=$1 ORDER BY game_date DESC, player_name`,
      [season]
    ).catch(() => ({ rows: [] }));

    // Pitcher tendency reports
    const { rows: pitcherRows } = await pg.query(
      `SELECT * FROM pitcher_tendency_reports WHERE season=$1 ORDER BY game_date DESC NULLS LAST, pitcher_name`,
      [season]
    ).catch(() => ({ rows: [] }));

    const batters = batterRows.map(r => ({
      type: 'batter_scout',
      opponent: r.opponent,
      date: r.game_date?.toISOString?.().slice(0,10) || null,
      jerseyNumber: r.jersey_number,
      playerName: r.player_name,
      handedness: r.handedness,
      shadeNotes: r.shade_notes,
      planOfAttack: r.plan_of_attack,
      results: r.results,
      success: r.success,          // true = approach worked, false = reassess, null = unknown
    }));

    const pitchers = pitcherRows.map(r => ({
      type: 'pitcher_tendency',
      opponent: r.opponent,
      date: r.game_date?.toISOString?.().slice(0,10) || null,
      pitcherName: r.pitcher_name,
      jerseyNumber: r.pitcher_number,
      handedness: r.handedness,
      runner1b: r.runner_1b,       // JSONB: delivery_tendencies, fb_time, os_time, pick_desc, pick_counts
      runner2b: r.runner_2b,       // JSONB: looks, delivery_times, picks
      prePitch: r.pre_pitch,
      setPosition: r.set_position,
      firstMoves: r.first_moves,
      notes: r.notes,
    }));

    res.json({ batters, pitchers });
  } catch (e) {
    console.error('/api/scouting-data error:', e.message);
    res.status(500).json({ error: e.message, batters: [], pitchers: [] });
  }
});

// ─── Game stats endpoint ──────────────────────────────────────────────────────
// Debug: inspect raw table structure from a box score page
app.get('/api/debug-boxscore', async (req, res) => {
  const gameId = req.query.gameId || '20260529_6w3u';
  const season = getSeason();
  const htmlUrl = req.query.url || `https://pgcbl.com/sports/bsb/${season}/boxscores/${gameId}`;
  let br = null;
  try {
    br = await getBrowser();
    // Fetch gamelog to see what links it contains
    const logHTML = await getPageHTML(`https://pgcbl.com/sports/bsb/${season}/teams/bataviamuckdogs?view=gamelog`, br);
    const logLinks = [];
    for (const m of logHTML.matchAll(/href="([^"]*boxscores[^"]+)"/gi)) logLinks.push(m[1]);

    // Fetch the target page
    const html = await getPageHTML(htmlUrl, br, 5000);
    const tables = parseHTMLTables(html);
    const info = tables.map((t, i) => ({
      idx: i,
      headers: t.headers.slice(0, 15),
      firstDataRow: t.rows[0]?.slice(0, 10),
      rowCount: t.rows.length,
      rawStart: stripTags(t.raw.slice(0, 300)),
    }));
    // Also check raw HTML for table tags
    const tableTagCount = (html.match(/<table/gi) || []).length;
    const abCount = (html.match(/\bAB\b/g) || []).length;
    const ipCount = (html.match(/\bIP\b/g) || []).length;
    const titleM = html.match(/<title[^>]*>(.*?)<\/title>/i);
    res.json({ url: htmlUrl, htmlLen: html.length, tableCount: tables.length, tableTagCount, abCount, ipCount, title: titleM?.[1] || '', tables: info, logLinks: logLinks.slice(0, 20) });
  } catch (e) {
    res.json({ error: e.message });
  } finally {
    await closeBrowser();
  }
});

app.get('/api/game-stats', async (req, res) => {
  if (!pg) return res.json([]);
  try {
    const season   = getSeason();
    const gameId   = req.query.gameId   || null;
    const opponent = req.query.opponent || null;
    const player   = req.query.player   || null;
    const date     = req.query.date     || null;  // YYYY-MM-DD exact match
    const team     = req.query.team     || null;  // home or away team name (partial)
    const limit    = Math.min(parseInt(req.query.limit)||20, 200);
    let q = 'SELECT * FROM game_stats WHERE season=$1';
    const params = [season];
    if (gameId)   { q += ` AND game_id=$${params.length+1}`;                                                          params.push(gameId); }
    if (opponent) { q += ` AND opponent ILIKE $${params.length+1}`;                                                   params.push(`%${opponent}%`); }
    if (date)     { q += ` AND game_date::date=$${params.length+1}`;                                                  params.push(date); }
    if (team)     { q += ` AND (home_team ILIKE $${params.length+1} OR away_team ILIKE $${params.length+1})`; params.push(`%${team}%`); }
    q += ' ORDER BY game_date DESC NULLS LAST LIMIT $' + (params.length+1);
    params.push(limit);
    const { rows } = await pg.query(q, params);

    let results = rows.map(r => {
      // Fall back to old batavia/opp columns for games scraped before generic schema
      const homeBat   = r.home_batting?.length   ? r.home_batting   : (r.is_home ? (r.batavia_batting||[]) : (r.opp_batting||[]));
      const awayBat   = r.away_batting?.length   ? r.away_batting   : (r.is_home ? (r.opp_batting||[])    : (r.batavia_batting||[]));
      const homePitch = r.home_pitching?.length  ? r.home_pitching  : (r.is_home ? (r.batavia_pitching||[]) : (r.opp_pitching||[]));
      const awayPitch = r.away_pitching?.length  ? r.away_pitching  : (r.is_home ? (r.opp_pitching||[])   : (r.batavia_pitching||[]));
      return {
        gameId:          r.game_id,
        date:            r.game_date?.toISOString?.().slice(0,10) || null,
        homeTeam:        r.home_team  || '',
        awayTeam:        r.away_team  || '',
        homeScore:       r.home_score,
        awayScore:       r.away_score,
        opponent:        r.opponent   || '',
        isHome:          r.is_home,
        bataviaScore:    r.batavia_score,
        oppScore:        r.opp_score,
        result:          r.result     || '',
        innings:         r.innings    || [],
        homeBatting:     homeBat,
        homePitching:    homePitch,
        awayBatting:     awayBat,
        awayPitching:    awayPitch,
        bataviaBatting:  r.batavia_batting  || [],
        bataviaPitching: r.batavia_pitching || [],
        oppBatting:      r.opp_batting      || [],
        oppPitching:     r.opp_pitching     || [],
        wp:              r.wp || '',
        lp:              r.lp || '',
      };
    });

    // Filter by player name if requested
    if (player) {
      const pl = player.toLowerCase();
      results = results.map(g => {
        const allBat   = [...(g.homeBatting||[]),...(g.awayBatting||[])];
        const allPitch = [...(g.homePitching||[]),...(g.awayPitching||[])];
        const batLine  = allBat.find(p=>p.name?.toLowerCase().includes(pl));
        const pitchLine= allPitch.find(p=>p.name?.toLowerCase().includes(pl));
        if (!batLine && !pitchLine) return null;
        return { ...g, playerBatting: batLine||null, playerPitching: pitchLine||null };
      }).filter(Boolean);
    }

    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Cross-team statistical query endpoint ────────────────────────────────────
// Supports: player stats, team stats, leaderboards, ERA, AVG, K, pitch counts
// Params: player, team, type (batter|pitcher), lastN, dateFrom, dateTo, stat, limit
app.get('/api/query-stats', async (req, res) => {
  if (!pg) return res.json({ error: 'DB unavailable' });
  try {
    const season  = getSeason();
    const player  = req.query.player  || null;
    const team    = req.query.team    || null;
    const type    = (req.query.type   || '').toLowerCase(); // 'batter' | 'pitcher' | ''
    const lastN   = parseInt(req.query.lastN)  || 0;
    const limit   = Math.min(parseInt(req.query.limit)||50, 200);
    let dateFrom  = req.query.dateFrom || null;
    let dateTo    = req.query.dateTo   || null;
    const stat    = (req.query.stat   || '').toLowerCase(); // 'era','avg','k','hr','rbi','np','ip',...

    // lastN = last N games for Batavia (or specified team); dateFrom overrides
    if (lastN > 0 && !dateFrom) {
      const { rows: recentDates } = await pg.query(
        `SELECT DISTINCT game_date FROM game_stats WHERE season=$1 AND game_date IS NOT NULL
         ORDER BY game_date DESC LIMIT $2`, [season, lastN]
      );
      if (recentDates.length) dateFrom = recentDates[recentDates.length-1].game_date?.toISOString?.().slice(0,10);
    }

    // Build WHERE clause for date range
    const params = [season];
    let dateWhere = '';
    if (dateFrom) { params.push(dateFrom); dateWhere += ` AND game_date >= $${params.length}`; }
    if (dateTo)   { params.push(dateTo);   dateWhere += ` AND game_date <= $${params.length}`; }

    // Build team filter
    let teamWhere = '';
    if (team) {
      params.push(`%${team}%`);
      teamWhere = ` AND (home_team ILIKE $${params.length} OR away_team ILIKE $${params.length})`;
    }

    const { rows: games } = await pg.query(
      `SELECT game_id, game_date, home_team, away_team, home_score, away_score,
              home_batting, home_pitching, away_batting, away_pitching, innings
       FROM game_stats
       WHERE season=$1${dateWhere}${teamWhere}
       ORDER BY game_date DESC
       LIMIT ${limit}`,
      params
    );

    if (games.length === 0) {
      return res.json({ games: 0, players: [], summary: 'No games found for that filter.' });
    }

    // ── Aggregate per player ───────────────────────────────────────────────
    const pi2 = v => parseInt(v)||0;
    const pf2 = v => parseFloat(v)||0;

    const batterMap  = {}; // key: "name|team"
    const pitcherMap = {}; // key: "name|team"

    for (const g of games) {
      const gDate = g.game_date?.toISOString?.().slice(0,10) || '';
      const sides = [
        { arr: g.home_batting  ||[], teamName: g.home_team||'', opp: g.away_team||'' },
        { arr: g.away_batting  ||[], teamName: g.away_team||'', opp: g.home_team||'' },
      ];
      const pitchSides = [
        { arr: g.home_pitching ||[], teamName: g.home_team||'', opp: g.away_team||'' },
        { arr: g.away_pitching ||[], teamName: g.away_team||'', opp: g.home_team||'' },
      ];

      for (const { arr, teamName, opp } of sides) {
        for (const p of arr) {
          if (!p.name) continue;
          if (player && !p.name.toLowerCase().includes(player.toLowerCase())) continue;
          if (team && !teamName.toLowerCase().includes(team.toLowerCase())) continue;
          const key = `${p.name}|${teamName}`;
          if (!batterMap[key]) batterMap[key] = { name: p.name, team: teamName, games:0, ab:0, h:0, r:0, rbi:0, bb:0, k:0, hr:0, sf:0, hbp:0, gameLog:[] };
          const b = batterMap[key];
          b.games++; b.ab+=pi2(p.ab); b.h+=pi2(p.h); b.r+=pi2(p.r);
          b.rbi+=pi2(p.rbi); b.bb+=pi2(p.bb); b.k+=pi2(p.k); b.hr+=pi2(p.hr);
          b.sf+=pi2(p.sf); b.hbp+=pi2(p.hbp);
          b.gameLog.push({ date: gDate, opp, ab:pi2(p.ab), h:pi2(p.h), r:pi2(p.r), rbi:pi2(p.rbi), hr:pi2(p.hr), bb:pi2(p.bb), k:pi2(p.k) });
        }
      }
      for (const { arr, teamName, opp } of pitchSides) {
        for (const p of arr) {
          if (!p.name) continue;
          if (player && !p.name.toLowerCase().includes(player.toLowerCase())) continue;
          if (team && !teamName.toLowerCase().includes(team.toLowerCase())) continue;
          const key = `${p.name}|${teamName}`;
          if (!pitcherMap[key]) pitcherMap[key] = { name: p.name, team: teamName, games:0, outs:0, h:0, r:0, er:0, bb:0, k:0, np:0, bf:0, gameLog:[] };
          const pt = pitcherMap[key];
          const gameIp = pf2(p.ip);
          pt.games++; pt.outs+=ipToOuts(gameIp); pt.h+=pi2(p.h); pt.r+=pi2(p.r);
          pt.er+=pi2(p.er); pt.bb+=pi2(p.bb); pt.k+=pi2(p.k); pt.np+=pi2(p.np); pt.bf+=pi2(p.bf);
          pt.gameLog.push({ date: gDate, opp, ip:gameIp, er:pi2(p.er), k:pi2(p.k), np:pi2(p.np), bb:pi2(p.bb) });
        }
      }
    }

    // ── Compute derived stats ──────────────────────────────────────────────
    const batters = Object.values(batterMap).map(b => ({
      ...b,
      avg: b.ab > 0 ? (b.h/b.ab).toFixed(3) : '.000',
      obp: (b.ab+b.bb+b.hbp) > 0 ? ((b.h+b.bb+b.hbp)/(b.ab+b.bb+b.hbp+b.sf)).toFixed(3) : '.000',
      slg: b.ab > 0 ? ((b.h+b.hr)/b.ab).toFixed(3) : '.000', // approx (no 2B/3B data)
    }));
    const pitchers = Object.values(pitcherMap).map(p => {
      const ipStr = outsToIpStr(p.outs);
      const realIp = outsToRealInnings(p.outs);
      return {
        ...p,
        ip: parseFloat(ipStr),
        ipFmt: ipStr,
        era:   realIp > 0 ? ((p.er / realIp) * 9).toFixed(2) : '-.--',
        whip:  realIp > 0 ? ((p.bb + p.h) / realIp).toFixed(2) : '-.--',
        kPer9: realIp > 0 ? ((p.k  / realIp) * 9).toFixed(1)  : '0.0',
      };
    });

    // Sort by requested stat or default
    const sortBat = (a, b) => {
      if (stat==='avg') return parseFloat(b.avg)-parseFloat(a.avg);
      if (stat==='hr')  return b.hr-a.hr;
      if (stat==='rbi') return b.rbi-a.rbi;
      if (stat==='k' && type==='batter') return a.k-b.k; // fewer K is better
      return b.h-a.h; // default: hits
    };
    const sortPit = (a, b) => {
      if (stat==='era')  return parseFloat(a.era)-parseFloat(b.era);
      if (stat==='k')    return b.k-a.k;
      if (stat==='whip') return parseFloat(a.whip)-parseFloat(b.whip);
      if (stat==='np')   return b.np-a.np;
      if (stat==='ip')   return b.ip-a.ip;
      return parseFloat(a.era)-parseFloat(b.era); // default: ERA
    };

    batters.sort(sortBat);
    pitchers.sort(sortPit);

    // ── Filter by type ─────────────────────────────────────────────────────
    // For player queries, include gameLog in the first match; strip it for leaderboard views
    const mapBat  = (b, i) => player && i===0 ? b : (({ gameLog, ...rest }) => rest)(b);
    const mapPit  = (p, i) => player && i===0 ? p : (({ gameLog, ...rest }) => rest)(p);

    const result = {
      gamesSearched: games.length,
      dateRange: { from: dateFrom||'all', to: dateTo||'today' },
      filters: { player: player||null, team: team||null, type: type||'all', lastN: lastN||null },
      batters:  type === 'pitcher' ? [] : batters.slice(0, 30).map(mapBat),
      pitchers: type === 'batter'  ? [] : pitchers.slice(0, 30).map(mapPit),
    };

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Schedule endpoint ───────────────────────────────────────────────────────
app.get('/api/schedule', async (req, res) => {
  if (!pg) return res.json([]);
  try {
    const season = getSeason();
    const { rows } = await pg.query(
      `SELECT * FROM schedule WHERE season=$1 ORDER BY game_date ASC`,
      [season]
    );
    res.json(rows.map(r => ({
      gameId:       r.game_id,
      date:         r.game_date?.toISOString?.().slice(0,10) || null,
      time:         r.game_time || '',
      homeTeam:     r.home_team,
      awayTeam:     r.away_team,
      location:     r.location || '',
      bataviaScore: r.batavia_score,
      oppScore:     r.opp_score,
      result:       r.result || '',
      isHome:       r.is_home,
      status:       r.status,
      opponent:     r.is_home ? r.away_team : r.home_team,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Wipe + rescrape schedule ─────────────────────────────────────────────────
// One-shot: delete non-Batavia entries + deduplicate abbreviated pitcher names
app.get('/api/delete-pitchers', async (req, res) => {
  if (!pg) return res.json({ error: 'DB unavailable' });
  const names = ['Landen Burch','Brenden Hayes','Kannon VanDuzer','Larsen Burch','Brady Berdine','Carrick Ryan','Aiden Cowburn'];
  const season = getSeason();
  const r = await pg.query(
    `DELETE FROM pitch_availability WHERE season=$1 AND pitcher_name = ANY($2) RETURNING pitcher_name`,
    [season, names]
  ).catch(e => ({ rows: [], error: e.message }));
  res.json({ deleted: r.rows?.map(x=>x.pitcher_name) || [], error: r.error || null });
});

app.get('/api/cleanup-pitchers', async (req, res) => {
  if (!pg) return res.json({ error: 'DB unavailable' });
  try {
    // 1. Delete non-Batavia from both tables
    const r1 = await pg.query("DELETE FROM pitch_availability WHERE team != 'Batavia Muckdogs'");
    const r2 = await pg.query("DELETE FROM pitch_avail WHERE team != 'Batavia Muckdogs'");

    // 2. Remove abbreviated (single-initial) and reversed (Last, First) names from pitch_avail
    //    These are scraper artifacts; the full-name canonical entries are in pitch_availability
    const dupR = await pg.query(`
      DELETE FROM pitch_avail
      WHERE pitcher_name ~ '^[A-Z] [A-Z]'        -- "M Marsh", "C Ward" (initial + last name)
         OR pitcher_name ~ '^[A-Za-z]+, [A-Z]'   -- "Thomas, Logan" (reversed)
      RETURNING pitcher_name`);
    const toDelete = dupR.rows.map(r => r.pitcher_name);

    const { rows: remaining } = await pg.query("SELECT pitcher_name, team FROM pitch_avail");
    const { rows: remaining2 } = await pg.query("SELECT pitcher_name, team FROM pitch_availability WHERE season=$1", [getSeason()]);
    res.json({
      deleted_pitch_avail_nonbatavia: r2.rowCount,
      deleted_pitch_availability_nonbatavia: r1.rowCount,
      deleted_abbreviated_dups: toDelete.length,
      dup_names_removed: toDelete,
      pitch_avail_remaining: remaining.map(r => r.pitcher_name),
      pitch_availability_remaining: remaining2.map(r => r.pitcher_name),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rescrape-schedule', async (req, res) => {
  if (!pg) return res.json({ error: 'DB unavailable' });
  try {
    const season = getSeason();
    await pg.query('DELETE FROM schedule WHERE season=$1', [season]);
    logScrape('Schedule wiped — rescraping...');
    const br = await getBrowser().catch(() => null);
    const games = await scrapeSchedule(season, br).catch(e => { logScrape('Rescrape error: '+e.message); return []; });
    await closeBrowser().catch(() => {});
    res.json({ success: true, games: games.length, message: `Schedule wiped and rescrapped: ${games.length} games` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Seed full Batavia 2026 schedule (GET so it's triggerable via curl) ───────
app.get('/api/seed-schedule', async (req, res) => {
  if (!pg) return res.json({ error: 'DB unavailable' });
  try {
    const season = getSeason();
    const GAMES = [
      // ── Completed games ────────────────────────────────────────────────
      { id:'bat_20260529', date:'2026-05-29', time:'',       isHome:false, home:'Elmira Pioneers',           away:'Batavia Muckdogs',          loc:'Dunn Field, Elmira NY',                             bs:9,  os:6,  result:'W', status:'final'      },
      { id:'bat_20260530', date:'2026-05-30', time:'',       isHome:true,  home:'Batavia Muckdogs',          away:'Elmira Pioneers',           loc:'Dwyer Stadium, Batavia NY',                         bs:12, os:1,  result:'W', status:'final'      },
      { id:'bat_20260531', date:'2026-05-31', time:'',       isHome:true,  home:'Batavia Muckdogs',          away:'Olean Oilers',              loc:'Dwyer Stadium, Batavia NY',                         bs:7,  os:10, result:'L', status:'final'      },
      { id:'bat_20260603', date:'2026-06-03', time:'',       isHome:true,  home:'Batavia Muckdogs',          away:'Jamestown Tarp Skunks',     loc:'Dwyer Stadium, Batavia NY',                         bs:6,  os:7,  result:'L', status:'final'      },
      { id:'bat_20260605', date:'2026-06-05', time:'',       isHome:true,  home:'Batavia Muckdogs',          away:'Niagara Falls Americans',   loc:'Dwyer Stadium, Batavia NY',                         bs:5,  os:4,  result:'W', status:'final'      },
      { id:'bat_20260606', date:'2026-06-06', time:'',       isHome:true,  home:'Batavia Muckdogs',          away:'Buffalo Diesel',            loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'exhibition' },
      { id:'bat_20260607', date:'2026-06-07', time:'',       isHome:false, home:'Olean Oilers',              away:'Batavia Muckdogs',          loc:'Bradner Stadium, Olean NY',                         bs:11, os:1,  result:'W', status:'final'      },
      { id:'bat_20260610', date:'2026-06-10', time:'',       isHome:false, home:'Olean Oilers',              away:'Batavia Muckdogs',          loc:'Bradner Stadium, Olean NY',                         bs:null,os:null,result:'',status:'final'      },
      { id:'bat_20260611', date:'2026-06-11', time:'',       isHome:true,  home:'Batavia Muckdogs',          away:'Jamestown Tarp Skunks',     loc:'Dwyer Stadium, Batavia NY',                         bs:10, os:6,  result:'W', status:'final'      },
      { id:'bat_20260612', date:'2026-06-12', time:'',       isHome:true,  home:'Batavia Muckdogs',          away:'Buffalo Diesel',            loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'exhibition' },
      { id:'bat_20260613', date:'2026-06-13', time:'',       isHome:true,  home:'Batavia Muckdogs',          away:'Newark Pilots',             loc:'Dwyer Stadium, Batavia NY',                         bs:11, os:0,  result:'W', status:'final'      },
      { id:'bat_20260614', date:'2026-06-14', time:'',       isHome:true,  home:'Batavia Muckdogs',          away:'Niagara Ironbacks',         loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'final'      },
      // ── Upcoming games ─────────────────────────────────────────────────
      { id:'bat_20260615', date:'2026-06-15', time:'6:30 PM',isHome:false, home:'Niagara Falls Americans',   away:'Batavia Muckdogs',          loc:'Sal Maglie Stadium, Niagara Falls NY',               bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260616', date:'2026-06-16', time:'6:30 PM',isHome:false, home:'Geneva Red Wings',          away:'Batavia Muckdogs',          loc:'McDonough Park, Geneva NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260617', date:'2026-06-17', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Auburn Doubledays',         loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260618', date:'2026-06-18', time:'6:30 PM',isHome:false, home:'Olean Oilers',              away:'Batavia Muckdogs',          loc:'Bradner Stadium, Olean NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260619', date:'2026-06-19', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Niagara Falls Americans',   loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260620', date:'2026-06-20', time:'6:30 PM',isHome:false, home:'Niagara Falls Americans',   away:'Batavia Muckdogs',          loc:'Sal Maglie Stadium, Niagara Falls NY',               bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260621', date:'2026-06-21', time:'4:05 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Olean Oilers',              loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260623', date:'2026-06-23', time:'6:30 PM',isHome:false, home:'Auburn Doubledays',         away:'Batavia Muckdogs',          loc:'Falcon Park, Auburn NY',                            bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260624', date:'2026-06-24', time:'6:30 PM',isHome:false, home:'Niagara Ironbacks',         away:'Batavia Muckdogs',          loc:'George Taylor Field, Niagara Falls ON',             bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260625', date:'2026-06-25', time:'6:30 PM',isHome:false, home:'Jamestown Tarp Skunks',     away:'Batavia Muckdogs',          loc:'Russell E. Diethrick Jr. Park, Jamestown NY',       bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260626', date:'2026-06-26', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Buffalo Diesel',            loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'exhibition'},
      { id:'bat_20260627', date:'2026-06-27', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Niagara Ironbacks',         loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260628', date:'2026-06-28', time:'5:00 PM',isHome:false, home:'Newark Pilots',             away:'Batavia Muckdogs',          loc:'Colburn Park, Newark NY',                           bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260629', date:'2026-06-29', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Syracuse Salt Cats',        loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260630', date:'2026-06-30', time:'6:30 PM',isHome:false, home:'Niagara Ironbacks',         away:'Batavia Muckdogs',          loc:'George Taylor Field, Niagara Falls ON',             bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260701', date:'2026-07-01', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Jamestown Tarp Skunks',     loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260702', date:'2026-07-02', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Power City',                loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260703', date:'2026-07-03', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Elmira Pioneers',           loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260704', date:'2026-07-04', time:'6:30 PM',isHome:false, home:'Niagara Falls Americans',   away:'Batavia Muckdogs',          loc:'Sal Maglie Stadium, Niagara Falls NY',               bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260705', date:'2026-07-05', time:'4:05 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Buffalo Diesel',            loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'exhibition'},
      { id:'bat_20260707', date:'2026-07-07', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Geneva Red Wings',          loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260708', date:'2026-07-08', time:'6:30 PM',isHome:false, home:'Geneva Red Wings',          away:'Batavia Muckdogs',          loc:'McDonough Park, Geneva NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260709', date:'2026-07-09', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Niagara Falls Americans',   loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260710', date:'2026-07-10', time:'6:30 PM',isHome:false, home:'Jamestown Tarp Skunks',     away:'Batavia Muckdogs',          loc:'Russell E. Diethrick Jr. Park, Jamestown NY',       bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260711', date:'2026-07-11', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Elmira Pioneers',           loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260712', date:'2026-07-12', time:'1:00 PM',isHome:false, home:'Niagara Ironbacks',         away:'Batavia Muckdogs',          loc:'George Taylor Field, Niagara Falls ON',             bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260713', date:'2026-07-13', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Jamestown Tarp Skunks',     loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260714', date:'2026-07-14', time:'6:30 PM',isHome:false, home:'Niagara Falls Americans',   away:'Batavia Muckdogs',          loc:'Sal Maglie Stadium, Niagara Falls NY',               bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260715', date:'2026-07-15', time:'6:30 PM',isHome:false, home:'Jamestown Tarp Skunks',     away:'Batavia Muckdogs',          loc:'Russell E. Diethrick Jr. Park, Jamestown NY',       bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260716', date:'2026-07-16', time:'6:30 PM',isHome:false, home:'Olean Oilers',              away:'Batavia Muckdogs',          loc:'Bradner Stadium, Olean NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260717', date:'2026-07-17', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Olean Oilers',              loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260718', date:'2026-07-18', time:'6:30 PM',isHome:false, home:'Elmira Pioneers',           away:'Batavia Muckdogs',          loc:'Dunn Field, Elmira NY',                             bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260719', date:'2026-07-19', time:'4:05 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Niagara Ironbacks',         loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260721', date:'2026-07-21', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Newark Pilots',             loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260722', date:'2026-07-22', time:'6:30 PM',isHome:false, home:'Auburn Doubledays',         away:'Batavia Muckdogs',          loc:'Falcon Park, Auburn NY',                            bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260723', date:'2026-07-23', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Auburn Doubledays',         loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260724', date:'2026-07-24', time:'6:30 PM',isHome:false, home:'Newark Pilots',             away:'Batavia Muckdogs',          loc:'Colburn Park, Newark NY',                           bs:null,os:null,result:'',status:'scheduled' },
      { id:'bat_20260725', date:'2026-07-25', time:'6:30 PM',isHome:true,  home:'Batavia Muckdogs',          away:'Niagara Falls Americans',   loc:'Dwyer Stadium, Batavia NY',                         bs:null,os:null,result:'',status:'scheduled' },
    ];
    await pg.query('DELETE FROM schedule WHERE season=$1', [season]);
    let saved = 0;
    for (const g of GAMES) {
      await pg.query(
        `INSERT INTO schedule(season,game_id,game_date,game_time,home_team,away_team,location,batavia_score,opp_score,result,is_home,status,box_score_url,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'',NOW())
         ON CONFLICT(season,game_id) DO UPDATE SET
           game_date=$3,game_time=$4,home_team=$5,away_team=$6,location=$7,
           batavia_score=$8,opp_score=$9,result=$10,is_home=$11,status=$12,updated_at=NOW()`,
        [season,g.id,g.date,g.time,g.home,g.away,g.loc,g.bs,g.os,g.result,g.isHome,g.status]
      );
      saved++;
    }
    logScrape(`Seed schedule: ${saved} games inserted`);
    res.json({ success:true, inserted:saved, total:GAMES.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Box scores endpoint ──────────────────────────────────────────────────────
app.get('/api/boxscores', async (req, res) => {
  if (!pg) return res.json([]);
  try {
    const season  = getSeason();
    const gameId  = req.query.gameId || null;
    const limit   = Math.min(parseInt(req.query.limit)||20, 50);
    let q = 'SELECT * FROM box_scores WHERE season=$1';
    const params = [season];
    if (gameId) { q += ` AND game_id=$${params.length+1}`; params.push(gameId); }
    q += ' ORDER BY game_date DESC NULLS LAST LIMIT $' + (params.length+1);
    params.push(limit);
    const { rows } = await pg.query(q, params);
    res.json(rows.map(r => ({
      gameId:      r.game_id,
      date:        r.game_date?.toISOString?.().slice(0,10) || null,
      homeTeam:    r.home_team,
      awayTeam:    r.away_team,
      homeScore:   r.home_score,
      awayScore:   r.away_score,
      status:      r.status,
      innings:     r.innings || [],
      pitcherLines: r.pitcher_lines || [],
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Standings (individual endpoint) ─────────────────────────────────────────
app.get('/api/standings', async (req, res) => {
  if (!pg) return res.json([]);
  try {
    const season = getSeason();
    const { rows } = await pg.query('SELECT * FROM standings WHERE season=$1 ORDER BY rank', [season]);
    res.json(rows.map(r => ({
      name: r.name, w: r.w, l: r.l, t: r.t,
      pct: +r.pct, gb: r.gb, streak: r.streak, last10: r.last10,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Hitters (individual endpoint) ───────────────────────────────────────────
app.get('/api/hitters', async (req, res) => {
  if (!pg) return res.json([]);
  try {
    const season = getSeason();
    const { rows } = await pg.query(
      'SELECT * FROM hitter_stats WHERE season=$1 AND ab >= 1 ORDER BY avg DESC', [season]
    );
    res.json(rows.map(r => ({
      name: r.name, team: r.team, gp: r.gp, ab: +r.ab, h: r.h,
      avg: +r.avg, obp: +r.obp, slg: +r.slg, ops: +r.ops,
      hr: r.hr, rbi: r.rbi, bb: r.bb, k: r.k,
      doubles: r.doubles, triples: r.triples,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Pitchers (individual endpoint) ──────────────────────────────────────────
app.get('/api/pitchers', async (req, res) => {
  if (!pg) return res.json([]);
  try {
    const season = getSeason();
    const { rows } = await pg.query(
      'SELECT * FROM pitcher_stats WHERE season=$1 AND ip >= 0.1 ORDER BY era ASC', [season]
    );
    res.json(rows.map(r => ({
      name: r.name, team: r.team, gp: r.app, ip: +r.ip, era: +r.era,
      whip: +r.whip, k: r.k, bb: r.bb, h: r.h, w: r.w, sv: r.sv, k9: +r.k9,
      bb9: r.ip > 0 ? parseFloat((r.bb / r.ip * 9).toFixed(2)) : 0,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// (duplicate /api/boxscores removed — first registration at line 2287 takes precedence)

// ─── Pitch availability (pre-calculated GREEN/YELLOW/RED) ────────────────────
//  Rules match Dewey's calcPitchAvailability():
//   0-15p → GREEN (0 rest), 16-25p → YELLOW→GREEN (1), 26-30p → RED→GREEN (2),
//   31-40p → RED→YELLOW→GREEN (3), 41-60p → RED(3)→YELLOW→GREEN (4),
//   61-70p → RED(4)→YELLOW→GREEN (5), 71+p → RED(5)→GREEN no yellow
function calcAvailStatus(pitches, daysSince) {
  if (pitches <= 15) return { status: 'GREEN', restNeeded: 0 };
  if (pitches <= 25) return { status: daysSince >= 1 ? 'GREEN' : 'YELLOW', restNeeded: 1 };
  if (pitches <= 30) return { status: daysSince >= 2 ? 'GREEN' : 'RED',    restNeeded: 2 };
  if (pitches <= 40) return { status: daysSince >= 3 ? 'GREEN' : daysSince >= 2 ? 'YELLOW' : 'RED', restNeeded: 3 };
  if (pitches <= 60) return { status: daysSince >= 4 ? 'GREEN' : daysSince >= 3 ? 'YELLOW' : 'RED', restNeeded: 4 };
  if (pitches <= 70) return { status: daysSince >= 5 ? 'GREEN' : daysSince >= 4 ? 'YELLOW' : 'RED', restNeeded: 5 };
  return { status: daysSince >= 5 ? 'GREEN' : 'RED', restNeeded: 5 }; // 71+ no yellow
}

app.get('/api/availability', async (req, res) => {
  if (!pg) return res.json([]);
  try {
    const season = getSeason();
    const { rows } = await pg.query(
      "SELECT * FROM pitch_availability WHERE season=$1 AND team='Batavia Muckdogs'", [season]
    );
    const today = new Date();
    today.setHours(12, 0, 0, 0); // midday anchor to avoid TZ edge cases
    const result = rows
      .filter(r => r.last_outing_pitches > 0 && r.last_outing_date)
      .map(r => {
        const lastDate = new Date(r.last_outing_date);
        lastDate.setHours(12, 0, 0, 0);
        const daysSince = Math.max(0, Math.floor((today - lastDate) / 86400000));
        const pitches   = r.last_outing_pitches;
        const { status, restNeeded } = calcAvailStatus(pitches, daysSince);
        return {
          name:         r.pitcher_name,
          team:         r.team,
          status,
          pitches,
          ip:           +r.last_outing_ip,
          lastDate:     r.last_outing_date?.toISOString?.().slice(0,10) || null,
          daysSince,
          restNeeded,
          daysRemaining: Math.max(0, restNeeded - daysSince),
        };
      })
      .sort((a, b) => ({ RED:0, YELLOW:1, GREEN:2 }[a.status]??3) - ({ RED:0, YELLOW:1, GREEN:2 }[b.status]??3));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Manual pitch log entry ───────────────────────────────────────────────────
app.post('/api/manual-pitch', async (req, res) => {
  const { name, date, pitches, ip=0, outingType='Game', notes='' } = req.body;
  if (!name || !date || !pitches) return res.status(400).json({ error: 'name, date, pitches required' });
  if (!pg) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const season = getSeason();
    await pg.query(
      `INSERT INTO pitch_availability(season,pitcher_name,team,last_outing_date,last_outing_pitches,last_outing_ip,is_manual,outing_type,notes)
       VALUES($1,$2,'Batavia Muckdogs',$3,$4,$5,TRUE,$6,$7)
       ON CONFLICT(season,pitcher_name) DO UPDATE SET
         last_outing_date=$3, last_outing_pitches=$4, last_outing_ip=$5,
         is_manual=TRUE, outing_type=$6, notes=$7, updated_at=NOW()`,
      [season, name, date, parseInt(pitches), parseFloat(ip)||0, outingType, notes]
    );
    // Return updated availability so the client can refresh immediately
    const today = new Date(); today.setHours(12,0,0,0);
    const { rows } = await pg.query(
      "SELECT * FROM pitch_availability WHERE season=$1 AND team='Batavia Muckdogs'", [season]
    );
    const result = rows.filter(r => r.last_outing_pitches > 0 && r.last_outing_date).map(r => {
      const lastDate = new Date(r.last_outing_date); lastDate.setHours(12,0,0,0);
      const daysSince = Math.max(0, Math.floor((today - lastDate) / 86400000));
      const pitches   = r.last_outing_pitches;
      const { status, restNeeded } = calcAvailStatus(pitches, daysSince);
      return { name: r.pitcher_name, team: r.team, status, pitches, ip: +r.last_outing_ip,
               lastDate: r.last_outing_date?.toISOString?.().slice(0,10)||null, daysSince, restNeeded,
               daysRemaining: Math.max(0, restNeeded - daysSince),
               isManual: r.is_manual||false, outingType: r.outing_type||'Game', notes: r.notes||'' };
    }).sort((a,b) => ({RED:0,YELLOW:1,GREEN:2}[a.status]??3) - ({RED:0,YELLOW:1,GREEN:2}[b.status]??3));
    res.json({ success: true, availability: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/manual-pitch/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  if (!pg) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const season = getSeason();
    // Only allow deleting manual entries — scrape data cannot be deleted this way
    await pg.query(
      `DELETE FROM pitch_availability WHERE season=$1 AND pitcher_name=$2 AND is_manual=TRUE`,
      [season, name]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

async function startup() {
  await initDB();

  // Load Puppeteer module (async, non-blocking)
  loadPuppeteer().catch(() => {});

  // Clean non-Batavia entries from both pitch tables (belt-and-suspenders, runs every startup)
  if (pg) {
    pg.query("DELETE FROM pitch_availability WHERE team != 'Batavia Muckdogs'").catch(() => {});
    pg.query("DELETE FROM pitch_avail       WHERE team != 'Batavia Muckdogs'").catch(() => {});
  }

  // Seed manually-collected rosters (ON CONFLICT DO UPDATE — safe to run every startup)
  setTimeout(() => seedManualRosters().catch(e => logScrape('Seed error: ' + e.message)), 2000);

  // Auto-scrape if DB is empty or data is stale (> 3 hours — matches cron interval)
  // If the server was down and missed a cron run, this catches up immediately on restart
  setTimeout(async () => {
    const lastScrape = await getMetaValue('last_scrape');
    const age = lastScrape ? (Date.now() - new Date(lastScrape).getTime()) / 3600000 : 999;
    if (age > 3) {
      logScrape(`Data is ${age < 999 ? age.toFixed(1)+'h' : 'empty'} — running startup scrape (threshold: 3h)`);
      runFullScrape().catch(e => logScrape('Startup scrape error: ' + e.message));
    } else {
      logScrape(`Data is ${age.toFixed(1)}h old — fresh enough, no startup scrape needed`);
      // Even if main data is fresh, scrape game stats if table is empty
      if (pg) {
        const { rows } = await pg.query(`SELECT COUNT(*) AS c FROM game_stats WHERE season=$1`, [getSeason()]).catch(()=>({rows:[{c:'0'}]}));
        if (parseInt(rows[0]?.c||0) === 0) {
          logScrape('game_stats table empty — running targeted game stats scrape');
          let br = null;
          try { br = await getBrowser(); await scrapeGameStats(getSeason(), br); }
          catch(e) { logScrape('Startup game stats error: ' + e.message); }
          finally { await closeBrowser(); }
        }
      }
    }
  }, 3000);

  app.listen(PORT, () => logScrape(`PGCBL server v3 on port ${PORT} — Puppeteer+PostgreSQL+Cron`));
}

startup();
