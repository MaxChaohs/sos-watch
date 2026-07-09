# SOS Watch — Portable Emergency Call Device

A wrist-worn emergency device: press a button and a distress signal is sent over
WiFi to the cloud, shown in real time on a monitoring web page, and optionally
forwarded to LINE. Built around the Seeed Studio XIAO ESP32-C5, with an ST7789
display and a Li-Po battery, in a watch form factor.

This document covers the whole project — design, wiring, deployment, and the
pitfalls actually hit during development.

---

## 1. System architecture

Data flow (the current prototype uses direct WiFi):

```
[Button pressed]
   → XIAO ESP32-C5 wakes
   → Screen shows "SENDING"
   → Connects to WiFi
   → HTTPS POST to backend /api/sos (event id, time, battery)
   → Backend writes to DB, returns 200
   → Screen shows "SENT OK"
   → Monitoring page updates in real time (every 3s)
   → (optional) Backend forwards a LINE notification
```

Three parts:

- **Edge (watch)**: `sos_watch.cpp`, Arduino/C++ firmware running on the XIAO ESP32-C5.
- **Backend (server)**: `server.js` + `package.json`, Node/Express, deployed on Railway.
- **Database**: PostgreSQL (Railway built-in, or Supabase).

> By design, "direct WiFi" is the test path and "BLE" is the production path.
> BLE can relay through a nearby phone when there's no WiFi outdoors, but it
> requires a phone app; for now direct WiFi is used to validate the full chain.

---

## 2. Bill of materials (BOM)

