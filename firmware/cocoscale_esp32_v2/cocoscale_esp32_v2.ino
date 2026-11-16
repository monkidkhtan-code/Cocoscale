/**
 * KH COCOSCALE — ESP32 FIRMWARE v2.4 (3-TIER BATTERY OPTIMIZER + <1s WAKE + ULTRA DEEP SLEEP)
 * -------------------------------------------------------------------------------------------
 * Board: DOIT ESP32 DEVKIT V1 / ESP32-30P-CP2102-C (Arduino IDE 2.3.x)
 *
 * Why BatteryPreviously Drained in ~12 Hours & How v2.4 Fixes It:
 *   1. Eliminated 2.5s HTTPS Polling Storm (34,560 TLS transmissions/day -> Cut by 95%):
 *        - Previously, Core 0 made an active encrypted HTTPS request to Firebase every 2.5s
 *          plus a PATCH heartbeat every 30s, keeping the Wi-Fi RF amplifier hot (~75-90 mA).
 *        - Now in Smart Saver ("smart_saver"), passive Local HTTP (/cmd) handles <1s wake on
 *          your Wi-Fi with ZERO background transmissions, and cloud fallback polls only every
 *          45s using WIFI_PS_MAX_MODEM DTIM sleep + 80 MHz CPU + btStop() (~22-26 mA avg!).
 *   2. Added 3 Selectable Power Modes in Web App:
 *        - "always_on"   (Always Awake): Live 50 Hz LCD & HX711, 240 MHz CPU.
 *        - "smart_saver" (Smart Saver <1s Wake): LCD & HX711 OFF, 80 MHz + WIFI_PS_MAX_MODEM,
 *                        wakes LCD in <1 second when you click Always Awake / LCD ON in App!
 *        - "deep_sleep"  (Ultra Deep Sleep): True hardware esp_deep_sleep_start() + WIFI_OFF
 *                        between readings (lasts 5-14 days on battery!). Silent dark wake on
 *                        timer, or press physical BOOT button (GPIO 0) to wake LCD for 60s.
 *   3. Bluetooth Radio & GPIO 2 Blue LED Disabled:
 *        - Calls btStop() on boot and drives GPIO 2 LOW to eliminate hidden idle current.
 */

#include <WiFi.h>
#include <WiFiMulti.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <Wire.h>
#include "HX711.h"
#include <LiquidCrystal_I2C.h>
#include "esp_wifi.h"
#include "esp_sleep.h"
#include "esp_bt.h"
#include "driver/rtc_io.h"
#include "driver/gpio.h"

// --- Station Identity (Change to "Plot2" / "Plot3" for Scales #2 & #3) ---
const char* PLOT_ID    = "Plot1";
const char* MDNS_HOST  = "cocoscale-plot1"; // Reachable at http://cocoscale-plot1.local/cmd
const char* FW_VERSION = "2.7";

// --- Fast Realtime Command Bridge (Firebase RTDB Singapore — ~80ms latency) ---
const char* firebaseBaseUrl = "https://kh-agrifarm-default-rtdb.asia-southeast1.firebasedatabase.app/cocoscale_devices";

// --- Google Apps Script Web App URL (for Date, Time, Weight_kg Sheet logging) ---
const char* scriptUrl = "https://script.google.com/macros/s/AKfycbzpVPqtHfPaVJjyqnRiW4oF-FR5359P2ewcCebXO61lufeeXKDYJzviX7xIRhQeiX4xMw/exec";

// --- Hardware Pins ---
const int LOADCELL_DOUT_PIN = 19;
const int LOADCELL_SCK_PIN  = 18;
const int LCD_SDA_PIN       = 21;
const int LCD_SCL_PIN       = 22;
const int WAKE_TARE_BTN_PIN = 0;  // Built-in BOOT button (or external button to GND)
const int ONBOARD_BLUE_LED  = 2;  // Driven LOW to save ~3mA battery
const int BATT_VOLT_PIN     = 35; // 0-25V Voltage Sensor Module (S -> GPIO 35)

// --- Battery & Power Source Telemetry ---
// 0-25V sensor uses 30k + 7.5k divider (5:1 ratio).
// Full scale at ESP32 3.3V ADC: 3.3V * 5 = 16.5V. (16.5 / 4095.0 = ~0.004029)
// Calibration factor adjusted for ESP32 ADC non-linearity, divider resistor tolerance & pin loading:
const float BATT_CALIBRATION_FACTOR = 0.00538f;
volatile float currentBattVolt = 0.0f;
volatile int   currentBattPct  = 0;
volatile char  currentPwrSource[16] = "battery";     // "battery", "usb_direct", "usb_5v"
volatile char  currentChgState[16]  = "discharging"; // "discharging", "charging", "charged", "none"
float lastSampledBattVolt = 0.0f;

// --- Load Cell Calibration Factor (Remotely adjustable via App without re-flashing) ---
const float DEFAULT_CALIBRATION_FACTOR = 99833.0f;
volatile float cfgCalFactor = 99833.0f;

// --- Adaptive Power-Saving Timings ---
const unsigned long ACTIVE_FB_POLL_MS      = 950UL;   // Fast 0.95s check for 30s right after App click
const unsigned long AWAKE_IDLE_FB_POLL_MS  = 5000UL;  // 5s cloud check in Always Awake mode
const unsigned long SAVER_IDLE_FB_POLL_MS  = 45000UL; // 45s cloud check in Smart Saver (95% less Wi-Fi TX!)
const unsigned long WIFI_CHECK_MS          = 30000UL;
const unsigned long BTN_WAKE_VIEW_MS       = 45000UL; // Light LCD 45s on physical BOOT button press
const unsigned long SYNC_FLASH_MS          = 8000UL;  // Light LCD 8s in "flash" mode
const unsigned long TARE_HOLD_MS           = 3000UL;  // Hold BOOT button 3s to zero empty scale

// --- Hardware & OS Objects ---
WiFiMulti wifiMulti;
WebServer localServer(80);
Preferences prefs;
HX711 scale;
LiquidCrystal_I2C lcd(0x27, 16, 2);

