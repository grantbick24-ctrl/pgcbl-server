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
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (season, pitcher_name)
      );
      CREATE TABLE IF NOT EXISTS box_scores (
        season TEXT, game_id TEXT NOT NULL,
        home_team TEXT DEFAULT '', away_team TEXT DEFAULT '',
        home_score INTEGER DEFAULT 0, away_score INTEGER DEFAULT 0,
        game_date DATE, status TEXT DEFAULT 'F',
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
    `);
    console.log('PostgreSQL ready — all tables created');
    return true;
  } catch (e) {
    console.error('DB init failed:', e.message);
    pg = null; return false;
  }
}

// ─── Scrape state ─────────────────────────────────────────────────────────────
let isScraping = false;
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
        '--no-zygote', '--window-size=1280,800',
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
async function getPageHTML(url, br) {
  if (br) {
    let page = null;
    try {
      page = await br.newPage();
      await page.setUserAgent(UA);
      await page.setViewport({ width: 1280, height: 800 });
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      await delay(3000, 7000);
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      } catch {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      // Wait for Presto Sports JS to render table data
      try {
        await page.waitForSelector('table tbody tr', { timeout: 8000 });
      } catch {}
      // Extra wait for any async data rendering
      await delay(1500, 2500);
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
    }
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
  for (const team of TEAMS) {
    const html = await getPageHTML(`https://pgcbl.com/sports/bsb/${season}/teams/${team.slug}?view=lineup`, br);
    const tables = parseHTMLTables(html);
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

    // Now find the data table — either same table with rows, or the DataTables body table
    for (const { headers, rows } of tables) {
      // Roster rows: col 0 = jersey number (1-3 digits), col 1 = player name (Capital Lastname)
      // This filters out gamelog rows, header rows, and totals rows
      const dataRows = rows.filter(r => {
        if (r.length < 4) return false;           // roster has 4+ columns
        if (!/^\d{1,3}$/.test(r[0])) return false; // col 0 must be jersey number
        const name = cleanName(r[nameCol] || r[1]);
        return name && name.length >= 3 && /^[A-Z][a-z]/.test(name); // real name (capitalized)
      });
      if (!dataRows.length) continue;

      for (const r of dataRows) {
        const name = cleanName(r[nameCol]);
        if (!name || name.length < 2) continue;
        if (!pg) continue;
        await pg.query(
          `INSERT INTO rosters(season,team,player_name,number,position,player_year,hometown)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(season,team,player_name) DO UPDATE SET
             number=$4,position=$5,player_year=$6,hometown=$7,updated_at=NOW()`,
          [season, team.name, name,
           r[idx['#']??idx['no']??idx['num']??0]||'',
           r[idx['pos']??idx['position']??3]||'',
           r[idx['yr']??idx['year']??idx['cl']??-1]||'',
           r[idx['hometown']??idx['city']??idx['from']??-1]||'',
          ]
        ).catch(() => {});
        saved++;
      }
      if (saved) break;
    }
    logScrape(`  ${team.name}: ${saved} players`);
  }
}

