// SOS Watch - Prototype 後端 (Node / Express + PostgreSQL)
// 主線: 收裝置 POST -> 寫入 DB -> 回 200 -> 網頁從 DB 讀歷史
// LINE: 掛在後面的 fire-and-forget 副作用，用環境變數控制，沒設就跳過
//
// DB: Railway 掛一個 PostgreSQL 服務，把它的 DATABASE_URL 以 Reference Variable
//     加到本服務的 Variables，程式就會從 process.env.DATABASE_URL 讀到。

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---- PostgreSQL 連線 ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // 建議用 Railway 的「內部」DATABASE_URL(Reference Variable)，不需 SSL。
  // 若你改用「公開」連線字串(DATABASE_PUBLIC_URL / TCP Proxy)，取消下一行:
  // ssl: { rejectUnauthorized: false },
});

// ---- LINE 設定 (可選，沒設就自動跳過) ----
const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN || '';
const LINE_TO    = process.env.LINE_TO || '';

// ---------------------------------------------------------------------------
// 啟動時建表 (簡易 migration；已存在就略過)
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sos_events (
      pk           BIGSERIAL PRIMARY KEY,
      device_id    TEXT,
      event_time   TEXT,
      battery_v    REAL,
      battery_pct  INTEGER,
      raw          JSONB,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('[DB] ready');
}

// ---------------------------------------------------------------------------
// 裝置上傳 SOS
app.post('/api/sos', async (req, res) => {
  const b = req.body || {};
  try {
    // 先寫入 DB。對呼救裝置來說，200 應該代表「真的存下來了」，
    // 所以這裡 await；DB 失敗就回錯，裝置螢幕會顯示 FAILED。
    const { rows } = await pool.query(
      `INSERT INTO sos_events (device_id, event_time, battery_v, battery_pct, raw)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING pk, received_at`,
      [b.id || null, b.time || null, b.battery_v ?? null, b.battery_pct ?? null, b]
    );

    const saved = { ...b, pk: rows[0].pk, received_at: rows[0].received_at };
    console.log('[SOS]', JSON.stringify(saved));

    res.status(200).json({ ok: true, pk: rows[0].pk });

    // 副作用: 失敗不影響上面的 200
    notifyLine(saved).catch(err => console.error('[LINE] failed:', err.message));
  } catch (err) {
    console.error('[SOS] DB insert failed:', err.message);
    res.status(500).json({ ok: false });
  }
});

// 網頁輪詢用: 回最近 100 筆
app.get('/api/events', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT device_id AS id, event_time AS time, battery_v, battery_pct, received_at
       FROM sos_events ORDER BY pk DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error('[events] query failed:', err.message);
    res.status(500).json([]);
  }
});

app.get('/', (req, res) => {
  res.type('html').send(PAGE_HTML);
});

// ---------------------------------------------------------------------------
initDb()
  .then(() => app.listen(PORT, () => {
    console.log(`SOS backend listening on ${PORT}`);
    console.log(`LINE forwarding: ${LINE_TOKEN && LINE_TO ? 'ON' : 'OFF (未設定)'}`);
  }))
  .catch(err => {
    console.error('[DB] init failed:', err.message);
    process.exit(1);
  });

// ---------------------------------------------------------------------------
// LINE Messaging API push (之後要接才設環境變數)
async function notifyLine(evt) {
  if (!LINE_TOKEN || !LINE_TO) return; // 未設定 -> 跳過，不影響主線

  const text =
    `🆘 SOS 求救\n` +
    `時間: ${evt.time || '-'}\n` +
    `電量: ${evt.battery_pct != null ? evt.battery_pct + '%' : '-'}` +
    `${evt.battery_v != null ? ' (' + evt.battery_v + 'V)' : ''}\n` +
    `收到: ${evt.received_at}`;

  const resp = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({ to: LINE_TO, messages: [{ type: 'text', text }] }),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);
  console.log('[LINE] pushed');
}