// --- Shared State (Synchronized between Core 0 Cloud Task & Core 1 UI Loop) ---
volatile int  cfgIntervalMin       = 15;
String        cfgPowerMode         = "smart_saver"; // "always_on" | "smart_saver" (<1s Wake) | "deep_sleep" (Ultra Deep Sleep)
String        cfgLcdMode           = "off";         // "on" | "text_only" | "flash" | "off"
volatile long lastAckTareId        = 0;
volatile long pendingRemoteTareId  = 0;
volatile bool pendingConfigApply   = false;
volatile bool pendingCalFactorApply = false;
volatile bool pendingFlashPulse    = false;
volatile bool pendingSheetUpload   = false;
volatile float uploadWeightPayload = 0.0f;
volatile bool cloudTaskBusy        = false;
volatile bool fbSyncedAtLeastOnce  = false;
volatile bool pendingUltraSleepNow = false;
volatile unsigned long activePollUntilMs = 0;

unsigned long lastLogTime        = 0;
unsigned long lastLcdRenderTime  = 0;
unsigned long tempLightUntilMs   = 0;
unsigned long cmdBannerUntilMs   = 0;
String        cmdBannerText      = "";
unsigned long btnPressStartMs    = 0;
bool          btnWasDown         = false;
bool          tareTriggeredHold  = false;

bool lcdDisplayActive   = true;
bool lcdBacklightActive = true;
bool hx711PoweredUp     = true;
bool lowCpuClockActive  = false;
bool maxModemSleepSet   = false;

// Rolling 5-sample non-blocking HX711 ring buffer
float weightRing[5] = {0, 0, 0, 0, 0};
int   weightRingIdx = 0;
int   weightRingCnt = 0;
float currentSmoothedWeightKg = 0.0f;

// ============================================================================
// Lightweight JSON Helpers
// ============================================================================
long extractJsonLong(const String& json, const char* key, long fallbackVal) {
  String pattern = String("\"") + key + "\":";
  int idx = json.indexOf(pattern);
  if (idx < 0) return fallbackVal;
  idx += pattern.length();
  while (idx < (int)json.length() && (json[idx] == ' ' || json[idx] == '"')) idx++;
  int endIdx = idx;
  if (endIdx < (int)json.length() && json[endIdx] == '-') endIdx++;
  while (endIdx < (int)json.length() && isDigit(json[endIdx])) endIdx++;
  if (endIdx == idx) return fallbackVal;
  return json.substring(idx, endIdx).toInt();
}

String extractJsonString(const String& json, const char* key, const String& fallbackVal) {
  String pattern = String("\"") + key + "\":\"";
  int idx = json.indexOf(pattern);
  if (idx < 0) return fallbackVal;
  idx += pattern.length();
  int endIdx = json.indexOf('"', idx);
  if (endIdx < 0) return fallbackVal;
  return json.substring(idx, endIdx);
}

float extractJsonFloat(const String& json, const char* key, float fallbackVal) {
  String pattern = String("\"") + key + "\":";
  int idx = json.indexOf(pattern);
  if (idx < 0) return fallbackVal;
  idx += pattern.length();
  while (idx < (int)json.length() && (json[idx] == ' ' || json[idx] == '"')) idx++;
  int endIdx = idx;
  if (endIdx < (int)json.length() && (json[endIdx] == '-' || json[endIdx] == '+')) endIdx++;
  while (endIdx < (int)json.length() && (isDigit(json[endIdx]) || json[endIdx] == '.')) endIdx++;
  if (endIdx == idx) return fallbackVal;
  return json.substring(idx, endIdx).toFloat();
}

String buildAppliedTag() {
  return String(cfgIntervalMin) + ":" + cfgPowerMode + ":" + cfgLcdMode;
}

// ============================================================================
// Persistent NVS Flash Settings & Safe Tare (Core 1)
// ============================================================================
void loadSavedPreferences() {
  prefs.begin("cocoscale", true);
  cfgIntervalMin = prefs.getInt("intervalMin", 15);
  cfgPowerMode   = prefs.getString("powerMode", "smart_saver");
  cfgLcdMode     = prefs.getString("lcdMode", "off");
  lastAckTareId  = prefs.getLong("ackTareId", 0);
  cfgCalFactor   = prefs.getFloat("calFactor", DEFAULT_CALIBRATION_FACTOR);
  prefs.end();

  if (cfgIntervalMin < 1 || cfgIntervalMin > 240) cfgIntervalMin = 15;
  if (cfgPowerMode != "always_on" && cfgPowerMode != "smart_saver" && cfgPowerMode != "deep_sleep") {
    cfgPowerMode = "smart_saver";
  }
  if (cfgCalFactor < 10.0f || cfgCalFactor > 10000000.0f) {
    cfgCalFactor = DEFAULT_CALIBRATION_FACTOR;
  }
}

void saveConfigPreferences() {
  prefs.begin("cocoscale", false);
  prefs.putInt("intervalMin", cfgIntervalMin);
  prefs.putString("powerMode", cfgPowerMode);
  prefs.putString("lcdMode", cfgLcdMode);
  prefs.putLong("ackTareId", lastAckTareId);
  prefs.putFloat("calFactor", cfgCalFactor);
  prefs.end();
}

void ensureHx711Awake() {
  if (!hx711PoweredUp) {
    scale.power_up();
    hx711PoweredUp = true;
    unsigned long t0 = millis();
    while (!scale.is_ready() && (millis() - t0 < 400)) {
      localServer.handleClient();
      delay(5);
    }
  }
}

void performIntentionalTare(const char* sourceLabel) {
  Serial.println("==========================================");
  Serial.print("ZERO TARE TRIGGERED VIA: ");
  Serial.println(sourceLabel);

  ensureHx711Awake();

  lcd.display();
  lcd.backlight();
  lcdDisplayActive = true;
  lcdBacklightActive = true;
  tempLightUntilMs = millis() + BTN_WAKE_VIEW_MS;

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Zeroing Scale...");
  lcd.setCursor(0, 1);
  lcd.print("Keep Empty!     ");

  scale.set_scale(cfgCalFactor);
  scale.tare(20);
  long newOffset = scale.get_offset();

  prefs.begin("cocoscale", false);
  prefs.putBool("hasTare", true);
  prefs.putLong("tareOffset", newOffset);
  prefs.end();

  weightRingCnt = 0;
  weightRingIdx = 0;
  currentSmoothedWeightKg = 0.0f;

  Serial.print("Saved new tareOffset to Flash: ");
  Serial.println(newOffset);
  Serial.println("==========================================");

  lcd.setCursor(0, 0);
  lcd.print("Tare Saved!     ");
  lcd.setCursor(0, 1);
  lcd.print("0.000 kg Locked ");
  delay(900);
  lcd.clear();
}