// ─── 5. Pitch counts from box scores ─────────────────────────────────────────
async function scrapePitchCounts(season, br) {
  logScrape('Scraping Batavia pitch counts...');

  // Get gamelog page to find box score links
  const logHTML = await getPageHTML(
    `https://pgcbl.com/sports/bsb/${season}/teams/bataviamuckdogs?view=gamelog`, br
  );

  // Extract box score links
  const linkSet = new Set();
  for (const m of logHTML.matchAll(/boxscores\/([^"'\s<>]+\.xml)/g)) {
    linkSet.add(`https://pgcbl.com/sports/bsb/${season}/boxscores/${m[1]}`);
  }
  const links = [...linkSet].slice(0, 30);
  logScrape(`  Found ${links.length} box score links`);

  // Track most recent outing per Batavia pitcher
  const pitchMap = {}; // { name: { date, pitches, ip } }

  for (const url of links) {
    const dateM = url.match(/(\d{8})_/);
    const date  = dateM ? `${dateM[1].slice(0,4)}-${dateM[1].slice(4,6)}-${dateM[1].slice(6,8)}` : null;

    const html = await getPageHTML(url, br);
    const tables = parseHTMLTables(html);

    for (const { raw, rows } of tables) {
      if (!raw.includes('NP') && !raw.includes('np')) continue;
      // Only process Batavia's pitcher table — table header includes team name
      const tableHeader = raw.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i)?.[1] || raw.slice(0, 300);
      const isBatavia = /batavia/i.test(stripTags(tableHeader));
      if (!isBatavia) continue;

      // Find header row
      const allRows = rows;
      const hdrRow  = allRows[0]?.map(c => c.toLowerCase()) || [];
      const npIdx   = hdrRow.indexOf('np');
      const ipIdx   = hdrRow.indexOf('ip');
      if (npIdx < 0) continue;

      for (const row of allRows.slice(1)) {
        const rawName = row[0];
        if (!rawName || /^(pitchers?|totals?)$/i.test(rawName)) continue;
        const name    = cleanName(rawName);
        const pitches = pi(row[npIdx]) ?? 0;
        const ip      = pf(row[ipIdx]) ?? 0;
        if (!name || !pitches) continue;
        // Keep most recent outing
        if (!pitchMap[name] || date > pitchMap[name].date) {
          pitchMap[name] = { date, pitches, ip };
        }
      }
    }
  }

  if (!pg) return;
  let saved = 0;
  for (const [name, d] of Object.entries(pitchMap)) {
    await pg.query(
      `INSERT INTO pitch_availability(season,pitcher_name,team,last_outing_date,last_outing_pitches,last_outing_ip)
       VALUES($1,$2,'Batavia Muckdogs',$3,$4,$5)
       ON CONFLICT(season,pitcher_name) DO UPDATE SET
         last_outing_date=$3,last_outing_pitches=$4,last_outing_ip=$5,updated_at=NOW()`,
      [season, name, d.date, d.pitches, d.ip]
    ).catch(() => {});
    saved++;
  }
  logScrape(`  ✓ ${saved} Batavia pitch records`);
}

// ─── 6. Recent box scores (scores only, West games) ───────────────────────────
async function scrapeBoxScores(season, br) {
  logScrape('Scraping recent box scores...');
  const logHTML = await getPageHTML(
    `https://pgcbl.com/sports/bsb/${season}/teams/bataviamuckdogs?view=gamelog`, br
  );
  const tables = parseHTMLTables(logHTML);
  let saved = 0;
  for (const { headers, rows } of tables) {
    if (!headers.some(h => /date|opp|result/i.test(h))) continue;
    for (const r of rows) {
      const dateStr = r[0]?.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/)?.[0];
      if (!dateStr) continue;
      const [mo, dy, yr] = dateStr.split('/');
      const gameDate = `${yr.length===2?'20'+yr:yr}-${mo.padStart(2,'0')}-${dy.padStart(2,'0')}`;
      const opp   = r.find(c => /[A-Z][a-z]+/.test(c) && c !== r[0]) || '';
      // Result format is "W, 9-6" or "L, 7-10" — extract just the score
      const scoreCell = r.find(c => /\d+-\d+/.test(c)) || '';
      const scoreMatch = scoreCell.match(/(\d+)-(\d+)/);
      const [s1, s2] = scoreMatch ? [Number(scoreMatch[1]), Number(scoreMatch[2])] : [0, 0];
      const gameId = `batavia_${gameDate.replace(/-/g,'')}`;
      if (!pg) continue;
      await pg.query(
        `INSERT INTO box_scores(season,game_id,away_team,home_team,away_score,home_score,game_date,status)
         VALUES($1,$2,'Batavia Muckdogs',$3,$4,$5,$6,'F')
         ON CONFLICT(season,game_id) DO UPDATE SET
           home_team=$3,away_score=$4,home_score=$5,game_date=$6,updated_at=NOW()`,
        [season, gameId, opp, s1||0, s2||0, gameDate]
      ).catch(() => {});
      saved++;
    }
    if (saved) break;
  }
  logScrape(`  ✓ ${saved} box score records`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FULL SCRAPE ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════
async function runFullScrape() {
  if (isScraping) { logScrape('Scrape already running — skipped'); return; }
  isScraping = true;
  logScrape('═══ Starting full scrape ═══');
  const season = getSeason();
  let br = null;

  try {
    br = await getBrowser(); // may be null if Puppeteer unavailable
    // All scrapes sequential, one page at a time
    await scrapeStandings(season, br);
    await scrapeHitters(season, br);
    await scrapePitchers(season, br);
    await scrapeRosters(season, br);
    await scrapePitchCounts(season, br);
    await scrapeBoxScores(season, br);

    await setMetaValue('last_scrape', new Date().toISOString());
    await setMetaValue('last_scrape_error', '');
    logScrape('═══ Scrape complete ═══');
  } catch (e) {
    logScrape('═══ Scrape failed: ' + e.message + ' ═══');
    await setMetaValue('last_scrape_error', e.message).catch(() => {});
  } finally {
    // Close browser after each scrape to free memory
    await closeBrowser();
    isScraping = false;
  }
}

// ─── 6am cron (Eastern time) ─────────────────────────────────────────────────
cron.schedule('0 6 * * *', () => {
  logScrape('6am cron triggered');
  runFullScrape().catch(e => logScrape('Cron error: ' + e.message));
}, { timezone: 'America/New_York' });

// ═══════════════════════════════════════════════════════════════════════════════
//  DB → API ASSEMBLER
// ═══════════════════════════════════════════════════════════════════════════════
async function assembleStats() {
  if (!pg) return null;
  const season = getSeason();

  const [standR, hitR, pitR, pavR, lastScrape, scrapeErr] = await Promise.all([
    pg.query('SELECT * FROM standings  WHERE season=$1 ORDER BY rank', [season]),
    pg.query('SELECT * FROM hitter_stats  WHERE season=$1 AND ab >= 1 ORDER BY avg DESC', [season]),
    pg.query('SELECT * FROM pitcher_stats WHERE season=$1 AND ip >= 0.1 ORDER BY era ASC', [season]),
    pg.query("SELECT * FROM pitch_availability WHERE season=$1 AND team='Batavia Muckdogs'", [season]),
    getMetaValue('last_scrape'),
    getMetaValue('last_scrape_error'),
  ]);

  const hitters = hitR.rows.map(r => ({
    name: r.name, team: r.team, gp: r.gp, ab: +r.ab, h: r.h,
    avg: +r.avg, obp: +r.obp, slg: +r.slg, ops: +r.ops,
    hr: r.hr, rbi: r.rbi, bb: r.bb, k: r.k,
    doubles: r.doubles, triples: r.triples,
  }));

  const pitchers = pitR.rows.map(r => ({
    name: r.name, team: r.team, gp: r.app, ip: +r.ip, era: +r.era,
    whip: +r.whip, k: r.k, bb: r.bb, h: r.h, w: r.w, sv: r.sv,
    k9: +r.k9,
    bb9: r.ip > 0 ? parseFloat((r.bb / r.ip * 9).toFixed(2)) : 0,
  }));

  // Pitch counts from DB (most recent outing per Batavia pitcher)
  const pitchCounts = {};
  for (const row of pavR.rows) {
    if (row.last_outing_pitches > 0) {
      pitchCounts[row.pitcher_name] = [{
        date:    row.last_outing_date?.toISOString?.().slice(0,10) || null,
        pitches: row.last_outing_pitches,
        ip:      +row.last_outing_ip,
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

  return {
    hitters,
    pitchers,
    standings: standR.rows.map(r => ({
      name: r.name, w: r.w, l: r.l, t: r.t, pct: +r.pct,
      gb: r.gb, streak: r.streak, last10: r.last10,
    })),
    pitchCounts,
    season,
    laWhip:     1.37,
    laK9:       8.21,
    updatedAt,
    isStale:    staleHours > 24,
    lastScrapeError: scrapeErr || null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/health', async (req, res) => {
  const lastScrape = await getMetaValue('last_scrape');
  const lastError  = await getMetaValue('last_scrape_error');
  res.json({
    status:  'PGCBL Stats Server v3 — Puppeteer + PostgreSQL',
    season:  getSeason(),
    db:      !!pg,
    isScraping,
    lastScrape,
    lastScrapeError: lastError || null,
    puppeteer: puppeteerAvailable,
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
  setImmediate(() => runFullScrape().catch(e => logScrape('Manual refresh error: ' + e.message)));
  res.json({ success: true, message: 'Scrape started — check /api/health for status' });
});

app.get('/api/scrape-log', (req, res) => {
  res.json({ log: scrapeLog.slice(-100) });
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
    const { rows } = await pg.query('SELECT pitcher_name,team,outings FROM pitch_avail');
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

// ═══════════════════════════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

async function startup() {
  await initDB();

  // Load Puppeteer module (async, non-blocking)
  loadPuppeteer().catch(() => {});

  // Auto-scrape if DB is empty or data is stale (> 12 hours)
  setTimeout(async () => {
    const lastScrape = await getMetaValue('last_scrape');
    const age = lastScrape ? (Date.now() - new Date(lastScrape).getTime()) / 3600000 : 999;
    if (age > 12) {
      logScrape(`Data is ${age < 999 ? age.toFixed(1)+'h' : 'empty'} — running startup scrape`);
      runFullScrape().catch(e => logScrape('Startup scrape error: ' + e.message));
    } else {
      logScrape(`Data is ${age.toFixed(1)}h old — no startup scrape needed`);
    }
  }, 3000);

  app.listen(PORT, () => logScrape(`PGCBL server v3 on port ${PORT} — Puppeteer+PostgreSQL+Cron`));
}

startup();