| Item | Spec / recommendation | Notes |
|---|---|---|
| XIAO ESP32-C5 | Pre-Soldered version | Dual-band WiFi 6 / BLE / 15µA deep sleep, built-in Li-Po charge management |
| ST7789 display | 1.3" 240×240 SPI | Most have no CS pin (CS tied on-module) |
| Button | Momentary, normally-open | Small side button for watch form factor |
| Li-Po battery | 3.7V, with protection board | Flat small-capacity for a watch (e.g. 302030, 150–300mAh) |
| Electrolytic cap | 100–470µF | Across BAT+/BAT- to prevent WiFi-transmit brownout (important, don't skip) |
| Enclosure | 3D-printed case + strap | 20mm spring-bar lugs |
| Wire, solder | Thin silicone wire | Solder thin wire directly for the watch build; avoid dupont headers (add height) |

No separate charging module is needed (the board charges via USB-C). WiFi and BLE
are both on-chip, so no external radio module is required.

---

## 3. Wiring

SPI uses the default hardware pins (D8=SCK, D10=MOSI). Other pins follow the
definitions at the top of `sos_watch.cpp`:

| Component / pin | Connect to XIAO ESP32-C5 |
|---|---|
| ST7789 VCC | 3V3 |
| ST7789 GND | GND |
| ST7789 SCL | SCK (D8) |
| ST7789 SDA | MOSI (D10) |
| ST7789 DC | D2 |
| ST7789 RES | D3 |
| ST7789 BLK (backlight) | D4 |
| ST7789 CS | none (firmware sets `TFT_CS = -1`) |
| Button | D1 ↔ GND (internal pull-up, LOW when pressed) |
| Li-Po battery | BAT+ / BAT- pads on the back |
| Battery voltage read | via on-board GPIO6 / GPIO26, no wiring |

Notes:

- **GND is shared**: display GND, button GND, and battery BAT- all go to the same
  GND net.
- **BAT pads are on the back of the board**; confirm polarity before soldering —
  reversing it will destroy the board.
- Battery voltage reading uses the board package's built-in macros
  `BAT_VOLT_PIN` (GPIO6) and `BAT_VOLT_PIN_EN` (GPIO26); the reading must be
  averaged and multiplied by 2 to compensate for the 1:2 divider.

---

## 4. Directory structure

```
/                      ← for Railway, server.js and package.json must be at this level
├── server.js          ← Backend (Express + PostgreSQL + monitoring page + LINE forwarding)
├── package.json       ← Dependencies and start command
├── sos_watch.cpp      ← Firmware (rename to .ino for Arduino IDE)
├── simulate.js        ← Local simulator: inject test data without an ESP32
└── README.md
```

> Deployment note: Railway looks for `package.json` at the repo root and runs
> `node server.js`. If the backend lives in a subfolder, set the Root Directory
> in the service Settings (see notes in section 7).

---

## 5. Firmware (sos_watch.cpp)

Behavior: on boot, connect WiFi and sync time via NTP → idle screen shows
status/time/battery → button press sends the distress POST → shows "SENT OK /
FAILED" based on the HTTP response.

Three values to edit before flashing:

```cpp
const char* WIFI_SSID = "your WiFi name";
const char* WIFI_PASS = "your WiFi password";
const char* SOS_URL   = "https://your-app.up.railway.app/api/sos";
```

Library to install: `Adafruit ST7789` (pulls in Adafruit GFX too).

Flashing steps:

1. Add the esp32 board package in Arduino IDE preferences; select board `XIAO_ESP32C5`.
2. **Connect the antenna first** (never enable WiFi without it — especially 5GHz,
   which can damage the RF circuitry).
3. Arduino IDE only accepts `.ino`: rename `sos_watch.cpp` to `sos_watch.ino`
   (or place it in a folder of the same name) before flashing; with PlatformIO,
   `.cpp` is the native format.

---

## 6. Backend (server.js)

An Express service exposing three endpoints:

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/sos` | Device uploads a distress event; writes to DB, returns 200 |
| GET | `/api/events` | Returns the latest 100 events (for the page to poll) |
| GET | `/` | Monitoring page (medical style, English default, switchable to Chinese) |

Design points:

- **Write to DB before returning 200**: for an emergency device, a 200 should
  mean "actually stored". If the DB write fails, it returns 500 and the device
  screen shows FAILED — it won't falsely tell the device it succeeded.
- **LINE is a decoupled side effect**: LINE is called fire-and-forget only after
  returning 200, and its failure doesn't affect the main path. If the env vars
  aren't set, it's skipped. So LINE can be added later independently without
  touching the firmware / screen / web page.
- On startup, `initDb()` runs `CREATE TABLE IF NOT EXISTS sos_events`
  automatically — no manual table creation needed.

---

## 7. Deploy to Railway

1. New Railway project → **Deploy from GitHub repo** → authorize and pick your repo.
2. Add a database: **+ New → Database → PostgreSQL** (or use Supabase, see section 8).
3. In your app service → **Variables → Add Reference Variable** → pick the
   Postgres service's `DATABASE_URL` (use a Reference Variable, don't type it manually).
4. **Settings → Networking → Generate Domain** to get a public URL (don't forget —
   without it neither the device nor you can reach the service).
5. Put that URL (with `/api/sos` appended) into the firmware's `SOS_URL`.

Pushing to GitHub afterward triggers an automatic redeploy on Railway.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (Railway: Reference Variable; Supabase: pooler string) |
| `PORT` | No | Injected by Railway automatically; already handled in code |
| `LINE_CHANNEL_TOKEN` | No | LINE Messaging API channel access token; no forwarding if unset |
| `LINE_TO` | No | LINE push target user id or group id |

---

## 8. Using Supabase as the database (optional)

Supabase is PostgreSQL under the hood, and the code uses standard `pg`, so almost
nothing changes — only two points:

1. **SSL must be enabled**: turn on SSL in the pool config in `server.js`:
   ```js
   const pool = new Pool({
     connectionString: process.env.DATABASE_URL,
     ssl: { rejectUnauthorized: false },
   });
   ```
2. **Use the Connection Pooler, not Direct**: in the Supabase Connect dialog,
   choose Connection Pooling (Transaction mode). The string's tell-tale signs are
   a host containing `pooler.supabase.com` and port `6543`. Direct
   (`db.xxx.supabase.co:5432`) fails on Railway with `ENETUNREACH` because it
   uses IPv6.

Paste the pooler string manually into Railway's `DATABASE_URL` (in this case it's
not a Reference Variable).

---

## 9. Local testing (no ESP32 needed)

The backend can't tell whether a request comes from the watch or a computer, so
test directly with curl:

```bash
curl -X POST https://your-app.up.railway.app/api/sos \
  -H "Content-Type: application/json" \
  -d '{"id":"test001","type":"sos","time":"15:47:00","battery_v":3.92,"battery_pct":78}'
```

A success returns `{"ok":true,"pk":...}`, and the page banner turns red with a new
card. `battery_pct <= 20` triggers the low-battery red warning style.

To push multiple events or simulate repeated triggers, use `simulate.js` (Node 18+):

```bash
SOS_URL="https://your-app.up.railway.app/api/sos" node simulate.js 5
```

The JSON fields it sends are identical to the firmware's, so a chain validated
locally behaves the same once the ESP32 is soldered.

---

## 10. Monitoring web page

- Medical style: bright background, centered layout, red-cross identity, large text.
- Idle shows a green "System on standby"; on a distress signal the whole banner
  turns red: "Emergency signal received".
- Auto-refreshes every 3 seconds, data from the DB.
- English by default; a top-right button switches to Traditional Chinese (static
  text, banner, cards, and time format all switch together).
- The language choice is not persisted (a refresh returns to English).

---

## 11. Notes and common errors

Issues actually encountered during development, with fixes:

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module '/app/server.js'` | `server.js` and `package.json` not in the same folder / not at repo root | Put both at the repo root, or set Root Directory in service Settings |
| `ECONNREFUSED ::1:5432` | `DATABASE_URL` not read, `pg` falls back to localhost | Attach the Postgres `DATABASE_URL` via a Reference Variable |
| `ENETUNREACH ...:5432` (IPv6) | Used the Supabase Direct connection (IPv6/5432), unreachable on Railway | Switch to the Pooler string (`pooler.supabase.com:6543`) |
| `Cannot POST /` | POST went to root `/`, which only accepts GET | POST to `/api/sos` instead |
| Garbled screen | SPI wiring issue (DC/RES or SCK/MOSI) | Check wiring; for inverted colors enable `tft.invertDisplay(true)`; fix orientation with `setRotation(0~3)` |
| WiFi won't connect / RF issues | Antenna not attached | Always attach the antenna before powering on |
| Device resets on press | WiFi transmit current spike causes brownout | Add a 100–470µF cap across BAT+/BAT- |

---

## 12. Known trade-offs (prototype stage)

Deliberately deferred; good to be aware of:

- Firmware uses `setInsecure()` to skip TLS certificate verification (tighten for production).
- Currently always on and connected to WiFi; no deep-sleep power saving (screen
  is also always on).
- No ack / retransmit state machine (one-way send).
- The monitoring page has no login / access control; anyone with the URL can view it.

---

## 13. Possible highlights to add (no new hardware)

All achievable with just the existing ESP32-C5 + display:

1. **WiFi positioning (no GPS)**: scan nearby WiFi access-point BSSIDs, send them
   to the Google Geolocation API to resolve latitude/longitude, and mark the
   requester's location on a map on the web page.
2. **Deep sleep + button wake**: measure standby current (targeting the ~15µA
   range), estimate battery life, turning a requirement into a data-backed
   experiment. The button then needs an external 10kΩ pull-down + 0.1µF debounce,
   wired to a wake-capable pin.
3. **Heartbeat / offline detection (dead-man's switch)**: the device sends a
   periodic heartbeat; if the backend expects one and doesn't receive it, it
   flags the device offline.
4. **Signed messages (anti-spoofing)**: use the chip's hardware crypto to HMAC
   each distress event; the backend verifies the signature to reject fake alarms.
5. **On-screen QR code**: show a QR while idle (victim info or a link to the live
   status page) for responders to scan. Generate the matrix with the `qrcode`
   library and draw it with `fillRect`; use dark modules on a light background,
   keep a quiet-zone margin, and keep the content short for scannability.

---

## Hardware spec reference

- MCU: ESP32-C5, RISC-V single-core up to 240 MHz, 384KB SRAM, 8MB Flash, 8MB PSRAM
- Wireless: dual-band WiFi 6 (2.4 / 5 GHz), Bluetooth 5 LE, IEEE 802.15.4 (Zigbee / Thread)
- Size: 21 × 17.8 mm (XIAO standard)
- Deep-sleep current: ~15µA
