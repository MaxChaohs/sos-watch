/*
 * SOS Watch - Prototype 韌體 (XIAO ESP32-C5 + ST7789 240x240)
 * 顯示用 Arduino_GFX。功能：
 *   1) Wi-Fi 連線指示（右上角訊號格）
 *   2) 求救編號回饋（No. #pk）
 *   3) 醫療資訊頁（長按切換）
 *   4) 個人/醫療資訊隨求救上傳
 *   5) 閒置 60 秒自動深度睡眠，按鈕喚醒  ← 本版新增
 *
 * 按鈕互動：
 *   待機頁 短按 = 送出求救
 *   任一頁 長按 1.5s = 切醫療頁 / 回待機
 *   醫療頁 短按 = 回待機
 *   睡眠後 按一下 = 喚醒（不送求救）；醒來後再按才送
 *
 * 函式庫：GFX Library for Arduino (Arduino_GFX)
 * Board : XIAO_ESP32C5
 * 上電前務必接上天線！
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Arduino_GFX_Library.h>
#include <esp_sleep.h>
#include <time.h>

// ---------- 使用者要改的設定 ----------
const char* WIFI_SSID = "wifi-ssid";
const char* WIFI_PASS = "password";

const char* SOS_URL   = "https://xxxxxx.up.railway.app/api/sos";

const long  GMT_OFFSET_SEC      = 8 * 3600;   // 台灣 GMT+8
const int   DAYLIGHT_OFFSET_SEC = 0;

// ---------- 醫療資訊（靜態，填 ASCII；中文需另掛字型）----------
#define MED_NAME     "Johnny Silver"
#define MED_BLOOD    "O+"
#define MED_ALLERGY  "Peanuts"
#define MED_COND     "Headache"
#define MED_ICE      "0912-345-678"

// ---------- 腳位 ----------
#define BTN_PIN     D0            // = GPIO1，深度睡眠喚醒腳
#define TFT_SCK     D8
#define TFT_MOSI    D10
#define TFT_DC      D6
#define TFT_RST     D5
#define TFT_BLK     D4

#define BAT_VOLT_PIN     6
#define BAT_VOLT_PIN_EN  26

// ---------- 睡眠設定 ----------
#define IDLE_TIMEOUT_MS  60000UL   // 閒置 60 秒 -> 深度睡眠
#define WAKE_GPIO_NUM    1         // D0 對應 GPIO1

// ---------- 顏色 ----------
#define COL_BG      RGB565_BLACK
#define COL_TITLE   0x8410
#define COL_IDLE    RGB565_CYAN
#define COL_SEND    RGB565_YELLOW
#define COL_OK      RGB565_GREEN
#define COL_FAIL    RGB565_RED
#define COL_TEXT    RGB565_WHITE

// ---------- 顯示物件 ----------
Arduino_DataBus *bus = new Arduino_ESP32SPI(
    TFT_DC, GFX_NOT_DEFINED, TFT_SCK, TFT_MOSI, GFX_NOT_DEFINED);
Arduino_GFX *gfx = new Arduino_ST7789(
    bus, TFT_RST, 0, true /*IPS*/, 240, 240);

// ---------- 狀態 ----------
enum Page { PAGE_READY, PAGE_MEDICAL };
Page   currentPage  = PAGE_READY;
long   lastEventPk  = -1;
uint32_t eventCounter = 0;

// 按鈕：debounce + 長按偵測
int  lastReading = HIGH;
int  btnState    = HIGH;
unsigned long lastDebounceMs = 0;
unsigned long pressStartMs   = 0;
bool actedOnHold = false;
const unsigned long DEBOUNCE_MS = 40;
const unsigned long LONG_MS     = 1500;

unsigned long lastActivityMs = 0;   // 最後一次操作時間（給閒置計時用）

// ---------- 函式原型 ----------
float  readBatteryVolts();
int    batteryPercent(float v);
String nowTimeStr();
int    wifiLevel();
void   drawWifiIcon(int x, int y);
void   drawReady(const char* status, uint16_t statusColor);
void   drawField(const char* label, const char* value, int y);
void   drawMedical();
void   redrawCurrent();
long   parsePk(const String& json);
bool   ensureWiFi();
bool   sendSOS();
void   goToDeepSleep();

// ---------------------------------------------------------------------------

float readBatteryVolts() {
  digitalWrite(BAT_VOLT_PIN_EN, HIGH);
  delay(10);
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(BAT_VOLT_PIN);
  return 2.0f * sum / 16.0f / 1000.0f;
}

