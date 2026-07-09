/*
 * SOS Watch - Prototype 韌體 (XIAO ESP32-C5 + ST7789 240x240)
 * 流程: 按鈕 -> WiFi -> HTTPS POST 到 Railway -> 螢幕顯示 狀態/時間/電量
 *
 * 這是 prototype: 一直開機連著 WiFi，不做深睡/背光電源閘/重送。
 * 那些等 happy path 跑通後再加。
 *
 * 需要的函式庫 (Arduino IDE 函式庫管理員安裝):
 *   - Adafruit ST7789 (會一併裝 Adafruit GFX)
 *   Board: "XIAO_ESP32C5" (先在偏好設定加 esp32 board 套件)
 *
 * 上電前務必接上天線！
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <SPI.h>
#include <time.h>

// ---------- 使用者要改的設定 ----------
const char* WIFI_SSID = "你的WiFi名稱";
const char* WIFI_PASS = "你的WiFi密碼";

// Railway 部署後給你的公開網址 + 路徑，例如 https://xxxx.up.railway.app/api/sos
const char* SOS_URL   = "https://你的專案.up.railway.app/api/sos";

// 台灣時區 GMT+8
const long  GMT_OFFSET_SEC      = 8 * 3600;
const int   DAYLIGHT_OFFSET_SEC = 0;

// ---------- 腳位 ----------
// 按鈕: 一腳接此 GPIO，另一腳接 GND (用內部上拉，按下為 LOW)
#define BTN_PIN     D1

// ST7789 SPI 接線 (SCK/MOSI 用預設硬體 SPI: D8=SCK, D10=MOSI)
// 你這片 1.3" 240x240 多半沒有 CS 腳 -> CS 設 -1
#define TFT_CS      -1
#define TFT_DC      D2
#define TFT_RST     D3
#define TFT_BLK     D4   // 背光: prototype 先一直亮; 之後省電再改由此腳關背光

// 電池電壓 (XIAO ESP32-C5 官方定義, 巨集由板子套件提供)
//   BAT_VOLT_PIN    = GPIO6
//   BAT_VOLT_PIN_EN = GPIO26
// 若你的板子套件沒定義這兩個巨集，取消下面兩行註解手動指定:
// #define BAT_VOLT_PIN    6
// #define BAT_VOLT_PIN_EN 26

// ---------- 顏色 ----------
#define COL_BG      ST77XX_BLACK
#define COL_TITLE   0x8410            // 灰
#define COL_IDLE    ST77XX_CYAN
#define COL_SEND    ST77XX_YELLOW
#define COL_OK      ST77XX_GREEN
#define COL_FAIL    ST77XX_RED
#define COL_TEXT    ST77XX_WHITE

Adafruit_ST7789 tft = Adafruit_ST7789(&SPI, TFT_CS, TFT_DC, TFT_RST);

uint32_t eventCounter = 0;

// 按鈕消抖
int  lastBtnReading = HIGH;
int  stableBtnState = HIGH;
unsigned long lastDebounceMs = 0;
const unsigned long DEBOUNCE_MS = 40;

// ---------------------------------------------------------------------------

float readBatteryVolts() {
  digitalWrite(BAT_VOLT_PIN_EN, HIGH);
  delay(10);
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) {
    sum += analogReadMilliVolts(BAT_VOLT_PIN);
  }
  // 1:2 分壓 -> 乘 2；平均 16 次；mV -> V
  return 2.0f * sum / 16.0f / 1000.0f;
}

int batteryPercent(float v) {
  // 粗略線性估計: 3.30V=0%, 4.20V=100%
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

// 畫一整個畫面
void drawScreen(const char* status, uint16_t statusColor) {
  tft.fillScreen(COL_BG);

  // 標題
  tft.setTextColor(COL_TITLE);
  tft.setTextSize(2);
  tft.setCursor(90, 12);
  tft.print("SOS");

  // 狀態 (大字, 置中偏上)
  tft.setTextColor(statusColor);
  tft.setTextSize(3);
  int16_t x1, y1; uint16_t w, h;
  tft.getTextBounds(status, 0, 0, &x1, &y1, &w, &h);
  tft.setCursor((240 - w) / 2, 90);
  tft.print(status);

  // 時間
  tft.setTextColor(COL_TEXT);
  tft.setTextSize(2);
  tft.setCursor(30, 160);
  tft.print("Time ");
  tft.print(nowTimeStr());

  // 電量
  float v   = readBatteryVolts();
  int   pct = batteryPercent(v);
  tft.setCursor(30, 190);
  tft.print("Batt ");
  tft.print(pct);
  tft.print("% ");
  tft.print(v, 2);
  tft.print("V");
}

bool ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
  }
  return WiFi.status() == WL_CONNECTED;
}

// 送出一筆 SOS，回傳是否成功 (HTTP 2xx)
bool sendSOS() {
  drawScreen("SENDING", COL_SEND);

  if (!ensureWiFi()) {
    drawScreen("NO WIFI", COL_FAIL);
    return false;
  }

  float v   = readBatteryVolts();
  int   pct = batteryPercent(v);
  eventCounter++;

  // 組 JSON payload
  String body = "{";
  body += "\"id\":\"" + String((uint32_t)esp_random(), HEX) + String(eventCounter) + "\",";
  body += "\"type\":\"sos\",";
  body += "\"time\":\"" + nowTimeStr() + "\",";
  body += "\"battery_v\":" + String(v, 2) + ",";
  body += "\"battery_pct\":" + String(pct);
  body += "}";

  // prototype: 略過憑證驗證 (正式版再收緊)
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.begin(client, SOS_URL);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(8000);

  int code = http.POST(body);
  http.end();

  Serial.printf("POST -> HTTP %d\n", code);

  if (code >= 200 && code < 300) {
    drawScreen("SENT OK", COL_OK);
    return true;
  } else {
    drawScreen("FAILED", COL_FAIL);
    return false;
  }
}

void setup() {
  Serial.begin(115200);

  // 電池讀取致能
  pinMode(BAT_VOLT_PIN, INPUT);
  pinMode(BAT_VOLT_PIN_EN, OUTPUT);
  digitalWrite(BAT_VOLT_PIN_EN, HIGH);

  // 按鈕
  pinMode(BTN_PIN, INPUT_PULLUP);

  // 背光 (prototype 先一直亮)
  pinMode(TFT_BLK, OUTPUT);
  digitalWrite(TFT_BLK, HIGH);

  // 螢幕
  tft.init(240, 240);
  tft.setRotation(0);          // 畫面方向不對就改 0~3
  // tft.invertDisplay(true);  // 顏色反相/發白時試著打開
  tft.fillScreen(COL_BG);

  tft.setTextColor(COL_TEXT);
  tft.setTextSize(2);
  tft.setCursor(20, 110);
  tft.print("WiFi...");

  // 連 WiFi + 校時
  if (ensureWiFi()) {
    configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, "pool.ntp.org", "time.google.com");
  }

  drawScreen("READY", COL_IDLE);
}

void loop() {
  // 按鈕消抖 (偵測按下瞬間: HIGH -> LOW)
  int reading = digitalRead(BTN_PIN);
  if (reading != lastBtnReading) {
    lastDebounceMs = millis();
  }
  if (millis() - lastDebounceMs > DEBOUNCE_MS) {
    if (reading != stableBtnState) {
      stableBtnState = reading;
      if (stableBtnState == LOW) {          // 按下
        sendSOS();
        delay(2500);                         // 讓結果停留一下
        drawScreen("READY", COL_IDLE);
      }
    }
  }
  lastBtnReading = reading;

  // 每 30 秒更新一次待機畫面 (刷新時間/電量)
  static unsigned long lastRefresh = 0;
  if (stableBtnState == HIGH && millis() - lastRefresh > 30000) {
    lastRefresh = millis();
    drawScreen("READY", COL_IDLE);
  }
}
