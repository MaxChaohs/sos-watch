# SOS Watch — 可攜式呼救裝置

一個戴在手腕上的小型呼救裝置：按下按鈕，透過 WiFi 把求救訊號送到雲端，
在監控網頁上即時顯示，並可選擇轉發到 LINE。以 Seeed Studio XIAO ESP32-C5
為核心，搭配 ST7789 螢幕與鋰電池，做成手錶造型。

本文件涵蓋整個專案的設計、硬體接線、部署流程，以及開發過程中實際踩到的坑。

---

## 1. 系統架構

資料流（目前 prototype 走 WiFi 直連）：

```
[按鈕按下]
   → XIAO ESP32-C5 醒來
   → 螢幕顯示「傳送中」
   → 連上 WiFi
   → HTTPS POST 到後端 /api/sos（帶 event id、時間、電量）
   → 後端寫入資料庫、回 200
   → 螢幕顯示「已送出」
   → 監控網頁即時更新（每 3 秒）
   → （可選）後端轉發 LINE 通知
```

三個組成部分：

- **Edge（手錶端）**：`sos_watch.cpp`，跑在 XIAO ESP32-C5 上的 Arduino/C++ 韌體。
- **Backend（伺服器端）**：`server.js` + `package.json`，Node/Express，部署在 Railway。
- **Database**：PostgreSQL（Railway 內建，或 Supabase）。

> 設計上把「WiFi 直連」當測試路線、「BLE」當正式路線。BLE 能在戶外無 WiFi
> 時透過身邊手機轉發，但需要寫手機 App；目前先用 WiFi 直連把整條鏈路驗證起來。

---

## 2. 硬體清單（BOM）

| 項目 | 規格 / 建議 | 備註 |
|---|---|---|
| XIAO ESP32-C5 | Pre-Soldered 版 | 雙頻 WiFi 6 / BLE / 深睡 15µA，內建鋰電充放電管理 |
| ST7789 螢幕 | 1.3" 240×240 SPI | 多半無 CS 腳（CS 綁死在模組上） |
| 按鈕 | momentary 常開 | 手錶造型建議小側鍵 |
| 鋰電池 | 3.7V LiPo，附保護板 | 手錶造型用扁平小容量（如 302030，150–300mAh） |
| 電解電容 | 100–470µF | 跨接 BAT+/BAT-，防 WiFi 發射瞬間 brownout（重要，勿省） |
| 外殼 | 3D 列印錶殼 + 錶帶 | 20mm 彈簧棒錶耳 |
| 線材、焊錫 | 薄矽膠線 | 手錶造型用薄線直接焊，別用杜邦排針（會頂高） |

充電模組不需另購（板子 USB-C 直接充電）。WiFi 與 BLE 皆內建於晶片，無需外加無線模組。

---

## 3. 接線

SPI 走硬體預設腳（D8=SCK、D10=MOSI）。其餘腳位對應 `sos_watch.cpp` 開頭的定義：

| 元件 / 腳位 | 接到 XIAO ESP32-C5 |
|---|---|
| ST7789 VCC | 3V3 |
| ST7789 GND | GND |
| ST7789 SCL | SCK（D8） |
| ST7789 SDA | MOSI（D10） |
| ST7789 DC | D2 |
| ST7789 RES | D3 |
| ST7789 BLK（背光） | D4 |
| ST7789 CS | 無（韌體設 `TFT_CS = -1`） |
| 按鈕 | D1 ↔ GND（內部上拉，按下為 LOW） |
| 鋰電池 | 背面 BAT+ / BAT- 焊盤 |
| 電池電壓讀取 | 走板內 GPIO6 / GPIO26，免接線 |

注意事項：

- **GND 是共用的**：螢幕 GND、按鈕 GND、電池 BAT- 都接到同一 GND 網路。
- **BAT 焊盤在板子背面**，焊接前務必確認正負極，接反會燒板。
- 電池電壓讀取使用板子套件內建的巨集 `BAT_VOLT_PIN`（GPIO6）、
  `BAT_VOLT_PIN_EN`（GPIO26），讀值需平均並乘以 2 補償 1:2 分壓。

---

## 4. 目錄結構

```
/                      ← 部署到 Railway 時，server.js 與 package.json 需在此層
├── server.js          ← 後端（Express + PostgreSQL + 監控網頁 + LINE 轉發）
├── package.json       ← 相依套件與啟動指令
├── sos_watch.cpp      ← 韌體（燒錄用；Arduino IDE 需改回 .ino）
├── simulate.js        ← 本機模擬器：不需 ESP32 也能灌測試資料
└── README.md
```

