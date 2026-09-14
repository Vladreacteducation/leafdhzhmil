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

// Multiple, independent Matomo installations (different servers, different DBs)
// can be configured: unsuffixed MATOMO_DB_* for the first, MATOMO2_DB_* for the
// second, and so on. Their idsite values can collide (each installation numbers
// its own sites from 1), so every site is addressed everywhere in this API as a
// composite "<instanceId>:<idsite>" string, never a bare idsite.
function buildMatomoInstances() {
  const instances = [];
  for (const { suffix, id } of [{ suffix: '', id: '1' }, { suffix: '2', id: '2' }]) {
    const host = process.env[`MATOMO${suffix}_DB_HOST`];
    if (!host) continue;
    instances.push({
      id,
      label: process.env[`MATOMO${suffix}_LABEL`] || `Matomo ${id}`,
      host,
      port: process.env[`MATOMO${suffix}_DB_PORT`] ? parseInt(process.env[`MATOMO${suffix}_DB_PORT`], 10) : 3306,
      user: process.env[`MATOMO${suffix}_DB_USER`],
      password: process.env[`MATOMO${suffix}_DB_PASSWORD`],
      database: process.env[`MATOMO${suffix}_DB_NAME`],
      tablePrefix: process.env[`MATOMO${suffix}_TABLE_PREFIX`] || 'matomo_',
      // Every site inside one Matomo installation shares one timezone (confirmed
      // empirically: all sites on instance 1 = America/Chicago, all on instance 2 =
      // UTC-4). Matomo's own UI buckets "today"/date ranges by that local calendar
      // day, not UTC — so this is needed to make our numbers match theirs.
      timezone: process.env[`MATOMO${suffix}_TIMEZONE`] || 'UTC',
      pool: null,
    });
  }
  return instances;
}

let matomoInstances = null;
function getMatomoInstances() {
  if (!matomoInstances) matomoInstances = buildMatomoInstances();
  if (!matomoInstances.length) {
    throw new Error('Matomo DB не налаштовано (заповніть MATOMO_DB_HOST / MATOMO_DB_USER / MATOMO_DB_PASSWORD / MATOMO_DB_NAME у backend/.env)');
  }
  return matomoInstances;
}

function getPool(instance) {
  if (instance.pool) return instance.pool;
  instance.pool = mysql.createPool({
    host: instance.host,
    port: instance.port,
    user: instance.user,
    password: instance.password,
    database: instance.database,
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10000,
    // DATE columns (our GROUP BY day buckets) must come back as plain "YYYY-MM-DD"
    // strings — letting mysql2 turn them into JS Date objects and later calling
    // .toISOString() shifts the day by the server's local UTC offset.
    dateStrings: ['DATE'],
  });
  return instance.pool;
}

function matomoTable(instance, name) {
  return `${instance.tablePrefix}${name}`;
}

function compositeSiteId(instance, idsite) {
  return `${instance.id}:${idsite}`;
}

// ---- Timezone-aware date-boundary helpers ----
// visit_last_action_time / server_time are stored in UTC, but Matomo's own UI
// buckets "today" / "yesterday" / a date range by each site's LOCAL calendar
// day. A naive UTC-midnight boundary drifts visits across day/period edges and
// produces totals that don't match the native Matomo reports (confirmed: a
// UTC-4 site's "last 7 days" differed from ours by ~170 visits until this was
// added). These helpers convert a local calendar date (in the instance's
// timezone) to the correct UTC instant.

function parseFixedUtcOffsetMinutes(tz) {
  const m = /^UTC([+-]\d{1,2}(?::?\d{2})?)?$/i.exec(String(tz).trim());
  if (!m) return null;
  if (!m[1]) return 0;
  const sign = m[1][0] === '-' ? -1 : 1;
  const rest = m[1].slice(1).replace(':', '');
  const hours = parseInt(rest.slice(0, 2), 10);
  const minutes = rest.length > 2 ? parseInt(rest.slice(2), 10) : 0;
  return sign * (hours * 60 + minutes);
}

// (local - UTC) in minutes, positive when local is ahead of UTC. Handles both
// fixed offsets ("UTC-4") and DST-aware IANA zones ("America/Chicago").
function tzOffsetMinutesAt(utcDate, timeZone) {
  const fixed = parseFixedUtcOffsetMinutes(timeZone);
  if (fixed !== null) return fixed;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(utcDate).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - utcDate.getTime()) / 60000;
}