int batteryPercent(float v) {
  int pct = (int)((v - 3.30f) / (4.20f - 3.30f) * 100.0f);
  if (pct < 0)   pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

String nowTimeStr() {
  struct tm t;
  if (!getLocalTime(&t, 100)) return "--:--:--";
  char buf[16];
  strftime(buf, sizeof(buf), "%H:%M:%S", &t);
  return String(buf);
}

int wifiLevel() {
  if (WiFi.status() != WL_CONNECTED) return 0;
  long r = WiFi.RSSI();
  if (r >= -55) return 4;
  if (r >= -65) return 3;
  if (r >= -75) return 2;
  return 1;
}

void drawWifiIcon(int x, int y) {
  int level = wifiLevel();
  uint16_t on  = COL_OK;
  uint16_t off = COL_TITLE;
  const int bw = 6, gap = 3;
  const int heights[4] = {6, 10, 14, 18};
  for (int i = 0; i < 4; i++) {
    int bx = x + i * (bw + gap);
    int bh = heights[i];
    int by = y + (18 - bh);
    gfx->fillRect(bx, by, bw, bh, (i < level) ? on : off);
  }
  if (level == 0) {
    gfx->setTextColor(COL_FAIL);
    gfx->setTextSize(2);
    gfx->setCursor(x + 4 * (bw + gap), y);
    gfx->print("x");
  }
}

void drawReady(const char* status, uint16_t statusColor) {
  gfx->fillScreen(COL_BG);
  gfx->setTextColor(COL_TITLE);
  gfx->setTextSize(2);
  gfx->setCursor(12, 12);
  gfx->print("SOS");
  drawWifiIcon(196, 12);

  gfx->setTextColor(statusColor);
  gfx->setTextSize(3);
  int16_t x1, y1; uint16_t w, h;
  gfx->getTextBounds(status, 0, 0, &x1, &y1, &w, &h);
  gfx->setCursor((240 - w) / 2, 82);
  gfx->print(status);

  gfx->setTextColor(COL_TEXT);
  gfx->setTextSize(2);
  gfx->setCursor(30, 150);
  gfx->print("Time ");
  gfx->print(nowTimeStr());

  float v = readBatteryVolts();
  int pct = batteryPercent(v);
  gfx->setCursor(30, 180);
  gfx->print("Batt ");
  gfx->print(pct); gfx->print("% ");
  gfx->print(v, 2); gfx->print("V");

  if (lastEventPk >= 0) {
    gfx->setTextColor(COL_TITLE);
    gfx->setTextSize(2);
    gfx->setCursor(30, 210);
    gfx->print("No. #");
    gfx->print(lastEventPk);
  }
}

void drawField(const char* label, const char* value, int y) {
  gfx->setTextColor(COL_TITLE);
  gfx->setTextSize(1);
  gfx->setCursor(12, y);
  gfx->print(label);
  gfx->setTextColor(COL_TEXT);
  gfx->setTextSize(2);
  gfx->setCursor(12, y + 10);
  gfx->print(value);
}

void drawMedical() {
  gfx->fillScreen(COL_BG);
  gfx->fillRect(0, 0, 240, 34, COL_FAIL);
  gfx->setTextColor(RGB565_WHITE);
  gfx->setTextSize(2);
  gfx->setCursor(10, 9);
  gfx->print("MEDICAL INFO");

  int y = 46;
  drawField("NAME",    MED_NAME,    y); y += 34;
  drawField("BLOOD",   MED_BLOOD,   y); y += 34;
  drawField("ALLERGY", MED_ALLERGY, y); y += 34;
  drawField("COND.",   MED_COND,    y); y += 34;
  drawField("ICE",     MED_ICE,     y);

  gfx->setTextColor(COL_TITLE);
  gfx->setTextSize(1);
  gfx->setCursor(12, 226);
  gfx->print("Press: back   Hold: toggle");
}

void redrawCurrent() {
  if (currentPage == PAGE_READY) drawReady("READY", COL_IDLE);
  else                           drawMedical();
}

long parsePk(const String& json) {
  int i = json.indexOf("\"pk\"");
  if (i < 0) return -1;
  i = json.indexOf(':', i);
  if (i < 0) return -1;
  i++;
  while (i < (int)json.length() && json[i] == ' ') i++;
  long v = 0; bool any = false;
  while (i < (int)json.length() && json[i] >= '0' && json[i] <= '9') {
    v = v * 10 + (json[i] - '0'); i++; any = true;
  }
  return any ? v : -1;
}

bool ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) delay(250);
  return WiFi.status() == WL_CONNECTED;
}

bool sendSOS() {
  drawReady("SENDING", COL_SEND);

  if (!ensureWiFi()) {
    drawReady("NO WIFI", COL_FAIL);
    return false;
  }

  float v = readBatteryVolts();
  int pct = batteryPercent(v);
  eventCounter++;

  String body = "{";
  body += "\"id\":\"" + String((uint32_t)esp_random(), HEX) + String(eventCounter) + "\",";
  body += "\"type\":\"sos\",";
  body += "\"time\":\"" + nowTimeStr() + "\",";
  body += "\"battery_v\":" + String(v, 2) + ",";
  body += "\"battery_pct\":" + String(pct) + ",";
  body += "\"profile\":{";
  body += "\"name\":\""    MED_NAME    "\",";
  body += "\"blood\":\""   MED_BLOOD   "\",";
  body += "\"allergy\":\"" MED_ALLERGY "\",";
  body += "\"cond\":\""    MED_COND    "\",";
  body += "\"ice\":\""     MED_ICE     "\"";
  body += "}";
  body += "}";

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.begin(client, SOS_URL);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(8000);

  int code = http.POST(body);
  String resp = http.getString();
  http.end();

  Serial.printf("POST -> HTTP %d, body=%s\n", code, resp.c_str());

  if (code >= 200 && code < 300) {
    long pk = parsePk(resp);
    if (pk >= 0) lastEventPk = pk;
    drawReady("SENT OK", COL_OK);
    return true;
  } else {
    drawReady("FAILED", COL_FAIL);
    return false;
  }
}

