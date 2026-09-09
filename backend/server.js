import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';

try {
  process.loadEnvFile();
} catch {
  // .env not present — env vars are expected to come from the host/orchestrator instead
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'backend',
    message: 'Express server is running',
  });
});

app.get('/api', (req, res) => {
  res.json({ message: 'API ready' });
});

/* =========================================================
   Matomo (external, read-only analytics DB)
========================================================= */

let matomoPool = null;

function getMatomoPool() {
  if (matomoPool) return matomoPool;
  const { MATOMO_DB_HOST, MATOMO_DB_PORT, MATOMO_DB_USER, MATOMO_DB_PASSWORD, MATOMO_DB_NAME } = process.env;
  if (!MATOMO_DB_HOST || !MATOMO_DB_USER || !MATOMO_DB_NAME) {
    throw new Error('Matomo DB не налаштовано (заповніть MATOMO_DB_HOST / MATOMO_DB_USER / MATOMO_DB_PASSWORD / MATOMO_DB_NAME у backend/.env)');
  }
  matomoPool = mysql.createPool({
    host: MATOMO_DB_HOST,
    port: MATOMO_DB_PORT ? parseInt(MATOMO_DB_PORT, 10) : 3306,
    user: MATOMO_DB_USER,
    password: MATOMO_DB_PASSWORD,
    database: MATOMO_DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10000,
    // DATE columns (our GROUP BY day buckets) must come back as plain "YYYY-MM-DD"
    // strings — letting mysql2 turn them into JS Date objects and later calling
    // .toISOString() shifts the day by the server's local UTC offset.
    dateStrings: ['DATE'],
  });
  return matomoPool;
}

function matomoTable(name) {
  const prefix = process.env.MATOMO_TABLE_PREFIX || 'matomo_';
  return `${prefix}${name}`;
}

// matomo_log_visit holds only real (JS-tracked) browser visits — always "human".
// matomo_log_bot_request is a separate table logging individual crawler HTTP
// requests (Googlebot, Bingbot, AI crawlers, etc.), with its own bot_name/bot_type
// columns. This classifies a bot_name into a friendly bucket.
function botCategoryCaseSql(col) {
  return `
    CASE
      WHEN LOWER(${col}) REGEXP 'googlebot|google-inspectiontool|adsbot-google|mediapartners-google|feedfetcher-google' THEN 'google'
      WHEN LOWER(${col}) REGEXP 'bingbot|bingpreview|adidxbot|msnbot' THEN 'bing'
      WHEN LOWER(${col}) REGEXP 'gptbot|oai-searchbot|chatgpt-user|claudebot|claude-web|anthropic-ai|perplexitybot|perplexity-user|ccbot|google-extended|applebot-extended|bytespider|diffbot|amazonbot|meta-externalagent|youbot' THEN 'ai'
      ELSE 'other_bot'
    END
  `;
}

// Matomo's own referer_type = 8 marks real human visits that clicked through
// from an AI answer engine (ChatGPT, Gemini, Claude, Perplexity, Copilot, ...) —
// distinct from crawler bots in log_bot_request.
const HUMAN_CATEGORY_CASE_SQL = `CASE WHEN referer_type = 8 THEN 'ai_referral' ELSE 'human' END`;

const CATEGORIES = ['human', 'ai_referral', 'google', 'bing', 'ai', 'other_bot'];

function parseDateParam(value, fallback) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

function clampInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