// ---------------------------------------------------------------------------
// 監控網頁：救護醫療風，預設英文 + 右上角語言切換 (English / 繁體中文)，每 3 秒自動更新
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SOS Monitor </title>
<style>
  :root {
    --red:#e53935; --red-dark:#c62828; --green:#2e9e5b;
    --bg:#eef3f8; --card:#ffffff; --ink:#16222e; --muted:#6b7a89;
    --line:#dbe4ee;
  }
  * { box-sizing:border-box; }
  body {
    font-family:"Segoe UI", system-ui, -apple-system, "PingFang TC", "Noto Sans TC", sans-serif;
    background:var(--bg); color:var(--ink); margin:0;
    min-height:100vh; display:flex; flex-direction:column; align-items:center;
    padding:32px 16px;
  }
  .lang-btn {
    position:fixed; top:16px; right:16px; z-index:10;
    background:var(--card); color:var(--ink); border:1px solid var(--line);
    border-radius:999px; padding:8px 16px; font-size:14px; font-weight:600;
    cursor:pointer; box-shadow:0 2px 8px rgba(20,40,60,.08);
  }
  .lang-btn:hover { border-color:var(--red); color:var(--red-dark); }
  .wrap { width:100%; max-width:720px; }
  header { text-align:center; margin-bottom:24px; }
  .cross {
    display:inline-flex; align-items:center; justify-content:center;
    width:56px; height:56px; border-radius:14px; background:var(--red);
    color:#fff; font-size:38px; font-weight:700; line-height:1; margin-bottom:12px;
  }
  h1 { font-size:30px; font-weight:700; margin:0; letter-spacing:1px; }
  .sub { color:var(--muted); font-size:14px; margin-top:6px; }

  .banner {
    text-align:center; border-radius:18px; padding:28px 20px; margin-bottom:24px;
    background:#e8f7ee; border:2px solid #b7e6c9;
  }
  .banner.alert { background:#fdecea; border-color:#f6b4ae; }
  .banner .big { font-size:28px; font-weight:700; }
  .banner.ok  .big { color:var(--green); }
  .banner.alert .big { color:var(--red-dark); }
  .banner .small { font-size:15px; color:var(--muted); margin-top:6px; }

  .card {
    background:var(--card); border-radius:16px; padding:20px 24px; margin-bottom:14px;
    border:1px solid var(--line); border-left:6px solid var(--red);
    box-shadow:0 2px 10px rgba(20,40,60,.05);
    display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px;
  }
  .card.latest { border-left-color:var(--red); background:#fff6f5; }
  .card .time { font-size:22px; font-weight:700; }
  .card .meta { font-size:14px; color:var(--muted); margin-top:2px; }
  .batt {
    font-size:22px; font-weight:700; padding:6px 16px; border-radius:999px;
    background:#eef3f8; color:var(--ink);
  }
  .batt.low { background:#fdecea; color:var(--red-dark); }
  .empty { text-align:center; color:var(--muted); font-size:16px; padding:20px; }
</style>
</head>
<body>
  <button id="langBtn" class="lang-btn" onclick="toggleLang()"></button>
  <div class="wrap">
    <header>
      <div class="cross">&#10010;</div>
      <h1 id="t-title"></h1>
      <div class="sub" id="t-sub"></div>
    </header>
    <div id="banner" class="banner ok"></div>
    <div id="list"></div>
  </div>
<script>
var I18N = {
  en: {
    htmlLang:'en', docTitle:'SOS Emergency Monitor',
    title:'Emergency Monitor',
    sub:'Auto-refresh every 3s &middot; Stored in PostgreSQL',
    standbyBig:'System on standby', standbySmall:'No emergency signals',
    alertBig:'&#9888; Emergency signal received', latestPrefix:'Latest &middot; ',
    empty:'No events yet', deviceTime:'Device time', idLabel:'ID',
    switchTo:'繁體中文', locale:'en-GB'
  },
  zh: {
    htmlLang:'zh-Hant', docTitle:'SOS 求救監控',
    title:'SOS 求救監控',
    sub:'每 3 秒自動更新 &middot; 資料存於 PostgreSQL',
    standbyBig:'系統待命中', standbySmall:'目前無求救訊號',
    alertBig:'&#9888; 收到求救訊號', latestPrefix:'最近一次 &middot; ',
    empty:'尚無事件', deviceTime:'裝置時間', idLabel:'ID',
    switchTo:'English', locale:'zh-TW'
  }
};
var lang = 'en';

function applyStatic() {
  var d = I18N[lang];
  document.documentElement.lang = d.htmlLang;
  document.title = d.docTitle;
  document.getElementById('t-title').textContent = d.title;
  document.getElementById('t-sub').innerHTML = d.sub;
  document.getElementById('langBtn').textContent = d.switchTo;
}
function toggleLang() {
  lang = (lang === 'en') ? 'zh' : 'en';
  applyStatic();
  refresh();
}
function fmtTime(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString(I18N[lang].locale, { hour12:false }); }
  catch (e) { return iso; }
}
async function refresh() {
  var d = I18N[lang];
  try {
    const r = await fetch('/api/events');
    const list = await r.json();
    const banner = document.getElementById('banner');
    const box = document.getElementById('list');

    if (!list.length) {
      banner.className = 'banner ok';
      banner.innerHTML = '<div class="big">' + d.standbyBig + '</div>'
        + '<div class="small">' + d.standbySmall + '</div>';
      box.innerHTML = '<div class="empty">' + d.empty + '</div>';
      return;
    }

    var latest = list[0];
    banner.className = 'banner alert';
    banner.innerHTML = '<div class="big">' + d.alertBig + '</div>'
      + '<div class="small">' + d.latestPrefix + fmtTime(latest.received_at) + '</div>';

    box.innerHTML = list.map(function(e, i){
      var pct = (e.battery_pct != null ? e.battery_pct + '%' : '-');
      var low = (e.battery_pct != null && e.battery_pct <= 20) ? ' low' : '';
      var volt = (e.battery_v != null ? e.battery_v + 'V' : '');
      return '<div class="card' + (i===0 ? ' latest' : '') + '">'
        + '<div><div class="time">' + fmtTime(e.received_at) + '</div>'
        + '<div class="meta">' + d.deviceTime + ' ' + (e.time||'-')
        + ' &middot; ' + d.idLabel + ' ' + (e.id||'-') + '</div></div>'
        + '<div class="batt' + low + '">' + pct + (volt ? ' &middot; ' + volt : '') + '</div>'
        + '</div>';
    }).join('');
  } catch (err) {}
}
applyStatic();
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