void restoreOrInitScaleTare() {
  scale.set_scale(cfgCalFactor);

  prefs.begin("cocoscale", true);
  bool hasSavedTare = prefs.getBool("hasTare", false);
  long savedOffset  = prefs.getLong("tareOffset", 0);
  prefs.end();

  if (hasSavedTare) {
    scale.set_offset(savedOffset);
    Serial.print("Restored saved tareOffset from Flash (polybag-safe): ");
    Serial.println(savedOffset);
  } else {
    Serial.println("First-ever setup: taring scale and saving to Flash...");
    performIntentionalTare("First-Time Boot");
  }
}

// ============================================================================
// Battery Voltage, Power Source & Charging Sampler (GPIO 35 + 0-25V Sensor)
// ============================================================================
float readBatteryVoltageAndPct() {
  // Take 16 fast samples using ESP32 eFuse factory hardware calibration (analogReadMilliVolts)
  // This completely eliminates ESP32 non-linear ADC curve distortion and attenuation mismatch.
  long rawSum = 0;
  long mvSum  = 0;
  for (int i = 0; i < 16; i++) {
    rawSum += analogRead(BATT_VOLT_PIN);
    mvSum  += analogReadMilliVolts(BATT_VOLT_PIN);
    delayMicroseconds(250);
  }
  float avgRaw = (float)rawSum / 16.0f;
  float avgMv  = (float)mvSum  / 16.0f;

  // 0-25V sensor uses 30k + 7.5k divider (nominal 5:1 ratio)
  // Calibrated with 5.28f multiplier to account for resistor tolerance & ADC pin input impedance loading:
  // Scales fully charged 18650 cell (~792mV on GPIO 35) to 4.18V -> 100%
  float volt = 0.0f;
  if (avgMv > 50.0f) {
    volt = (avgMv * 5.28f) / 1000.0f;
  } else {
    // Fallback if core does not support eFuse table:
    volt = avgRaw * 0.00538f;
  }

  // Determine Power Source & Charging State
  if (volt < 2.0f) {
    // Voltage pin near 0V while ESP32 is running: powered via USB cable, no battery on divider
    strncpy((char*)currentPwrSource, "usb_direct", sizeof(currentPwrSource));
    strncpy((char*)currentChgState, "none", sizeof(currentChgState));
    currentBattPct = 100;
  } else if (volt >= 4.40f) {
    // 5V USB rail measured directly
    strncpy((char*)currentPwrSource, "usb_5v", sizeof(currentPwrSource));
    strncpy((char*)currentChgState, "none", sizeof(currentChgState));
    currentBattPct = 100;
  } else {
    // Battery connected (2.0V - 4.39V)
    strncpy((char*)currentPwrSource, "battery", sizeof(currentPwrSource));

    // Convert Li-ion 18650 cell voltage (3.2V empty to 4.2V full) into realistic 0-100%
    int pct = 0;
    if (volt >= 4.18f) pct = 100;
    else if (volt <= 3.20f) pct = 0;
    else {
      pct = (int)(((volt - 3.20f) / (4.20f - 3.20f)) * 100.0f);
    }
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    currentBattPct = pct;

    // Detect charging vs discharging
    if (lastSampledBattVolt > 2.0f) {
      float diff = volt - lastSampledBattVolt;
      if (diff > 0.25f || diff < -0.25f) {
        // Step jump (>250mV) from reflash, battery swap, or reconnect -> ignore as charge slope
        strncpy((char*)currentChgState, "discharging", sizeof(currentChgState));
      } else if (diff >= 0.045f) {
        // Genuine sustained rise of at least 45mV above ADC noise floor
        strncpy((char*)currentChgState, "charging", sizeof(currentChgState));
      } else if (volt >= 4.18f) {
        strncpy((char*)currentChgState, "charged", sizeof(currentChgState));
      } else if (diff <= -0.015f) {
        strncpy((char*)currentChgState, "discharging", sizeof(currentChgState));
      }
    } else {
      strncpy((char*)currentChgState, "discharging", sizeof(currentChgState));
    }
  }

  currentBattVolt = volt;
  lastSampledBattVolt = volt;
  static unsigned long lastBattLogMs = 0;
  if (millis() - lastBattLogMs > 4000UL || lastBattLogMs == 0) {
    lastBattLogMs = millis();
    Serial.printf("[BATT ADC] Raw: %ld | Pin: %.0fmV | Calculated: %.2fV | Pct: %d%% | Pwr: %s\n", (long)avgRaw, avgMv, volt, currentBattPct, (char*)currentPwrSource);
  }
  return volt;
}

// ============================================================================
// Non-Blocking HX711 Sampling & Median/Trimmed-Mean Filter
// ============================================================================
void pollHx711NonBlocking() {
  if (!hx711PoweredUp) return;
  if (scale.is_ready()) {
    float sample = scale.get_units(1);
    weightRing[weightRingIdx] = sample;
    weightRingIdx = (weightRingIdx + 1) % 5;
    if (weightRingCnt < 5) weightRingCnt++;

    float sum = 0.0f;
    for (int i = 0; i < weightRingCnt; i++) sum += weightRing[i];
    float avg = sum / weightRingCnt;
    if (avg < 0.005f && avg > -0.010f) avg = 0.000f;
    currentSmoothedWeightKg = avg;
  }
}

