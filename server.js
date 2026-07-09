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
  ssl: { rejectUnauthorized: false },
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
// 極簡歷史網頁 (無框架、不花俏，每 3 秒自動更新)
const PAGE_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SOS 事件</title>
<style>
  body { font-family: ui-monospace, Menlo, Consolas, monospace;
         background:#111; color:#eee; margin:0; padding:20px; }
  h1 { font-size:18px; font-weight:600; margin:0 0 4px; }
  .sub { color:#888; font-size:12px; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #333; }
  th { color:#888; font-weight:normal; font-size:12px; }
  tr:first-child td { color:#4ade80; }
  .empty { color:#666; padding:24px 10px; }
  .dot { color:#4ade80; }
</style>
</head>
<body>
  <h1><span class="dot">&#9679;</span> SOS 事件紀錄</h1>
  <div class="sub">每 3 秒自動更新 &middot; 資料存於 PostgreSQL</div>
  <table>
    <thead>
      <tr><th>收到時間 (server)</th><th>裝置時間</th><th>電量</th><th>ID</th></tr>
    </thead>
    <tbody id="rows"><tr><td class="empty" colspan="4">尚無事件</td></tr></tbody>
  </table>
<script>
async function refresh() {
  try {
    const r = await fetch('/api/events');
    const list = await r.json();
    const tb = document.getElementById('rows');
    if (!list.length) {
      tb.innerHTML = '<tr><td class="empty" colspan="4">尚無事件</td></tr>';
      return;
    }
    tb.innerHTML = list.map(function(e){
      var batt = (e.battery_pct != null ? e.battery_pct + '%' : '-')
               + (e.battery_v != null ? ' (' + e.battery_v + 'V)' : '');
      return '<tr><td>' + (e.received_at||'-') + '</td><td>'
           + (e.time||'-') + '</td><td>' + batt + '</td><td>'
           + (e.id||'-') + '</td></tr>';
    }).join('');
  } catch (err) {}
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