// The UTC instant of local midnight for "YYYY-MM-DD" in `timeZone`.
function zonedMidnightUTC(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const naiveUTC = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset1 = tzOffsetMinutesAt(new Date(naiveUTC), timeZone);
  let instant = naiveUTC - offset1 * 60000;
  const offset2 = tzOffsetMinutesAt(new Date(instant), timeZone);
  if (offset2 !== offset1) instant = naiveUTC - offset2 * 60000; // DST-transition correction
  return new Date(instant);
}

function todayInZone(timeZone) {
  const fixed = parseFixedUtcOffsetMinutes(timeZone);
  const now = new Date();
  if (fixed !== null) return new Date(now.getTime() + fixed * 60000).toISOString().slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function daysAgoInZone(n, timeZone) {
  return addDaysToDateStr(todayInZone(timeZone), -n);
}

function formatSqlDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Inclusive "YYYY-MM-DD" calendar range (in the instance's timezone) as UTC SQL
// datetime bounds to use as: >= fromSql AND < toSqlExclusive.
function instanceDateRangeSql(instance, fromStr, toStr) {
  return {
    fromSql: formatSqlDateTime(zonedMidnightUTC(fromStr, instance.timezone)),
    toSqlExclusive: formatSqlDateTime(zonedMidnightUTC(addDaysToDateStr(toStr, 1), instance.timezone)),
  };
}

// Resolves the "siteId" query param into concrete (instance, idsite) targets to
// query: a specific site -> exactly one target; "all"/missing -> every configured
// instance with no idsite filter (i.e. every site in each).
function resolveInstanceTargets(rawSiteId, instances) {
  if (rawSiteId && rawSiteId !== 'all') {
    const [instId, idsiteStr] = String(rawSiteId).split(':');
    const idsite = parseInt(idsiteStr, 10);
    const instance = instances.find((i) => i.id === instId);
    if (instance && Number.isFinite(idsite)) return [{ instance, idsite }];
    // Legacy fallback: a bare integer (from before multi-instance support)
    // is treated as an idsite on the first configured instance.
    const legacyIdsite = parseInt(rawSiteId, 10);
    if (Number.isFinite(legacyIdsite)) return [{ instance: instances[0], idsite: legacyIdsite }];
  }
  return instances.map((instance) => ({ instance, idsite: null }));
}

// NULL sorts as the smallest value (first in ASC, last in DESC) — matches MySQL's
// default so results look the same whether one instance answered or several got merged.
function compareRawRows(a, b, column, dirAsc) {
  const av = a[column], bv = b[column];
  if (av == null && bv == null) return 0;
  if (av == null) return dirAsc ? -1 : 1;
  if (bv == null) return dirAsc ? 1 : -1;
  let cmp;
  if (av instanceof Date || bv instanceof Date) cmp = new Date(av) - new Date(bv);
  else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
  else cmp = String(av).localeCompare(String(bv));
  return dirAsc ? cmp : -cmp;
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
    const instances = getMatomoInstances();
    const settled = await Promise.allSettled(instances.map(async (instance) => {
      const pool = getPool(instance);
      const [rows] = await pool.query(
        `SELECT idsite, name, main_url FROM ${matomoTable(instance, 'site')} ORDER BY idsite`
      );
      return rows.map((r) => ({
        siteId: compositeSiteId(instance, r.idsite),
        name: r.name,
        main_url: r.main_url,
        instance: instance.id,
        instanceLabel: instance.label,
      }));
    }));

    const sites = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') sites.push(...s.value);
      else console.error('Matomo /sites instance error:', s.reason?.message);
    }
    res.json(sites);
  } catch (err) {
    console.error('Matomo /sites error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matomo/summary', async (req, res) => {
  try {
    const instances = getMatomoInstances();
    const from = parseDateParam(req.query.from, daysAgo(29));
    const to = parseDateParam(req.query.to, isoDate(new Date()));
    const rawSiteId = req.query.siteId;
    const targets = resolveInstanceTargets(rawSiteId, instances);

    const perTarget = await Promise.all(targets.map(async ({ instance, idsite }) => {
      const pool = getPool(instance);
      const { fromSql, toSqlExclusive } = instanceDateRangeSql(instance, from, to);
      // Used to shift visit_last_action_time before DATE() so daily buckets line
      // up with the instance's local calendar day, not UTC's.
      const offsetMin = tzOffsetMinutesAt(new Date(), instance.timezone);
      const idsiteFilter = idsite ? 'AND idsite = ?' : '';
      const idsiteParam = idsite ? [idsite] : [];
      const rangeParams = [fromSql, toSqlExclusive, ...idsiteParam];
      const dayBucketParams = [offsetMin, fromSql, toSqlExclusive, ...idsiteParam];

      const [humanRows] = await pool.query(
        `SELECT DATE(DATE_ADD(visit_last_action_time, INTERVAL ? MINUTE)) AS day, ${HUMAN_CATEGORY_CASE_SQL} AS category, COUNT(*) AS n
         FROM ${matomoTable(instance, 'log_visit')}
         WHERE visit_last_action_time >= ? AND visit_last_action_time < ?
         ${idsiteFilter}
         GROUP BY day, category`,
        dayBucketParams
      );

      const [botRows] = await pool.query(
        `SELECT DATE(DATE_ADD(server_time, INTERVAL ? MINUTE)) AS day, ${botCategoryCaseSql('bot_name')} AS category, COUNT(*) AS n
         FROM ${matomoTable(instance, 'log_bot_request')}
         WHERE server_time >= ? AND server_time < ?
         ${idsiteFilter}
         GROUP BY day, category`,
        dayBucketParams
      );

      // Which specific AI platform (ChatGPT / Gemini / Claude / Perplexity / ...)
      // sent each referred visit — the ai_referral bucket alone doesn't say that.
      const [aiReferralSourceRows] = await pool.query(
        `SELECT referer_name AS name, COUNT(*) AS n
         FROM ${matomoTable(instance, 'log_visit')}
         WHERE visit_last_action_time >= ? AND visit_last_action_time < ?
         AND referer_type = 8
         ${idsiteFilter}
         GROUP BY referer_name`,
        rangeParams
      );

      // Same idea for regular human visits: which search engine / site / direct
      // entry actually brought them (Google vs Bing vs direct vs ...).
      const [humanSourceRows] = await pool.query(
        `SELECT COALESCE(NULLIF(referer_name,''), 'Прямий вхід') AS name, COUNT(*) AS n
         FROM ${matomoTable(instance, 'log_visit')}
         WHERE visit_last_action_time >= ? AND visit_last_action_time < ?
         AND referer_type != 8
         ${idsiteFilter}
         GROUP BY name`,
        rangeParams
      );

      return { humanRows, botRows, aiReferralSourceRows, humanSourceRows };
    }));

    const humanRows = perTarget.flatMap((t) => t.humanRows);
    const botRows = perTarget.flatMap((t) => t.botRows);

    // Same referrer name can appear from both instances (e.g. "ChatGPT" on
    // both) — sum them into one entry instead of showing duplicate rows.
    function mergeCountsByName(rowSets) {
      const m = new Map();
      for (const r of rowSets) m.set(r.name, (m.get(r.name) || 0) + Number(r.n));
      return Array.from(m.entries())
        .map(([name, n]) => ({ name, n }))
        .sort((a, b) => b.n - a.n);
    }
    const aiReferralSourceRows = mergeCountsByName(perTarget.flatMap((t) => t.aiReferralSourceRows));
    const humanSourceRows = mergeCountsByName(perTarget.flatMap((t) => t.humanSourceRows));

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

    res.json({ from, to, siteId: rawSiteId || 'all', days, totals, total, aiReferralSources, humanSources });
  } catch (err) {
    console.error('Matomo /summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matomo/visits', async (req, res) => {
  try {
    const instances = getMatomoInstances();
    const from = parseDateParam(req.query.from, daysAgo(29));
    const to = parseDateParam(req.query.to, isoDate(new Date()));
    const targets = resolveInstanceTargets(req.query.siteId, instances);
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
    // Optional exact-match refinement on top of category, e.g. category=human&source=Google
    // for "people who came via Google search" as opposed to Googlebot crawl requests.
    const source = typeof req.query.source === 'string' && req.query.source.trim() ? req.query.source.trim() : null;
    const page = clampInt(req.query.page, 1, 1, 1_000_000);
    // Interactive table pages use 25; Excel export fetches in larger chunks (up
    // to 2000/request) to keep the number of round-trips reasonable.
    const pageSize = clampInt(req.query.pageSize, 25, 1, 2000);
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
    const dirAsc = req.query.sortDir === 'asc';
    const sortDirSql = dirAsc ? 'ASC' : 'DESC';
    const orderBySql = sortColumn === 'event_time'
      ? `ORDER BY event_time ${sortDirSql}`
      : `ORDER BY ${sortColumn} ${sortDirSql}, event_time DESC`;

    const filterClauses = [];
    const filterParams = [];
    if (category) { filterClauses.push('category = ?'); filterParams.push(category); }
    if (source) { filterClauses.push('source_or_url = ?'); filterParams.push(source); }
    const filterSql = filterClauses.length ? `WHERE ${filterClauses.join(' AND ')}` : '';

    // Each instance is queried independently (its own indexed connection),
    // sorted/limited the same way, then the results are merged and re-sorted
    // here in JS before slicing out the requested page. Capped so a deep page
    // number on a multi-instance "all sites" view can't force a huge per-DB fetch.
    const perInstanceLimit = Math.min(offset + pageSize, 20000);

    const perTarget = await Promise.all(targets.map(async ({ instance, idsite }) => {
      const pool = getPool(instance);
      const { fromSql, toSqlExclusive } = instanceDateRangeSql(instance, from, to);
      const humanSiteFilter = idsite ? 'AND v.idsite = ?' : '';
      const botSiteFilter = idsite ? 'AND b.idsite = ?' : '';
      const humanParams = [fromSql, toSqlExclusive, ...(idsite ? [idsite] : [])];
      const botParams = [fromSql, toSqlExclusive, ...(idsite ? [idsite] : [])];

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
        FROM ${matomoTable(instance, 'log_visit')} v
        WHERE v.visit_last_action_time >= ? AND v.visit_last_action_time < ?
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
        FROM ${matomoTable(instance, 'log_bot_request')} b
        LEFT JOIN ${matomoTable(instance, 'log_action')} la ON la.idaction = b.idaction_url
        WHERE b.server_time >= ? AND b.server_time < ?
        ${botSiteFilter}
      `;
      const unionParams = [...humanParams, ...botParams];

      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM (${unionSql}) t ${filterSql}`,
        [...unionParams, ...filterParams]
      );
      const [rows] = await pool.query(
        `SELECT * FROM (${unionSql}) t ${filterSql} ${orderBySql} LIMIT ?`,
        [...unionParams, ...filterParams, perInstanceLimit]
      );
      return { count: Number(countRows[0].cnt), rows: rows.map((r) => ({ ...r, __instance: instance.id })) };
    }));

    const total = perTarget.reduce((a, t) => a + t.count, 0);
    const merged = perTarget.flatMap((t) => t.rows);
    merged.sort((a, b) => compareRawRows(a, b, sortColumn, dirAsc));
    const pageRows = merged.slice(offset, offset + pageSize);

    res.json({
      page,
      pageSize,
      total,
      rows: pageRows.map((r) => ({
        id: `${r.__instance}:${r.id}`,
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
        instance: r.__instance,
      })),
    });
  } catch (err) {
    console.error('Matomo /visits error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   Matomo — cross-site overview table
   (загальна таблиця по всіх сайтах: трафік за вчора / 7 днів / 30 днів)

   matomo_log_visit's only indexes are (idsite, ...) composites, so a scan
   across ALL sites for a date range can't use any of them and falls back to
   a full table scan (~30s per window on this DB, regardless of window size —
   confirmed empirically). Doing that on every page load would hammer the
   client's live production Matomo DB. So this is computed once and cached
   in memory for CACHE_TTL_MS; concurrent requests during a (re)compute share
   the same in-flight promise instead of triggering duplicate scans.
   Ideal real fix: add `CREATE INDEX idx_visit_time ON matomo_log_visit
   (visit_last_action_time)` on their DB (and the equivalent on
   log_bot_request.server_time) — ask before doing that, it's their prod DB.
========================================================= */

const OVERVIEW_CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
let overviewCache = { data: null, computedAt: 0 };
let overviewComputing = null;

const OVERVIEW_METRIC_SELECT_SQL = `
  COUNT(*) AS total,
  SUM(referer_type = 2) AS search,
  SUM(referer_type = 2 AND referer_name = 'Google') AS google,
  SUM(referer_type = 2 AND referer_name = 'Bing') AS bing,
  SUM(referer_type = 2 AND referer_name = 'Yahoo!') AS yahoo,
  SUM(referer_type = 8) AS ai
`;

async function computeSitesOverviewForInstance(instance) {
  const pool = getPool(instance);
  // "Today"/"yesterday" etc. are calendar days in the instance's own timezone,
  // then converted to UTC instants for the actual SQL bounds — same reasoning
  // as instanceDateRangeSql above.
  const todayStr = daysAgoInZone(0, instance.timezone);
  const upperBoundSql = formatSqlDateTime(zonedMidnightUTC(todayStr, instance.timezone));
  const boundedFromSql = {
    yesterday: formatSqlDateTime(zonedMidnightUTC(daysAgoInZone(1, instance.timezone), instance.timezone)),
    last7: formatSqlDateTime(zonedMidnightUTC(daysAgoInZone(7, instance.timezone), instance.timezone)),
    last30: formatSqlDateTime(zonedMidnightUTC(daysAgoInZone(30, instance.timezone), instance.timezone)),
  };

  const [sitesRows, boundedResults, allTimeRows] = await Promise.all([
    pool.query(`SELECT idsite, name FROM ${matomoTable(instance, 'site')} ORDER BY name`).then(([r]) => r),
    Promise.all(Object.values(boundedFromSql).map((fromSql) =>
      pool.query(
        `SELECT idsite, ${OVERVIEW_METRIC_SELECT_SQL}
         FROM ${matomoTable(instance, 'log_visit')}
         WHERE visit_last_action_time >= ? AND visit_last_action_time < ?
         GROUP BY idsite`,
        [fromSql, upperBoundSql]
      ).then(([r]) => r)
    )),
    // "За весь період" — same metrics, no lower bound at all.
    pool.query(
      `SELECT idsite, ${OVERVIEW_METRIC_SELECT_SQL}
       FROM ${matomoTable(instance, 'log_visit')}
       WHERE visit_last_action_time < ?
       GROUP BY idsite`,
      [upperBoundSql]
    ).then(([r]) => r),
  ]);

  const windowKeys = [...Object.keys(boundedFromSql), 'allTime'];
  const windowResults = [...boundedResults, allTimeRows];

  const emptyMetrics = () => ({ total: 0, search: 0, google: 0, bing: 0, yahoo: 0, ai: 0 });
  const byIdsite = new Map(sitesRows.map((s) => [s.idsite, {
    siteId: compositeSiteId(instance, s.idsite),
    name: s.name,
    instance: instance.id,
    instanceLabel: instance.label,
    yesterday: emptyMetrics(), last7: emptyMetrics(), last30: emptyMetrics(), allTime: emptyMetrics(),
  }]));

  windowKeys.forEach((key, i) => {
    for (const row of windowResults[i]) {
      const site = byIdsite.get(row.idsite);
      if (!site) continue; // site was deleted from matomo_site but has old log rows
      site[key] = {
        total: Number(row.total), search: Number(row.search), google: Number(row.google),
        bing: Number(row.bing), yahoo: Number(row.yahoo), ai: Number(row.ai),
      };
    }
  });

  return Array.from(byIdsite.values());
}

async function computeSitesOverview() {
  const instances = getMatomoInstances();
  const settled = await Promise.allSettled(instances.map((i) => computeSitesOverviewForInstance(i)));
  const sites = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') sites.push(...s.value);
    else console.error('Matomo sites-overview instance error:', s.reason?.message);
  }
  return sites;
}

app.get('/api/matomo/sites-overview', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const isFresh = overviewCache.data && (Date.now() - overviewCache.computedAt) < OVERVIEW_CACHE_TTL_MS;

    if (isFresh && !forceRefresh) {
      return res.json({ sites: overviewCache.data, computedAt: overviewCache.computedAt, cached: true });
    }

    if (!overviewComputing) {
      overviewComputing = computeSitesOverview()
        .then((data) => {
          overviewCache = { data, computedAt: Date.now() };
          return data;
        })
        .finally(() => { overviewComputing = null; });
    }

    const data = await overviewComputing;
    res.json({ sites: data, computedAt: overviewCache.computedAt, cached: false });
  } catch (err) {
    console.error('Matomo /sites-overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