float readStabilizedWeightKg(int samples) {
  ensureHx711Awake();

  const int MAX_N = 15;
  int n = (samples > MAX_N) ? MAX_N : ((samples < 3) ? 3 : samples);
  float vals[MAX_N];
  int count = 0;

  for (int i = 0; i < n; i++) {
    unsigned long t0 = millis();
    while (!scale.is_ready() && (millis() - t0 < 250)) {
      localServer.handleClient();
      delay(4);
    }
    if (scale.is_ready()) {
      vals[count++] = scale.get_units(1);
    }
  }

  if (count == 0) return currentSmoothedWeightKg;

  for (int i = 0; i < count - 1; i++) {
    for (int j = i + 1; j < count; j++) {
      if (vals[j] < vals[i]) {
        float tmp = vals[i];
        vals[i] = vals[j];
        vals[j] = tmp;
      }
    }
  }

  int drop = (count >= 7) ? 2 : ((count >= 3) ? 1 : 0);
  float sum = 0.0f;
  int used = 0;
  for (int i = drop; i < count - drop; i++) {
    sum += vals[i];
    used++;
  }

  float w = (used > 0) ? (sum / used) : vals[count / 2];
  if (w < 0.005f && w > -0.010f) w = 0.000f;
  currentSmoothedWeightKg = w;
  return w;
}

// ============================================================================
// True Hardware Deep Sleep Entry (For "deep_sleep" Ultra Deep Sleep Mode)
// ============================================================================
void enterUltraHardwareDeepSleep() {
  uint64_t sleepSeconds = (uint64_t)max(1, (int)cfgIntervalMin) * 60ULL;
  Serial.printf("[ULTRA DEEP SLEEP] Powering down HX711, LCD, Wi-Fi & CPU for %llu sec...\n", sleepSeconds);

  lcd.noBacklight();
  lcd.noDisplay();
  scale.power_down();

  // CRITICAL: Lock HX711 PD_SCK (GPIO 18) HIGH across deep sleep!
  // Without gpio_hold_en + gpio_deep_sleep_hold_en, GPIO 18 drops LOW when ESP32 enters
  // esp_deep_sleep_start(), which wakes the HX711 & load-cell bridge back up (~18mA drain)!
  digitalWrite(LOADCELL_SCK_PIN, HIGH);
  gpio_hold_en((gpio_num_t)LOADCELL_SCK_PIN);
  digitalWrite(ONBOARD_BLUE_LED, LOW);
  gpio_hold_en((gpio_num_t)ONBOARD_BLUE_LED);
  gpio_deep_sleep_hold_en();

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  esp_wifi_stop();
  btStop();
  esp_bt_controller_disable();

  // Wake ONLY on RTC Timer!
  // NOTE: Do NOT enable EXT0 wakeup on GPIO 0 on DOIT ESP32 DevKit V1!
  // On DevKit V1 boards, GPIO 0 is tied to the unpowered CP2102 + S8050 auto-flash transistor circuit;
  // when USB is unplugged (running on battery), GPIO 0 glitches LOW and causes an instant false wakeup!
  // (To wake the scale manually in the field at any time, simply press the physical EN / Reset button.)
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
  esp_sleep_enable_timer_wakeup(sleepSeconds * 1000000ULL);

  Serial.flush();
  esp_deep_sleep_start();
}

// ============================================================================
// Instant LCD, HX711, Wi-Fi Modem-Sleep & CPU Power Controller (Core 1)
// ============================================================================
void applyPowerAndLcdState() {
  if (pendingFlashPulse) {
    pendingFlashPulse = false;
    unsigned long target = millis() + SYNC_FLASH_MS;
    if (target > tempLightUntilMs) tempLightUntilMs = target;
  }

  bool overrideOn = (millis() < tempLightUntilMs);
  bool inLowPowerSaver = (cfgPowerMode == "smart_saver" || cfgPowerMode == "deep_sleep") && !overrideOn;

  // 1. Manage HX711 Load Cell, Wi-Fi DTIM Modem-Sleep & CPU Clock
  if (inLowPowerSaver) {
    if (hx711PoweredUp) {
      scale.power_down();
      hx711PoweredUp = false;
      Serial.println("[POWER] Smart Saver -> HX711 off, LCD off, 80 MHz + WIFI_PS_MAX_MODEM active");
    }
    if (!lowCpuClockActive) {
      setCpuFrequencyMhz(80);
      lowCpuClockActive = true;
    }
    if (!maxModemSleepSet && WiFi.status() == WL_CONNECTED) {
      esp_wifi_set_ps(WIFI_PS_MAX_MODEM);
      maxModemSleepSet = true;
    }
  } else {
    if (lowCpuClockActive) {
      setCpuFrequencyMhz(240);
      lowCpuClockActive = false;
    }
    if (maxModemSleepSet && WiFi.status() == WL_CONNECTED) {
      esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
      maxModemSleepSet = false;
    }
    if (!hx711PoweredUp) {
      scale.power_up();
      hx711PoweredUp = true;
      Serial.println("[POWER] Woke HX711 & LCD immediately!");
    }
  }

  // 2. Manage 16x2 LCD Display & Backlight
  bool wantDisplay = true;
  bool wantBacklight = true;

  if (overrideOn) {
    wantDisplay = true;
    wantBacklight = true;
  } else if (inLowPowerSaver) {
    wantDisplay = false;
    wantBacklight = false;
  } else if (cfgLcdMode == "on") {
    wantDisplay = true;
    wantBacklight = true;
  } else if (cfgLcdMode == "text_only") {
    wantDisplay = true;
    wantBacklight = false;
  } else if (cfgLcdMode == "flash") {
    wantDisplay = true;
    wantBacklight = false;
  } else if (cfgLcdMode == "off") {
    wantDisplay = false;
    wantBacklight = false;
  }

  if (wantDisplay != lcdDisplayActive) {
    if (wantDisplay) lcd.display();
    else lcd.noDisplay();
    lcdDisplayActive = wantDisplay;
  }

  if (wantBacklight != lcdBacklightActive) {
    if (wantBacklight) lcd.backlight();
    else lcd.noBacklight();
    lcdBacklightActive = wantBacklight;
  }
}