> 部署重點：Railway 預設在 repo 根目錄找 `package.json` 並執行 `node server.js`。
> 若把後端放在子資料夾，需在服務 Settings 設定 Root Directory（見第 7 節注意事項）。

---

## 5. 韌體端（sos_watch.cpp）

行為：開機連 WiFi 並用 NTP 校時 → 待機顯示狀態/時間/電量 → 按鈕按下就
POST 求救 → 依 HTTP 回應顯示「已送出 / 失敗」。

燒錄前需修改的三個值：

```cpp
const char* WIFI_SSID = "你的WiFi名稱";
const char* WIFI_PASS = "你的WiFi密碼";
const char* SOS_URL   = "https://你的網址.up.railway.app/api/sos";
```

需安裝的函式庫：`Adafruit ST7789`（會一併裝 Adafruit GFX）。

燒錄步驟：

1. Arduino IDE 偏好設定加入 esp32 board 套件，板子選 `XIAO_ESP32C5`。
2. **先接上天線**（勿在無天線下開 WiFi，尤其 5GHz 會傷射頻電路）。
3. Arduino IDE 只吃 `.ino`：把 `sos_watch.cpp` 改名為 `sos_watch.ino`
   （或放進同名資料夾）再燒；若用 PlatformIO 則 `.cpp` 為原生格式。

---

## 6. 後端（server.js）

Express 服務，提供三個端點：

| 方法 | 路徑 | 用途 |
|---|---|---|
| POST | `/api/sos` | 裝置上傳求救事件，寫入 DB 後回 200 |
| GET | `/api/events` | 回最近 100 筆事件（供網頁輪詢） |
| GET | `/` | 監控網頁（救護醫療風，預設英文、可切繁體） |

設計重點：

- **先寫入 DB 再回 200**：對呼救裝置，200 應代表「真的存下來了」；
  DB 失敗回 500，裝置螢幕顯示 FAILED，不會騙裝置說成功。
- **LINE 是解耦的副作用**：回 200 之後才 fire-and-forget 打 LINE，
  失敗不影響主線。沒設環境變數就自動跳過。因此 LINE 可之後獨立加，
  韌體 / 螢幕 / 網頁一律不用改。
- 開機時 `initDb()` 自動 `CREATE TABLE IF NOT EXISTS sos_events`，不需手動建表。

---

## 7. 部署到 Railway

1. Railway 新專案 → **Deploy from GitHub repo** → 授權並選你的 repo。
2. 加資料庫：**+ New → Database → PostgreSQL**（或改用 Supabase，見第 8 節）。
3. 回你的 app 服務 → **Variables → Add Reference Variable** → 選 Postgres 的
   `DATABASE_URL`（用 Reference Variable，不要手打）。
4. **Settings → Networking → Generate Domain**，取得公開網址（別忘，否則裝置與你都連不到）。
5. 把網址（結尾加 `/api/sos`）填進韌體的 `SOS_URL`。

之後 push 到 GitHub，Railway 會自動重新部署。

### 環境變數

| 變數 | 必填 | 說明 |
|---|---|---|
| `DATABASE_URL` | 是 | PostgreSQL 連線字串（Railway 用 Reference Variable；Supabase 用 pooler 字串） |
| `PORT` | 否 | Railway 自動注入，程式已處理 |
| `LINE_CHANNEL_TOKEN` | 否 | LINE Messaging API 的 channel access token；不設就不轉發 |
| `LINE_TO` | 否 | LINE 推播目標的 user id 或 group id |

---

## 8. 改用 Supabase 作為資料庫（可選）

Supabase 底層即 PostgreSQL，程式用標準 `pg`，幾乎不用改，只需兩點：

1. **必須開 SSL**：把 `server.js` 中 pool 設定的 SSL 打開：
   ```js
   const pool = new Pool({
     connectionString: process.env.DATABASE_URL,
     ssl: { rejectUnauthorized: false },
   });
   ```
2. **必須用 Connection Pooler，不要用 Direct**：在 Supabase 後台 Connect
   選 Connection Pooling（Transaction 模式），字串特徵是主機名含
   `pooler.supabase.com`、埠為 `6543`。Direct（`db.xxx.supabase.co:5432`）
   在 Railway 會因走 IPv6 而 `ENETUNREACH`。

把 pooler 字串手動填進 Railway 的 `DATABASE_URL`（此時不是 Reference Variable）。

---

## 9. 本機測試（不需 ESP32）

後端分不出請求來自手錶或電腦，可用 curl 直接測：

