/*
 * SOS Watch - Prototype firmware (XIAO ESP32-C5 + ST7789 240x240)
 * Display uses Arduino_GFX. Features:
 *   1) Wi-Fi connection indicator (signal bars, top-right)
 *   2) SOS event number feedback (No. #pk)
 *   3) Medical info page (long-press to switch)
 *   4) Personal/medical info uploaded together with the SOS
 *   5) Auto deep sleep after 60s idle, wake on button  <- new in this version
 *
 * Button interactions:
 *   Standby page  Short press = send SOS
 *   Any page      Long press 1.5s = switch to medical page / back to standby
 *   Medical page  Short press = back to standby
 *   After sleep   One press = wake (does NOT send SOS); press again to send
 *
 * Library: GFX Library for Arduino (Arduino_GFX)
 * Board  : XIAO_ESP32C5
 * Always connect the antenna before powering on!
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Arduino_GFX_Library.h>
#include <esp_sleep.h>
#include <time.h>

// ---------- Settings the user needs to change ----------
const char* WIFI_SSID = "wifi-ssid";
const char* WIFI_PASS = "password";

const char* SOS_URL   = "https://xxxxxx.up.railway.app/api/sos";

const long  GMT_OFFSET_SEC      = 8 * 3600;   // Taiwan GMT+8
const int   DAYLIGHT_OFFSET_SEC = 0;

// ---------- Medical info (static, ASCII only; CJK needs a separate font) ----------
#define MED_NAME     "Johnny Silver"
#define MED_BLOOD    "O+"
#define MED_ALLERGY  "Peanuts"
#define MED_COND     "Headache"
#define MED_ICE      "0912-345-678"

// ---------- Pins ----------
#define BTN_PIN     D0            // = GPIO1, deep-sleep wake pin
#define TFT_SCK     D8
#define TFT_MOSI    D10
#define TFT_DC      D6
#define TFT_RST     D5
#define TFT_BLK     D4

#define BAT_VOLT_PIN     6
#define BAT_VOLT_PIN_EN  26

// ---------- Sleep settings ----------
#define IDLE_TIMEOUT_MS  60000UL   // Idle 60s -> deep sleep
#define WAKE_GPIO_NUM    1         // D0 maps to GPIO1

// ---------- Colors ----------
#define COL_BG      RGB565_BLACK
#define COL_TITLE   0x8410
#define COL_IDLE    RGB565_CYAN
#define COL_SEND    RGB565_YELLOW
#define COL_OK      RGB565_GREEN
#define COL_FAIL    RGB565_RED
#define COL_TEXT    RGB565_WHITE

// ---------- Display objects ----------
Arduino_DataBus *bus = new Arduino_ESP32SPI(
    TFT_DC, GFX_NOT_DEFINED, TFT_SCK, TFT_MOSI, GFX_NOT_DEFINED);
Arduino_GFX *gfx = new Arduino_ST7789(
    bus, TFT_RST, 0, true /*IPS*/, 240, 240);

// ---------- State ----------
enum Page { PAGE_READY, PAGE_MEDICAL };
Page   currentPage  = PAGE_READY;
long   lastEventPk  = -1;
uint32_t eventCounter = 0;

// Button: debounce + long-press detection
int  lastReading = HIGH;
int  btnState    = HIGH;
unsigned long lastDebounceMs = 0;
unsigned long pressStartMs   = 0;
bool actedOnHold = false;
const unsigned long DEBOUNCE_MS = 40;
const unsigned long LONG_MS     = 1500;

unsigned long lastActivityMs = 0;   // Last activity time (for idle timer)

// ---------- Function prototypes ----------
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

// ---- Enter deep sleep: turn off backlight, clear screen, set button wake ----
void goToDeepSleep() {
  Serial.println("Idle timeout -> deep sleep");
  Serial.flush();
  
  gfx->displayOff(); 
  digitalWrite(TFT_BLK, LOW);          // Turn off backlight (key power saving)
  gfx->fillScreen(COL_BG);             // Clear to black
  digitalWrite(BAT_VOLT_PIN_EN, LOW);  // Disable battery-sense enable to cut leakage

  // D0 = GPIO1, pressed = LOW -> wake on low level (this mode enables internal pull-up on the pin)
  esp_deep_sleep_enable_gpio_wakeup(1ULL << WAKE_GPIO_NUM, ESP_GPIO_WAKEUP_GPIO_LOW);
  esp_deep_sleep_start();              // Sleep now; nothing runs after this
}

void setup() {
  Serial.begin(115200);

  // Were we woken from deep sleep by the button?
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  bool wokeFromButton = (cause == ESP_SLEEP_WAKEUP_GPIO);

  pinMode(BAT_VOLT_PIN, INPUT);
  pinMode(BAT_VOLT_PIN_EN, OUTPUT);
  digitalWrite(BAT_VOLT_PIN_EN, HIGH);

  pinMode(BTN_PIN, INPUT_PULLUP);

  pinMode(TFT_BLK, OUTPUT);
  digitalWrite(TFT_BLK, HIGH);

  if (!gfx->begin()) Serial.println("gfx->begin() failed - check wiring");

  // Only run the red/green/blue self-test on a cold boot; skip it on button wake for faster wake-up
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

  // Consume the "wake press": wait for release so the loop below doesn't treat it as an SOS
  while (digitalRead(BTN_PIN) == LOW) delay(10);
  lastReading    = HIGH;
  btnState       = HIGH;
  actedOnHold    = false;
  lastActivityMs = millis();           // Start counting idle from now
}

void loop() {
  int reading = digitalRead(BTN_PIN);
  unsigned long now = millis();

  if (reading != lastReading) { lastDebounceMs = now; lastReading = reading; }

  if (now - lastDebounceMs > DEBOUNCE_MS && reading != btnState) {
    btnState = reading;
    lastActivityMs = now;              // Activity -> reset idle timer
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
        lastActivityMs = millis();     // The action may take time; reset idle timer afterward
      }
    }
  }

  if (btnState == LOW && !actedOnHold && now - pressStartMs >= LONG_MS) {
    currentPage = (currentPage == PAGE_READY) ? PAGE_MEDICAL : PAGE_READY;
    redrawCurrent();
    actedOnHold = true;
    lastActivityMs = now;              // A long press counts as activity too
  }

  // Refresh the standby page every 5s
  static unsigned long lastRefresh = 0;
  if (currentPage == PAGE_READY && btnState == HIGH && now - lastRefresh > 5000) {
    lastRefresh = now;
    redrawCurrent();
  }

  // Idle timeout and button not pressed -> deep sleep
  if (btnState == HIGH && now - lastActivityMs > IDLE_TIMEOUT_MS) {
    goToDeepSleep();
  }
}