// ---- 進入深度睡眠：關背光、清畫面、設定按鈕喚醒 ----
void goToDeepSleep() {
  Serial.println("閒置逾時 -> 深度睡眠");
  Serial.flush();
  
  gfx->displayOff(); 
  digitalWrite(TFT_BLK, LOW);          // 關背光（省電關鍵）
  gfx->fillScreen(COL_BG);             // 清成黑畫面
  digitalWrite(BAT_VOLT_PIN_EN, LOW);  // 關電量致能，少一點漏電

  // D0 = GPIO1，按下為 LOW -> 低電位喚醒（此模式會內部上拉此腳）
  esp_deep_sleep_enable_gpio_wakeup(1ULL << WAKE_GPIO_NUM, ESP_GPIO_WAKEUP_GPIO_LOW);
  esp_deep_sleep_start();              // 睡下去，之後不再執行
}

void setup() {
  Serial.begin(115200);

  // 是不是被按鈕從深度睡眠叫醒的
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  bool wokeFromButton = (cause == ESP_SLEEP_WAKEUP_GPIO);

  pinMode(BAT_VOLT_PIN, INPUT);
  pinMode(BAT_VOLT_PIN_EN, OUTPUT);
  digitalWrite(BAT_VOLT_PIN_EN, HIGH);

  pinMode(BTN_PIN, INPUT_PULLUP);

  pinMode(TFT_BLK, OUTPUT);
  digitalWrite(TFT_BLK, HIGH);

  if (!gfx->begin()) Serial.println("gfx->begin() 失敗 — 檢查接線");

  // 只有「冷開機」才跑紅綠藍自檢；被按鈕喚醒時跳過，讓喚醒更快
  if (!wokeFromButton) {
    gfx->fillScreen(RGB565_RED);   delay(400);
    gfx->fillScreen(RGB565_GREEN); delay(400);
    gfx->fillScreen(RGB565_BLUE);  delay(400);
  }
  gfx->fillScreen(COL_BG);

  gfx->setTextColor(COL_TEXT);
  gfx->setTextSize(2);
  gfx->setCursor(20, 110);
  gfx->print("WiFi...");

  if (ensureWiFi()) {
    configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, "pool.ntp.org", "time.google.com");
  }

  currentPage = PAGE_READY;
  redrawCurrent();

  // 消化「喚醒的那次按壓」：等放開，避免被下面的 loop 當成一次求救
  while (digitalRead(BTN_PIN) == LOW) delay(10);
  lastReading    = HIGH;
  btnState       = HIGH;
  actedOnHold    = false;
  lastActivityMs = millis();           // 從現在開始算閒置
}

void loop() {
  int reading = digitalRead(BTN_PIN);
  unsigned long now = millis();

  if (reading != lastReading) { lastDebounceMs = now; lastReading = reading; }

  if (now - lastDebounceMs > DEBOUNCE_MS && reading != btnState) {
    btnState = reading;
    lastActivityMs = now;              // 有操作 -> 重置閒置計時
    if (btnState == LOW) {
      pressStartMs = now;
      actedOnHold  = false;
    } else {
      if (!actedOnHold) {
        if (currentPage == PAGE_READY) {
          sendSOS();
          delay(2500);
          currentPage = PAGE_READY;
          redrawCurrent();
        } else {
          currentPage = PAGE_READY;
          redrawCurrent();
        }
        lastActivityMs = millis();     // 動作可能耗時，回來後重置閒置計時
      }
    }
  }

  if (btnState == LOW && !actedOnHold && now - pressStartMs >= LONG_MS) {
    currentPage = (currentPage == PAGE_READY) ? PAGE_MEDICAL : PAGE_READY;
    redrawCurrent();
    actedOnHold = true;
    lastActivityMs = now;              // 長按也算操作
  }

  // 待機頁每 5 秒刷新
  static unsigned long lastRefresh = 0;
  if (currentPage == PAGE_READY && btnState == HIGH && now - lastRefresh > 5000) {
    lastRefresh = now;
    redrawCurrent();
  }

  // 閒置逾時且按鈕未按下 -> 深度睡眠
  if (btnState == HIGH && now - lastActivityMs > IDLE_TIMEOUT_MS) {
    goToDeepSleep();
  }
}