```bash
curl -X POST https://你的網址.up.railway.app/api/sos \
  -H "Content-Type: application/json" \
  -d '{"id":"test001","type":"sos","time":"15:47:00","battery_v":3.92,"battery_pct":78}'
```

成功回 `{"ok":true,"pk":...}`，網頁橫幅即變紅並冒出卡片。
`battery_pct <= 20` 會觸發低電量紅色警示樣式。

要壓多筆、模擬連續觸發，用 `simulate.js`（Node 18+）：

```bash
SOS_URL="https://你的網址.up.railway.app/api/sos" node simulate.js 5
```

送出的 JSON 欄位與韌體完全一致，故本機驗過的鏈路，ESP32 焊好後行為相同。

---

## 10. 監控網頁

- 救護醫療風：亮底、置中、紅十字識別、放大字級。
- 待機時綠色「System on standby」；收到求救整條變紅「Emergency signal received」。
- 每 3 秒自動更新，資料來自 DB。
- 預設英文，右上角按鈕可切換繁體中文（靜態文字、橫幅、卡片、時間格式一併切換）。
- 目前語言選擇不會記憶（重整回到英文）。

---

## 11. 注意事項與常見錯誤

開發過程實際遇到的問題與解法：

| 現象 | 原因 | 解法 |
|---|---|---|
| `Cannot find module '/app/server.js'` | `server.js` 與 `package.json` 不在同一層 / 不在 repo 根目錄 | 兩檔放到 repo 根目錄，或在服務 Settings 設 Root Directory |
| `ECONNREFUSED ::1:5432` | 沒讀到 `DATABASE_URL`，`pg` 退回連 localhost | 用 Reference Variable 接上 Postgres 的 `DATABASE_URL` |
| `ENETUNREACH ...:5432`（IPv6） | 用了 Supabase Direct connection（IPv6/5432），Railway 連不到 | 改用 Pooler 字串（`pooler.supabase.com:6543`） |
| `Cannot POST /` | POST 打到根路徑 `/`，該路徑只接受 GET | 改 POST 到 `/api/sos` |
| 螢幕畫面花掉 | SPI 接線問題（DC/RES 或 SCK/MOSI） | 檢查接線；顏色反相打開 `tft.invertDisplay(true)`；方向改 `setRotation(0~3)` |
| WiFi 連不上 / 射頻異常 | 未接天線 | 上電前務必接上天線 |
| 按下瞬間裝置重開 | WiFi 發射電流尖峰造成 brownout | BAT+/BAT- 並聯 100–470µF 電容 |

---

## 12. 已知取捨（prototype 階段）

這些是刻意留到後面的，先知道：

- 韌體用 `setInsecure()` 略過 TLS 憑證驗證（正式版再收緊）。
- 目前一直開機連著 WiFi，未做深睡省電（螢幕也一直亮）。
- 未做 ack / 重送狀態機（單向送出）。
- 監控網頁無登入 / 權限，網址知道即可看。

---

## 13. 後續可加的亮點（不需新硬體）

皆可只用現有 ESP32-C5 + 螢幕實現：

1. **WiFi 定位（不靠 GPS）**：掃描周圍 WiFi 熱點 BSSID，交給 Google
   Geolocation API 換算經緯度，在網頁地圖標出求救者位置。
2. **深睡省電 + 按鈕喚醒**：實測待機電流（目標 15µA 級），推算電池續航，
   把需求變成有數據的實驗。此時按鈕需改為外接 10kΩ 下拉 + 0.1µF 消抖、
   接到可喚醒的腳。
3. **心跳 / 斷線偵測（dead-man's switch）**：裝置定時送心跳，後端該收沒收到
   即標記離線。
4. **訊息簽章防偽**：用晶片硬體加密對每筆求救做 HMAC，後端驗章防止假求救。
5. **螢幕顯示 QR code**：待機顯示 QR（傷者資訊或即時狀態頁連結），
   救護員可直接掃描。用 `qrcode` 函式庫算出矩陣，`fillRect` 畫出；
   須暗碼亮底、四周留白邊、內容越短越好掃。

---

## 硬體規格參考

- MCU：ESP32-C5，RISC-V 單核最高 240 MHz，384KB SRAM、8MB Flash、8MB PSRAM
- 無線：雙頻 WiFi 6（2.4 / 5 GHz）、Bluetooth 5 LE、IEEE 802.15.4（Zigbee / Thread）
- 尺寸：21 × 17.8 mm（XIAO 標準）
- 深睡電流：約 15µA
