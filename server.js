// SOS Watch - Prototype 後端 (Node / Express + PostgreSQL)
// 主線: 收裝置 POST -> 寫入 DB -> 回 200 -> 網頁從 DB 讀歷史
// 位置: 收到求救後，背景用來源 IP 反查概略位置，回填該筆
// 開發者登入: 單一密碼 (env) -> HMAC 簽章 token 存 httpOnly cookie -> 解鎖詳細資料
// LINE: fire-and-forget 副作用，用環境變數控制，沒設就跳過

const express = require('express');
const crypto  = require('crypto');
const { Pool } = require('pg');
const { getClientIp, lookupLocation } = require('./geo');

const app = express();
app.use(express.json());
app.set('trust proxy', true);   // Railway 在代理後面

const PORT = process.env.PORT || 3000;

// ---- PostgreSQL 連線 ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { rejectUnauthorized: false },
});

// ---- LINE 設定 ----
const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN || '';
const LINE_TO    = process.env.LINE_TO || '';

// ---- 開發者登入設定 ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';   // 必設，否則無法登入
// 建議設 SESSION_SECRET；沒設會用隨機值 -> 每次重啟所有登入失效
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS   = 12 * 3600 * 1000;   // token 有效 12 小時

// 定時安全比較（避免時序攻擊）
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function makeToken(ttlMs = TOKEN_TTL_MS) {
  const b   = Buffer.from(`exp=${Date.now() + ttlMs}`).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b).digest('base64url');
  return `${b}.${sig}`;
}
function verifyToken(token) {
  if (!token) return false;
  const [b, sig] = token.split('.');
  if (!b || !sig) return false;
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(b).digest('base64url');
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  const m = Buffer.from(b, 'base64url').toString().match(/exp=(\d+)/);
  return !!m && Date.now() < Number(m[1]);
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return null;
}
function isAuthed(req) { return verifyToken(getCookie(req, 'sos_auth')); }
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
}
// 本地 http 測試時 Secure 會讓瀏覽器不收 cookie；Railway 是 HTTPS 所以保留 Secure。
function authCookie(token, maxAgeSec) {
  return `sos_auth=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}

// ---------------------------------------------------------------------------
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
  await pool.query(`
    ALTER TABLE sos_events
      ADD COLUMN IF NOT EXISTS ip       TEXT,
      ADD COLUMN IF NOT EXISTS lat      DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS lng      DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS city     TEXT,
      ADD COLUMN IF NOT EXISTS country  TEXT,
      ADD COLUMN IF NOT EXISTS profile  JSONB;
  `);
  console.log('[DB] ready');
}

// ---------------------------------------------------------------------------
// 裝置上傳 SOS
app.post('/api/sos', async (req, res) => {
  const b  = req.body || {};
  const ip = getClientIp(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO sos_events (device_id, event_time, battery_v, battery_pct, ip, profile, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING pk, received_at`,
      [b.id || null, b.time || null, b.battery_v ?? null, b.battery_pct ?? null, ip,
       b.profile || null, b]
    );
    const pk    = rows[0].pk;
    const saved = { ...b, pk, received_at: rows[0].received_at };
    console.log('[SOS]', JSON.stringify(saved));

    res.status(200).json({ ok: true, pk });

    notifyLine(saved).catch(err => console.error('[LINE] failed:', err.message));

    lookupLocation(ip).then(loc => {
      if (!loc) return;
      pool.query(
        `UPDATE sos_events SET lat=$1, lng=$2, city=$3, country=$4 WHERE pk=$5`,
        [loc.lat, loc.lng, loc.city, loc.country, pk]
      ).catch(err => console.error('[geo] update failed:', err.message));
    });
  } catch (err) {
    console.error('[SOS] DB insert failed:', err.message);
    res.status(500).json({ ok: false });
  }
});

// 公開：網頁輪詢用，基本欄位
app.get('/api/events', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT device_id AS id, event_time AS time, battery_v, battery_pct,
              city, country, lat, lng, received_at
       FROM sos_events ORDER BY pk DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error('[events] query failed:', err.message);
    res.status(500).json([]);
  }
});

// ---- 開發者登入 ----
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ ok: false, error: 'ADMIN_PASSWORD 未設定' });
  if (!password || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ ok: false });
  }
  res.setHeader('Set-Cookie', authCookie(makeToken(), TOKEN_TTL_MS / 1000));
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', authCookie('', 0));
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  res.json({ authed: isAuthed(req) });
});