app.get('/api/matomo/sites', async (req, res) => {
  try {
    const pool = getMatomoPool();
    const [rows] = await pool.query(
      `SELECT idsite, name, main_url FROM ${matomoTable('site')} ORDER BY idsite`
    );
    res.json(rows);
  } catch (err) {
    console.error('Matomo /sites error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matomo/summary', async (req, res) => {
  try {
    const pool = getMatomoPool();
    const from = parseDateParam(req.query.from, daysAgo(29));
    const to = parseDateParam(req.query.to, isoDate(new Date()));
    const rawSiteId = req.query.siteId;
    const siteId = rawSiteId && rawSiteId !== 'all' ? clampInt(rawSiteId, null, 1, 2 ** 31 - 1) : null;

    const humanParams = [from, to];
    let humanSiteFilter = '';
    if (siteId) { humanSiteFilter = 'AND idsite = ?'; humanParams.push(siteId); }

    const botParams = [from, to];
    let botSiteFilter = '';
    if (siteId) { botSiteFilter = 'AND idsite = ?'; botParams.push(siteId); }

    const [humanRows] = await pool.query(
      `SELECT DATE(visit_last_action_time) AS day, ${HUMAN_CATEGORY_CASE_SQL} AS category, COUNT(*) AS n
       FROM ${matomoTable('log_visit')}
       WHERE visit_last_action_time >= ? AND visit_last_action_time < DATE_ADD(?, INTERVAL 1 DAY)
       ${humanSiteFilter}
       GROUP BY day, category`,
      humanParams
    );

    const [botRows] = await pool.query(
      `SELECT DATE(server_time) AS day, ${botCategoryCaseSql('bot_name')} AS category, COUNT(*) AS n
       FROM ${matomoTable('log_bot_request')}
       WHERE server_time >= ? AND server_time < DATE_ADD(?, INTERVAL 1 DAY)
       ${botSiteFilter}
       GROUP BY day, category`,
      botParams
    );

    // Which specific AI platform (ChatGPT / Gemini / Claude / Perplexity / ...)
    // sent each referred visit — the ai_referral bucket alone doesn't say that.
    const [aiReferralSourceRows] = await pool.query(
      `SELECT referer_name AS name, COUNT(*) AS n
       FROM ${matomoTable('log_visit')}
       WHERE visit_last_action_time >= ? AND visit_last_action_time < DATE_ADD(?, INTERVAL 1 DAY)
       AND referer_type = 8
       ${humanSiteFilter}
       GROUP BY referer_name
       ORDER BY n DESC`,
      humanParams
    );

    // Same idea for regular human visits: which search engine / site / direct
    // entry actually brought them (Google vs Bing vs direct vs ...).
    const [humanSourceRows] = await pool.query(
      `SELECT COALESCE(NULLIF(referer_name,''), 'Прямий вхід') AS name, COUNT(*) AS n
       FROM ${matomoTable('log_visit')}
       WHERE visit_last_action_time >= ? AND visit_last_action_time < DATE_ADD(?, INTERVAL 1 DAY)
       AND referer_type != 8
       ${humanSiteFilter}
       GROUP BY name
       ORDER BY n DESC`,
      humanParams
    );

    const byDay = new Map();
    const totals = { human: 0, ai_referral: 0, google: 0, bing: 0, ai: 0, other_bot: 0 };
    const dayKey = (d) => (d instanceof Date ? isoDate(d) : String(d));
    const ensureDay = (day) => {
      if (!byDay.has(day)) byDay.set(day, { day, human: 0, ai_referral: 0, google: 0, bing: 0, ai: 0, other_bot: 0 });
      return byDay.get(day);
    };
    for (const r of humanRows) {
      const day = dayKey(r.day);
      ensureDay(day)[r.category] += Number(r.n);
      totals[r.category] += Number(r.n);
    }
    for (const r of botRows) {
      const day = dayKey(r.day);
      ensureDay(day)[r.category] += Number(r.n);
      totals[r.category] += Number(r.n);
    }

    const days = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    const aiReferralSources = aiReferralSourceRows.map((r) => ({
      name: r.name || '(невідоме джерело)',
      count: Number(r.n),
    }));

    // Long tail of one-off referring websites would flood the tile — keep the
    // top few and fold the rest into "Інше".
    const topNWithOther = (rows, n) => {
      const sorted = rows.map((r) => ({ name: r.name, count: Number(r.n) }));
      const top = sorted.slice(0, n);
      const restTotal = sorted.slice(n).reduce((a, r) => a + r.count, 0);
      return restTotal > 0 ? [...top, { name: 'Інше', count: restTotal }] : top;
    };
    const humanSources = topNWithOther(humanSourceRows, 6);

    res.json({ from, to, siteId: siteId ?? 'all', days, totals, total, aiReferralSources, humanSources });
  } catch (err) {
    console.error('Matomo /summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matomo/visits', async (req, res) => {
  try {
    const pool = getMatomoPool();
    const from = parseDateParam(req.query.from, daysAgo(29));
    const to = parseDateParam(req.query.to, isoDate(new Date()));
    const rawSiteId = req.query.siteId;
    const siteId = rawSiteId && rawSiteId !== 'all' ? clampInt(rawSiteId, null, 1, 2 ** 31 - 1) : null;
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
    // Optional exact-match refinement on top of category, e.g. category=human&source=Google
    // for "people who came via Google search" as opposed to Googlebot crawl requests.
    const source = typeof req.query.source === 'string' && req.query.source.trim() ? req.query.source.trim() : null;
    const page = clampInt(req.query.page, 1, 1, 1_000_000);
    const pageSize = clampInt(req.query.pageSize, 25, 1, 200);
    const offset = (page - 1) * pageSize;

    // Whitelisted so req.query.sortBy can never be interpolated as arbitrary SQL.
    const SORT_COLUMNS = {
      time: 'event_time',
      category: 'category',
      detail: 'detail',
      extra: 'extra',
      deviceType: 'device_type',
      country: 'country',
      sourceOrUrl: 'source_or_url',
      httpStatus: 'http_status',
      ip: 'ip',
      actions: 'actions',
    };
    const sortColumn = SORT_COLUMNS[req.query.sortBy] || 'event_time';
    const sortDir = req.query.sortDir === 'asc' ? 'ASC' : 'DESC';
    const orderBySql = sortColumn === 'event_time'
      ? `ORDER BY event_time ${sortDir}`
      : `ORDER BY ${sortColumn} ${sortDir}, event_time DESC`;

    const humanSiteFilter = siteId ? 'AND v.idsite = ?' : '';
    const botSiteFilter = siteId ? 'AND b.idsite = ?' : '';
    const humanParams = [from, to, ...(siteId ? [siteId] : [])];
    const botParams = [from, to, ...(siteId ? [siteId] : [])];

    // Human visits (log_visit) and bot requests (log_bot_request) are different
    // grain (a session vs. a single crawled URL) but are unioned into one
    // timeline so the table matches what was asked for: everyone who touched the site.
    const unionSql = `
      SELECT
        v.idvisit AS id,
        ${HUMAN_CATEGORY_CASE_SQL} AS category,
        v.visit_last_action_time AS event_time,
        TRIM(CONCAT(COALESCE(v.config_browser_name,''), ' ', COALESCE(v.config_browser_version,''))) AS detail,
        v.config_os AS extra,
        v.config_device_type AS device_type,
        v.referer_name AS source_or_url,
        v.location_country AS country,
        NULL AS http_status,
        INET6_NTOA(v.location_ip) AS ip,
        v.visit_total_actions AS actions
      FROM ${matomoTable('log_visit')} v
      WHERE v.visit_last_action_time >= ? AND v.visit_last_action_time < DATE_ADD(?, INTERVAL 1 DAY)
      ${humanSiteFilter}

      UNION ALL

      SELECT
        b.idrequest AS id,
        ${botCategoryCaseSql('b.bot_name')} AS category,
        b.server_time AS event_time,
        b.bot_name AS detail,
        b.bot_type AS extra,
        NULL AS device_type,
        COALESCE(la.name, b.source) AS source_or_url,
        NULL AS country,
        b.http_status_code AS http_status,
        NULL AS ip,
        NULL AS actions
      FROM ${matomoTable('log_bot_request')} b
      LEFT JOIN ${matomoTable('log_action')} la ON la.idaction = b.idaction_url
      WHERE b.server_time >= ? AND b.server_time < DATE_ADD(?, INTERVAL 1 DAY)
      ${botSiteFilter}
    `;
    const unionParams = [...humanParams, ...botParams];
    const filterClauses = [];
    const filterParams = [];
    if (category) { filterClauses.push('category = ?'); filterParams.push(category); }
    if (source) { filterClauses.push('source_or_url = ?'); filterParams.push(source); }
    const filterSql = filterClauses.length ? `WHERE ${filterClauses.join(' AND ')}` : '';

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM (${unionSql}) t ${filterSql}`,
      [...unionParams, ...filterParams]
    );
    const [rows] = await pool.query(
      `SELECT * FROM (${unionSql}) t ${filterSql} ${orderBySql} LIMIT ? OFFSET ?`,
      [...unionParams, ...filterParams, pageSize, offset]
    );

    res.json({
      page,
      pageSize,
      total: countRows[0].cnt,
      rows: rows.map((r) => ({
        id: r.id,
        category: r.category,
        time: r.event_time,
        detail: r.detail,
        extra: r.extra,
        deviceType: r.device_type,
        sourceOrUrl: r.source_or_url,
        country: r.country,
        httpStatus: r.http_status,
        ip: r.ip,
        actions: r.actions,
      })),
    });
  } catch (err) {
    console.error('Matomo /visits error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