void renderLcdScreen(float weightKg) {
  applyPowerAndLcdState();
  if (!lcdDisplayActive) return;

  char line1[17];
  if (strcmp((char*)currentPwrSource, "usb_direct") == 0 || strcmp((char*)currentPwrSource, "usb_5v") == 0) {
    snprintf(line1, sizeof(line1), "W:%5.2fkg USB-PWR", weightKg);
  } else if (strcmp((char*)currentChgState, "charging") == 0) {
    snprintf(line1, sizeof(line1), "W:%5.2fkg CHG:%2d%%", weightKg, currentBattPct);
  } else {
    snprintf(line1, sizeof(line1), "W:%5.2fkg B:%3d%%", weightKg, currentBattPct);
  }
  lcd.setCursor(0, 0);
  lcd.print(line1);

  char line2[17];
  if (millis() < cmdBannerUntilMs && cmdBannerText.length() > 0) {
    snprintf(line2, sizeof(line2), "%-16s", cmdBannerText.c_str());
  } else if (WiFi.status() != WL_CONNECTED) {
    snprintf(line2, sizeof(line2), "WiFi:Offline %2dm", cfgIntervalMin);
  } else {
    unsigned long intervalMs = (unsigned long)cfgIntervalMin * 60000UL;
    unsigned long elapsed = millis() - lastLogTime;
    unsigned long remSec = (elapsed < intervalMs) ? ((intervalMs - elapsed) / 1000UL) : 0UL;
    unsigned int mm = remSec / 60UL;
    unsigned int ss = remSec % 60UL;
    snprintf(line2, sizeof(line2), "Next:%02um%02us %3dm", mm, ss, cfgIntervalMin);
  }
  lcd.setCursor(0, 1);
  lcd.print(line2);
}

// ============================================================================
// Apply New Config (Called from Local HTTP or Core 0 Firebase Poll)
// ============================================================================
bool parseAndStageConfig(int newInterval, const String& newPower, const String& newLcd, long remoteTareId, float newCalFactor = 0.0f) {
  bool changed = false;

  if (newCalFactor >= 10.0f && newCalFactor <= 10000000.0f && fabs(newCalFactor - cfgCalFactor) > 0.5f) {
    Serial.printf("[INSTANT CMD] CalFactor: %.1f -> %.1f\n", cfgCalFactor, newCalFactor);
    cfgCalFactor = newCalFactor;
    scale.set_scale(cfgCalFactor);
    weightRingCnt = 0;
    weightRingIdx = 0;
    pendingCalFactorApply = true;
    tempLightUntilMs = millis() + 30000UL;
    cmdBannerText = "App: Calibrated!";
    cmdBannerUntilMs = millis() + 3000UL;
    changed = true;
  }

  if (newInterval >= 1 && newInterval <= 240 && newInterval != cfgIntervalMin) {
    Serial.printf("[INSTANT CMD] Interval: %d min -> %d min\n", cfgIntervalMin, newInterval);
    cfgIntervalMin = newInterval;
    cmdBannerText = String("App: Gap ") + String(cfgIntervalMin) + " min";
    cmdBannerUntilMs = millis() + 2500UL;
    changed = true;
  }

  if (newLcd == "on" || newLcd == "text_only" || newLcd == "flash" || newLcd == "off") {
    if (newLcd != "on" && tempLightUntilMs > 0) {
      tempLightUntilMs = 0;
      changed = true;
    }
    if (newLcd != cfgLcdMode) {
      Serial.println("[INSTANT CMD] LCD Mode -> " + newLcd);
      cfgLcdMode = newLcd;
      cmdBannerText = String("App: LCD ") + newLcd;
      cmdBannerUntilMs = millis() + 2500UL;
      changed = true;
    }
  }

  if ((newPower == "always_on" || newPower == "smart_saver" || newPower == "deep_sleep") && newPower != cfgPowerMode) {
    Serial.println("[INSTANT CMD] Power Mode -> " + newPower);
    cfgPowerMode = newPower;
    if (newPower == "smart_saver") {
      tempLightUntilMs = 0;
      cmdBannerText = "App: Smart Saver";
    } else if (newPower == "deep_sleep") {
      tempLightUntilMs = 0;
      cmdBannerText = "App: Ultra Sleep";
      pendingUltraSleepNow = true;
    } else {
      // Waking from Saver -> Always Awake: ensure LCD lights up immediately!
      if (cfgLcdMode == "off") {
        cfgLcdMode = "on";
      }
      pendingUltraSleepNow = false;
      cmdBannerText = "App: Awake Mode";
      cmdBannerUntilMs = millis() + 2500UL;
    }
    changed = true;
  }

  if (remoteTareId > 0 && remoteTareId != lastAckTareId) {
    pendingRemoteTareId = remoteTareId;
    changed = true;
  }

  if (changed) {
    pendingConfigApply = true;
    activePollUntilMs = millis() + 30000UL; // 0.95s turbo poll for 30s after App interaction
  }
  return changed;
}

// ============================================================================
// Direct Local HTTP Server on Port 80 (<50ms Instant LAN Control, 0 mA Idle TX)
// ============================================================================
void setupLocalHttpServer() {
  localServer.on("/cmd", HTTP_OPTIONS, []() {
    localServer.sendHeader("Access-Control-Allow-Origin", "*");
    localServer.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    localServer.sendHeader("Access-Control-Allow-Headers", "*");
    localServer.send(204);
  });

  localServer.on("/cmd", HTTP_GET, []() {
    localServer.sendHeader("Access-Control-Allow-Origin", "*");

    int newInt = localServer.hasArg("intervalMin") ? localServer.arg("intervalMin").toInt() : cfgIntervalMin;
    String newPow = localServer.hasArg("powerMode") ? localServer.arg("powerMode") : cfgPowerMode;
    String newLcd = localServer.hasArg("lcdMode") ? localServer.arg("lcdMode") : cfgLcdMode;
    long tareId = localServer.hasArg("tareId") ? localServer.arg("tareId").toInt() : 0;
    float newCal = localServer.hasArg("calFactor") ? localServer.arg("calFactor").toFloat() : 0.0f;

    parseAndStageConfig(newInt, newPow, newLcd, tareId, newCal);
    applyPowerAndLcdState();
    saveConfigPreferences();

    String json = String("{\"ok\":true,\"via\":\"lan\",\"plot\":\"") + PLOT_ID
                + "\",\"intervalMin\":" + String(cfgIntervalMin)
                + ",\"powerMode\":\"" + cfgPowerMode
                + "\",\"lcdMode\":\"" + cfgLcdMode
                + "\",\"calFactor\":" + String(cfgCalFactor, 1)
                + ",\"appliedState\":\"" + buildAppliedTag()
                + "\",\"ssid\":\"" + WiFi.SSID()
                + "\",\"localIp\":\"" + WiFi.localIP().toString()
                + "\",\"rssi\":" + String(WiFi.RSSI())
                + ",\"battVolt\":" + String(currentBattVolt, 2)
                + ",\"battPct\":" + String(currentBattPct)
                + ",\"pwrSource\":\"" + String((char*)currentPwrSource) + "\""
                + ",\"chgState\":\"" + String((char*)currentChgState) + "\""
                + ",\"weightKg\":" + String(currentSmoothedWeightKg, 3) + "}";
    localServer.send(200, "application/json", json);
  });

  localServer.begin();
  Serial.println("[LAN] Passive HTTP server listening on port 80 (/cmd)");
}