// 受保護：詳細資料（含 ip / 精確座標 / raw / pk）
app.get('/api/events/detail', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pk, device_id AS id, event_time AS time, battery_v, battery_pct,
              ip, city, country, lat, lng, profile, raw, received_at
       FROM sos_events ORDER BY pk DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    console.error('[detail] query failed:', err.message);
    res.status(500).json([]);
  }
});

// 受保護：刪除一筆
app.delete('/api/events/:pk', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM sos_events WHERE pk = $1', [req.params.pk]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[delete] failed:', err.message);
    res.status(500).json({ ok: false });
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
    console.log(`Developer login: ${ADMIN_PASSWORD ? 'ON' : 'OFF (未設 ADMIN_PASSWORD)'}`);
  }))
  .catch(err => {
    console.error('[DB] init failed:', err.message);
    process.exit(1);
  });

// ---------------------------------------------------------------------------
async function notifyLine(evt) {
  if (!LINE_TOKEN || !LINE_TO) return;
  const text =
    `🆘 SOS 求救\n` +
    `時間: ${evt.time || '-'}\n` +
    `電量: ${evt.battery_pct != null ? evt.battery_pct + '%' : '-'}` +
    `${evt.battery_v != null ? ' (' + evt.battery_v + 'V)' : ''}\n` +
    `收到: ${evt.received_at}`;
  const resp = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: LINE_TO, messages: [{ type: 'text', text }] }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);
  console.log('[LINE] pushed');
}

// ---------------------------------------------------------------------------
// 監控網頁：救護醫療風，中英切換，每 3 秒更新，右上開發者登入
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
  .topbar { position:fixed; top:16px; right:16px; z-index:10; display:flex; gap:8px; }
  .pill {
    background:var(--card); color:var(--ink); border:1px solid var(--line);
    border-radius:999px; padding:8px 16px; font-size:14px; font-weight:600;
    cursor:pointer; box-shadow:0 2px 8px rgba(20,40,60,.08);
  }
  .pill:hover { border-color:var(--red); color:var(--red-dark); }
  .pill.dev-on { background:var(--red); color:#fff; border-color:var(--red); }
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
  .card .meta a { color:var(--red-dark); font-weight:600; text-decoration:none; }
  .card .meta a:hover { text-decoration:underline; }
  .batt {
    font-size:22px; font-weight:700; padding:6px 16px; border-radius:999px;
    background:#eef3f8; color:var(--ink);
  }
  .batt.low { background:#fdecea; color:var(--red-dark); }
  .empty { text-align:center; color:var(--muted); font-size:16px; padding:20px; }

  /* 開發者詳細區塊 */
  .dev {
    flex-basis:100%; margin-top:12px; padding-top:12px; border-top:1px dashed var(--line);
    font-size:13px; color:var(--muted);
  }
  .dev .row { margin-bottom:4px; }
  .dev .k { color:var(--ink); font-weight:600; }
  .dev pre {
    background:#f4f7fb; border:1px solid var(--line); border-radius:8px;
    padding:8px 10px; margin:6px 0 0; font-size:12px; overflow-x:auto; white-space:pre-wrap;
    word-break:break-all; color:#334;
  }
  .del {
    margin-top:8px; background:#fff; color:var(--red-dark); border:1px solid #f6b4ae;
    border-radius:8px; padding:6px 14px; font-size:13px; font-weight:600; cursor:pointer;
  }
  .del:hover { background:#fdecea; }

  /* 登入 modal */
  .overlay {
    display:none; position:fixed; inset:0; background:rgba(20,40,60,.35);
    align-items:center; justify-content:center; z-index:20;
  }
  .overlay.show { display:flex; }
  .modal {
    background:#fff; border-radius:16px; padding:24px; width:320px; max-width:90vw;
    box-shadow:0 12px 40px rgba(20,40,60,.25);
  }
  .modal h3 { margin:0 0 14px; font-size:18px; }
  .modal input {
    width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:10px;
    font-size:15px; margin-bottom:8px;
  }
  .modal .err { color:var(--red-dark); font-size:13px; min-height:18px; margin-bottom:8px; }
  .modal .btns { display:flex; gap:8px; justify-content:flex-end; }
  .modal button {
    border:none; border-radius:10px; padding:10px 16px; font-size:14px; font-weight:600; cursor:pointer;
  }
  .modal .primary { background:var(--red); color:#fff; }
  .modal .ghost { background:#eef3f8; color:var(--ink); }
</style>
</head>
<body>
  <div class="topbar">
    <button id="devBtn" class="pill" onclick="onDevBtn()"></button>
    <button id="langBtn" class="pill" onclick="toggleLang()"></button>
  </div>

  <div class="wrap">
    <header>
      <div class="cross">&#10010;</div>
      <h1 id="t-title"></h1>
      <div class="sub" id="t-sub"></div>
    </header>
    <div id="banner" class="banner ok"></div>
    <div id="list"></div>
  </div>

  <div id="overlay" class="overlay">
    <div class="modal">
      <h3 id="m-title"></h3>
      <input id="pw" type="password" autocomplete="current-password">
      <div class="err" id="m-err"></div>
      <div class="btns">
        <button class="ghost" onclick="closeLogin()" id="m-cancel"></button>
        <button class="primary" onclick="doLogin()" id="m-login"></button>
      </div>
    </div>
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
    viewMap:'view map', locating:'locating\\u2026',
    switchTo:'繁體中文', locale:'en-GB',
    devLogin:'Developer', logout:'Log out',
    loginTitle:'Developer login', pwPlaceholder:'Password',
    login:'Log in', cancel:'Cancel', loginFail:'Wrong password',
    kIp:'IP', kCoords:'Coords', kRaw:'Raw', del:'Delete', confirmDel:'Delete this event?',
    kProfile:'Personal / Medical', pName:'Name', pBlood:'Blood',
    pAllergy:'Allergy', pCond:'Condition', pIce:'Emergency contact'
  },
  zh: {
    htmlLang:'zh-Hant', docTitle:'SOS 求救監控',
    title:'SOS 求救監控',
    sub:'每 3 秒自動更新 &middot; 資料存於 PostgreSQL',
    standbyBig:'系統待命中', standbySmall:'目前無求救訊號',
    alertBig:'&#9888; 收到求救訊號', latestPrefix:'最近一次 &middot; ',
    empty:'尚無事件', deviceTime:'裝置時間', idLabel:'ID',
    viewMap:'查看地圖', locating:'定位中\\u2026',
    switchTo:'English', locale:'zh-TW',
    devLogin:'開發者', logout:'登出',
    loginTitle:'開發者登入', pwPlaceholder:'密碼',
    login:'登入', cancel:'取消', loginFail:'密碼錯誤',
    kIp:'IP', kCoords:'座標', kRaw:'原始', del:'刪除', confirmDel:'確定刪除這筆？',
    kProfile:'個人 / 醫療資訊', pName:'姓名', pBlood:'血型',
    pAllergy:'過敏', pCond:'病史', pIce:'緊急聯絡'
  }
};
var lang = 'en';
var isDev = false;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
function applyStatic() {
  var d = I18N[lang];
  document.documentElement.lang = d.htmlLang;
  document.title = d.docTitle;
  document.getElementById('t-title').textContent = d.title;
  document.getElementById('t-sub').innerHTML = d.sub;
  document.getElementById('langBtn').textContent = d.switchTo;
  document.getElementById('m-title').textContent = d.loginTitle;
  document.getElementById('pw').placeholder = d.pwPlaceholder;
  document.getElementById('m-cancel').textContent = d.cancel;
  document.getElementById('m-login').textContent = d.login;
  updateDevBtn();
}
function updateDevBtn() {
  var d = I18N[lang];
  var btn = document.getElementById('devBtn');
  btn.textContent = isDev ? d.logout : d.devLogin;
  btn.className = 'pill' + (isDev ? ' dev-on' : '');
}
function toggleLang() { lang = (lang === 'en') ? 'zh' : 'en'; applyStatic(); refresh(); }

function onDevBtn() { if (isDev) doLogout(); else openLogin(); }
function openLogin() {
  document.getElementById('m-err').textContent = '';
  document.getElementById('pw').value = '';
  document.getElementById('overlay').classList.add('show');
  document.getElementById('pw').focus();
}
function closeLogin() { document.getElementById('overlay').classList.remove('show'); }
async function doLogin() {
  var d = I18N[lang];
  var pw = document.getElementById('pw').value;
  try {
    var r = await fetch('/api/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ password: pw })
    });
    if (!r.ok) { document.getElementById('m-err').textContent = d.loginFail; return; }
    isDev = true; closeLogin(); updateDevBtn(); refresh();
  } catch (e) { document.getElementById('m-err').textContent = d.loginFail; }
}
async function doLogout() {
  try { await fetch('/api/logout', { method:'POST' }); } catch (e) {}
  isDev = false; updateDevBtn(); refresh();
}
async function delEvent(pk) {
  var d = I18N[lang];
  if (!confirm(d.confirmDel)) return;
  try { await fetch('/api/events/' + pk, { method:'DELETE' }); refresh(); } catch (e) {}
}
async function checkAuth() {
  try { var r = await fetch('/api/me'); var j = await r.json(); isDev = !!j.authed; }
  catch (e) { isDev = false; }
  updateDevBtn();
}

function fmtTime(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString(I18N[lang].locale, { hour12:false }); }
  catch (e) { return iso; }
}
function locLine(e, d) {
  if (e.lat != null && e.lng != null) {
    var place = e.city ? (e.city + (e.country ? ', ' + e.country : '')) : (e.lat + ', ' + e.lng);
    var url = 'https://www.google.com/maps?q=' + e.lat + ',' + e.lng;
    return '<div class="meta">\\uD83D\\uDCCD ' + esc(place)
      + ' &middot; <a href="' + url + '" target="_blank" rel="noopener">' + d.viewMap + '</a></div>';
  }
  return '<div class="meta">\\uD83D\\uDCCD ' + d.locating + '</div>';
}
function profileBlock(p, d) {
  if (!p) return '';
  function row(label, val){
    return val ? '<div class="row"><span class="k">' + label + '</span> ' + esc(val) + '</div>' : '';
  }
  return '<div class="row" style="margin-top:8px"><span class="k">' + d.kProfile + '</span></div>'
    + row(d.pName, p.name) + row(d.pBlood, p.blood) + row(d.pAllergy, p.allergy)
    + row(d.pCond, p.cond) + row(d.pIce, p.ice);
}
function devBlock(e, d) {
  if (!isDev) return '';
  var coords = (e.lat != null && e.lng != null) ? (e.lat + ', ' + e.lng) : '-';
  var raw = '';
  try { raw = JSON.stringify(e.raw, null, 2); } catch (x) { raw = String(e.raw); }
  return '<div class="dev">'
    + '<div class="row"><span class="k">pk</span> #' + esc(e.pk) + '</div>'
    + '<div class="row"><span class="k">' + d.kIp + '</span> ' + esc(e.ip || '-') + '</div>'
    + '<div class="row"><span class="k">' + d.kCoords + '</span> ' + esc(coords) + '</div>'
    + profileBlock(e.profile, d)
    + '<div class="row" style="margin-top:8px"><span class="k">' + d.kRaw + '</span></div>'
    + '<pre>' + esc(raw) + '</pre>'
    + '<button class="del" onclick="delEvent(' + Number(e.pk) + ')">' + d.del + '</button>'
    + '</div>';
}
async function refresh() {
  var d = I18N[lang];
  try {
    const r = await fetch(isDev ? '/api/events/detail' : '/api/events');
    if (r.status === 401) { isDev = false; updateDevBtn(); return refresh(); }
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
        + '<div style="flex:1;min-width:200px"><div class="time">' + fmtTime(e.received_at) + '</div>'
        + '<div class="meta">' + d.deviceTime + ' ' + esc(e.time||'-')
        + ' &middot; ' + d.idLabel + ' ' + esc(e.id||'-') + '</div>'
        + locLine(e, d)
        + '</div>'
        + '<div class="batt' + low + '">' + pct + (volt ? ' &middot; ' + volt : '') + '</div>'
        + devBlock(e, d)
        + '</div>';
    }).join('');
  } catch (err) {}
}

// 進場：Enter 送出登入
document.getElementById('pw').addEventListener('keydown', function(ev){
  if (ev.key === 'Enter') doLogin();
});

applyStatic();
checkAuth().then(refresh);
setInterval(refresh, 3000);
</script>
</body>
</html>`;