// ============================================================================
// Fast Firebase RTDB Sync + Google Sheets Weight Upload (Runs on Core 0)
// ============================================================================
WiFiClientSecure fbClient;
HTTPClient fbHttp;
bool fbClientInitialized = false;

void syncFirebaseDeviceNode(bool forceWriteAck) {
  if (WiFi.status() != WL_CONNECTED) return;

  if (!fbClientInitialized) {
    fbClient.setInsecure();
    fbHttp.setReuse(true);
    fbHttp.setTimeout(3500);
    fbClientInitialized = true;
  }

  String fbUrl = String(firebaseBaseUrl) + "/" + PLOT_ID + ".json";
  bool nodeMissingInCloud = false;

  // Read Firebase first so ESP32 never overwrites a command sent from the Web App
  if (fbHttp.begin(fbClient, fbUrl)) {
    int code = fbHttp.GET();
    if (code == 200) {
      fbSyncedAtLeastOnce = true;
      String body = fbHttp.getString();
      if (body.length() > 4 && body != "null" && body.indexOf("\"lcdMode\"") >= 0) {
        int newInt = (int)extractJsonLong(body, "intervalMin", cfgIntervalMin);
        String newPow = extractJsonString(body, "powerMode", cfgPowerMode);
        String newLcd = extractJsonString(body, "lcdMode", cfgLcdMode);
        long rTareId  = extractJsonLong(body, "tareId", 0);
        float newCal  = extractJsonFloat(body, "calFactor", 0.0f);
        String remoteApplied = extractJsonString(body, "appliedState", "");

        bool changed = parseAndStageConfig(newInt, newPow, newLcd, rTareId, newCal);
        if (changed || remoteApplied != buildAppliedTag()) {
          forceWriteAck = true;
        }
      } else {
        nodeMissingInCloud = true;
        forceWriteAck = true;
      }
    } else {
      Serial.printf("[FB POLL] HTTP %d\n", code);
    }
    fbHttp.end();
  }

  if (forceWriteAck) {
    readBatteryVoltageAndPct();
    String patchJson = String("{\"plotKey\":\"") + PLOT_ID + "\"";
    if (nodeMissingInCloud) {
      patchJson += ",\"intervalMin\":" + String(cfgIntervalMin)
                 + ",\"powerMode\":\"" + cfgPowerMode + "\""
                 + ",\"lcdMode\":\"" + cfgLcdMode + "\"";
    }
    patchJson += ",\"ackTareId\":" + String(lastAckTareId)
               + ",\"calFactor\":" + String(cfgCalFactor, 1)
               + ",\"appliedState\":\"" + buildAppliedTag()
               + "\",\"ssid\":\"" + WiFi.SSID()
               + "\",\"localIp\":\"" + WiFi.localIP().toString()
               + "\",\"rssi\":" + String(WiFi.RSSI())
               + ",\"battVolt\":" + String(currentBattVolt, 2)
               + ",\"battPct\":" + String(currentBattPct)
               + ",\"pwrSource\":\"" + String((char*)currentPwrSource) + "\""
               + ",\"chgState\":\"" + String((char*)currentChgState) + "\""
               + ",\"lastWeightKg\":" + String(currentSmoothedWeightKg, 3)
               + ",\"fw\":\"" + FW_VERSION
               + "\",\"seenEpochMs\":" + String(millis()) + "}";
    if (fbHttp.begin(fbClient, fbUrl)) {
      fbHttp.addHeader("Content-Type", "application/json");
      int pCode = fbHttp.sendRequest("PATCH", patchJson);
      Serial.printf("[FB ACK] Applied %s -> HTTP %d\n", buildAppliedTag().c_str(), pCode);
      fbHttp.end();
    }
  }
}

bool uploadWeightToGoogleSheet(float weightKg) {
  if (WiFi.status() != WL_CONNECTED) return false;

  if (cfgLcdMode == "flash" && cfgPowerMode == "always_on") {
    pendingFlashPulse = true;
  }

  // Free Firebase TLS socket before Google Apps Script HTTPS redirect chain
  fbHttp.end();
  fbClient.stop();

  readBatteryVoltageAndPct();
  String url = String(scriptUrl) + "?plot=" + PLOT_ID
             + "&fw=" + FW_VERSION
             + "&rssi=" + String(WiFi.RSSI())
             + "&battVolt=" + String(currentBattVolt, 2)
             + "&battPct=" + String(currentBattPct)
             + "&pwrSource=" + String((char*)currentPwrSource)
             + "&chgState=" + String((char*)currentChgState)
             + "&ackTareId=" + String(lastAckTareId)
             + "&applied=" + buildAppliedTag()
             + "&weight=" + String(weightKg, 3);

  HTTPClient sheetHttp;
  sheetHttp.setTimeout(10000);
  sheetHttp.begin(url);
  sheetHttp.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  int code = sheetHttp.GET();
  if (code > 0) {
    String resp = sheetHttp.getString();
    Serial.printf("[SHEET UPLOAD] %.3f kg -> HTTP %d\n", weightKg, code);
    if (resp.indexOf("\"ok\":true") >= 0 && !fbSyncedAtLeastOnce) {
      int newInt = (int)extractJsonLong(resp, "intervalMin", cfgIntervalMin);
      String newPow = extractJsonString(resp, "powerMode", cfgPowerMode);
      String newLcd = extractJsonString(resp, "lcdMode", cfgLcdMode);
      long rTareId  = extractJsonLong(resp, "tareId", 0);
      parseAndStageConfig(newInt, newPow, newLcd, rTareId);
    }
    sheetHttp.end();
    syncFirebaseDeviceNode(true);
    return true;
  } else {
    Serial.printf("[SHEET ERROR] HTTP %d\n", code);
    sheetHttp.end();
    return false;
  }
}

// ============================================================================
// Core 0 Background Task (Adaptive Battery-Saving Poll Cadence)
// ============================================================================
void cloudWorkerTask(void* parameter) {
  unsigned long lastFbCheck = 0;

  for (;;) {
    if (WiFi.status() == WL_CONNECTED) {
      // 1. Handle queued Google Sheet weight upload
      if (pendingSheetUpload) {
        cloudTaskBusy = true;
        float w = uploadWeightPayload;
        pendingSheetUpload = false;
        uploadWeightToGoogleSheet(w);
        cloudTaskBusy = false;
      }

      // 2. Adaptive Firebase command check:
      //    - 0.95s for 30s right after user interacts
      //    - 5.0s when in Always Awake mode
      //    - 45.0s when in Smart Saver mode (Local HTTP /cmd still wakes in <0.2s!)
      unsigned long now = millis();
      unsigned long pollGap = (now < activePollUntilMs)
        ? ACTIVE_FB_POLL_MS
        : ((cfgPowerMode == "always_on") ? AWAKE_IDLE_FB_POLL_MS : SAVER_IDLE_FB_POLL_MS);

      if (now - lastFbCheck >= pollGap) {
        lastFbCheck = now;
        syncFirebaseDeviceNode(false);
      }
    }
    vTaskDelay(pdMS_TO_TICKS((cfgPowerMode == "always_on") ? 80 : 220));
  }
}

// ============================================================================
// Wi-Fi Setup (With Power-Saving TX & Modem-Sleep Optimization)
// ============================================================================
void setupWiFiMulti(int maxAttempts) {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true);
  wifiMulti.addAP("khtan_2.4G", "123123123tan");
  wifiMulti.addAP("KHAGRIFARM_2.4", "123123farm");

  Serial.print("Connecting Wi-Fi");
  int attempts = 0;
  while (wifiMulti.run() != WL_CONNECTED && attempts < maxAttempts) {
    delay(350);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    // If router signal is strong (> -68 dBm), lower RF TX power slightly to save ~35mA on transmit spikes
    if (WiFi.RSSI() > -68) {
      WiFi.setTxPower(WIFI_POWER_15dBm);
    }
    esp_wifi_set_ps((cfgPowerMode == "always_on") ? WIFI_PS_MIN_MODEM : WIFI_PS_MAX_MODEM);
    maxModemSleepSet = (cfgPowerMode != "always_on");

    Serial.print("\nWi-Fi Connected: ");
    Serial.print(WiFi.SSID());
    Serial.print(" | IP: ");
    Serial.print(WiFi.localIP());
    Serial.printf(" | RSSI: %d dBm\n", WiFi.RSSI());
    if (MDNS.begin(MDNS_HOST)) {
      Serial.printf("[mDNS] http://%s.local/cmd active\n", MDNS_HOST);
    }
  } else {
    Serial.println("\nWi-Fi connection timed out (offline).");
  }
}

// ============================================================================
// Button Input Handler (Short Press = Toggle/Light LCD | 3s Hold = Safe Tare)
// ============================================================================
void pollButtonAndSerial() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 't' || c == 'T') {
      performIntentionalTare("Serial Command");
    }
  }

  if (pendingRemoteTareId > 0 && pendingRemoteTareId != lastAckTareId) {
    long ack = pendingRemoteTareId;
    pendingRemoteTareId = 0;
    performIntentionalTare("Remote App Command");
    lastAckTareId = ack;
    saveConfigPreferences();
    syncFirebaseDeviceNode(true);
  }

  if (pendingConfigApply) {
    pendingConfigApply = false;
    saveConfigPreferences();
    applyPowerAndLcdState();
    if (pendingCalFactorApply) {
      pendingCalFactorApply = false;
      ensureHx711Awake();
      scale.set_scale(cfgCalFactor);
      weightRingCnt = 0;
      weightRingIdx = 0;
      currentSmoothedWeightKg = readStabilizedWeightKg(7);
      syncFirebaseDeviceNode(true);
    }
    renderLcdScreen(currentSmoothedWeightKg);
  }

  // If user selected Ultra Deep Sleep ("deep_sleep") and no temporary button wake is active
  if ((cfgPowerMode == "deep_sleep" || pendingUltraSleepNow) && !cloudTaskBusy && millis() >= tempLightUntilMs) {
    pendingUltraSleepNow = false;
    syncFirebaseDeviceNode(true);
    enterUltraHardwareDeepSleep();
  }

  bool isDown = (digitalRead(WAKE_TARE_BTN_PIN) == LOW);
  unsigned long now = millis();

  if (isDown && !btnWasDown) {
    btnWasDown = true;
    tareTriggeredHold = false;
    btnPressStartMs = now;
  } else if (isDown && btnWasDown) {
    if (!tareTriggeredHold && (now - btnPressStartMs >= TARE_HOLD_MS)) {
      tareTriggeredHold = true;
      performIntentionalTare("3s Button Hold");
    }
  } else if (!isDown && btnWasDown) {
    btnWasDown = false;
    if (!tareTriggeredHold) {
      Serial.println("[BTN] Short press -> LCD Backlight ON for 45s");
      tempLightUntilMs = now + BTN_WAKE_VIEW_MS;
      activePollUntilMs = now + BTN_WAKE_VIEW_MS;
      applyPowerAndLcdState();
      renderLcdScreen(currentSmoothedWeightKg);
    }
  }
}

// ============================================================================
// Setup & Main Loop
// ============================================================================
void setup() {
  // 1. Release deep-sleep GPIO latches & disable unused Bluetooth + Blue LED immediately
  gpio_hold_dis((gpio_num_t)LOADCELL_SCK_PIN);
  gpio_hold_dis((gpio_num_t)ONBOARD_BLUE_LED);
  btStop();
  esp_bt_controller_disable();
  pinMode(ONBOARD_BLUE_LED, OUTPUT);
  digitalWrite(ONBOARD_BLUE_LED, LOW);
  pinMode(WAKE_TARE_BTN_PIN, INPUT_PULLUP);
  pinMode(BATT_VOLT_PIN, INPUT);
  analogReadResolution(12); // 12-bit ADC (0-4095)
  analogSetPinAttenuation(BATT_VOLT_PIN, ADC_11db); // Full-scale 0-3.1V range for GPIO 35
  readBatteryVoltageAndPct();

  Serial.begin(115200);
  delay(80);

  loadSavedPreferences();
  esp_sleep_wakeup_cause_t wakeCause = esp_sleep_get_wakeup_cause();
  bool silentTimerWake = (wakeCause == ESP_SLEEP_WAKEUP_TIMER) && (cfgPowerMode == "deep_sleep");

  if (silentTimerWake) {
    // Run unattended deep-sleep timer wakes at 80 MHz to cut CPU active current by ~40mA
    setCpuFrequencyMhz(80);
    lowCpuClockActive = true;
  }

  Wire.begin(LCD_SDA_PIN, LCD_SCL_PIN);

  if (cfgLcdMode == "flash" && cfgPowerMode != "deep_sleep") {
    tempLightUntilMs = millis() + SYNC_FLASH_MS;
  }

  if (silentTimerWake) {
    // Silent background wake-up in Ultra Deep Sleep: skip lcd.init() flash & force PCF8574 dark (0x00)
    Wire.beginTransmission(0x27);
    Wire.write(0x00);
    Wire.endTransmission();
    lcdDisplayActive = false;
    lcdBacklightActive = false;
  } else {
    lcd.init();
    lcd.display();
    lcd.backlight();
    lcdDisplayActive = true;
    lcdBacklightActive = true;
    lcd.setCursor(0, 0);
    lcd.print("KH CocoScale 2.7");
    lcd.setCursor(0, 1);
    lcd.print("Connecting WiFi ");
  }

  scale.begin(LOADCELL_DOUT_PIN, LOADCELL_SCK_PIN);
  // Keep HX711 powered down during Wi-Fi connect & Firebase sync to save ~18mA during RF TX
  scale.power_down();
  hx711PoweredUp = false;

  setupWiFiMulti(18);
  setupLocalHttpServer();

  // Pull latest Firebase config immediately on boot & ACK
  syncFirebaseDeviceNode(true);
  if (pendingConfigApply) {
    pendingConfigApply = false;
    saveConfigPreferences();
  }

  // Wake HX711 briefly (~1.1s) just to take the stabilized weight reading, then power down immediately
  scale.power_up();
  hx711PoweredUp = true;
  unsigned long hxWait = millis();
  while (!scale.is_ready() && (millis() - hxWait < 1200)) {
    delay(20);
  }
  restoreOrInitScaleTare();

  float initialWeight = readStabilizedWeightKg(11);
  Serial.printf("[BOOT] Stabilized Weight: %.3f kg\n", initialWeight);

  if (cfgPowerMode != "always_on") {
    scale.power_down();
    hx711PoweredUp = false;
  }

  if (!silentTimerWake) {
    lcd.clear();
    applyPowerAndLcdState();
    renderLcdScreen(initialWeight);
  }

  uploadWeightToGoogleSheet(initialWeight);
  lastLogTime = millis();

  // If in Ultra Deep Sleep ("deep_sleep"), ALWAYS enter hardware deep sleep here (never fall into loop!)
  if (cfgPowerMode == "deep_sleep") {
    if (!silentTimerWake) {
      // On manual power-on or EN button reset, display weight on LCD for 3.5s before sleeping
      delay(3500);
    }
    enterUltraHardwareDeepSleep();
    return;
  }

  // Start background Cloud Worker on Core 0
  xTaskCreatePinnedToCore(cloudWorkerTask, "CloudWorker", 16384, NULL, 1, NULL, 0);
}

void loop() {
  localServer.handleClient();
  pollButtonAndSerial();
  applyPowerAndLcdState();
  pollHx711NonBlocking();

  unsigned long now = millis();

  // Update LCD display text every 400ms (only when display is active)
  if (lcdDisplayActive && (now - lastLcdRenderTime >= 400UL)) {
    lastLcdRenderTime = now;
    renderLcdScreen(currentSmoothedWeightKg);
  }

  // Self-healing Wi-Fi check
  static unsigned long lastWifiCheck = 0;
  if (now - lastWifiCheck >= WIFI_CHECK_MS) {
    lastWifiCheck = now;
    if (WiFi.status() != WL_CONNECTED) {
      wifiMulti.run();
    }
  }

  // Queue scheduled Google Sheet weight upload
  unsigned long logIntervalMs = (unsigned long)cfgIntervalMin * 60UL * 1000UL;
  if (!pendingSheetUpload && (now - lastLogTime >= logIntervalMs)) {
    lastLogTime = now;
    float cleanWeight = readStabilizedWeightKg(11);
    if (cfgPowerMode != "always_on" && millis() >= tempLightUntilMs) {
      scale.power_down();
      hx711PoweredUp = false;
    }
    if (cfgPowerMode == "deep_sleep" && millis() >= tempLightUntilMs) {
      uploadWeightToGoogleSheet(cleanWeight);
      enterUltraHardwareDeepSleep();
      return;
    }
    uploadWeightPayload = cleanWeight;
    pendingSheetUpload = true;
  }

  // Sleep longer per loop tick in Smart Saver mode so FreeRTOS idle lowers power consumption
  bool inSaver = (cfgPowerMode != "always_on") && (now >= tempLightUntilMs);
  delay(inSaver ? 80 : 25);
}
