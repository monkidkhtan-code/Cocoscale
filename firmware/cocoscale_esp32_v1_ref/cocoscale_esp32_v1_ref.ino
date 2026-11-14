#include <WiFi.h>
#include <WiFiMulti.h>
#include <HTTPClient.h>
#include "HX711.h"
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// --- Wi-Fi Multi Instance ---
WiFiMulti wifiMulti;

// --- Google Apps Script Web App Deployment URL ---
const char* scriptUrl = "https://script.google.com/macros/s/AKfycbzpVPqtHfPaVJjyqnRiW4oF-FR5359P2ewcCebXO61lufeeXKDYJzviX7xIRhQeiX4xMw/exec";

// --- Hardware Pins ---
const int LOADCELL_DOUT_PIN = 19;
const int LOADCELL_SCK_PIN = 18;

// Calibration factor
const float CALIBRATION_FACTOR = 99833.0;

// Logging interval in minutes (Set to 1 min for testing; change to 5 or 15 for production)
const unsigned long LOG_INTERVAL_MINUTES = 1; 
const unsigned long LOG_INTERVAL_MS = LOG_INTERVAL_MINUTES * 60 * 1000UL;

unsigned long lastLogTime = 0;
unsigned long lastWifiCheckTime = 0;

HX711 scale;
LiquidCrystal_I2C lcd(0x27, 16, 2);

void setupWiFiMulti() {
  WiFi.mode(WIFI_STA);

  // Register Home Wi-Fi
  wifiMulti.addAP("khtan_2.4G", "123123123tan");

  // Register Farm Wi-Fi
  wifiMulti.addAP("KHAGRIFARM_2.4", "123123farm");

  Serial.println("Searching for available configured Wi-Fi...");
  
  int attempts = 0;
  while (wifiMulti.run() != WL_CONNECTED && attempts < 25) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWi-Fi Connected successfully!");
    Serial.print("Connected SSID: ");
    Serial.println(WiFi.SSID());
    Serial.print("Assigned IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWi-Fi connection timed out. Scale will operate offline.");
  }
}

void sendWeightToSheet(float weight) {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    String fullUrl = String(scriptUrl) + "?weight=" + String(weight, 3);

    http.begin(fullUrl);
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

    Serial.print("Uploading to Google Sheets: ");
    Serial.println(fullUrl);

    int httpResponseCode = http.GET();

    if (httpResponseCode > 0) {
      Serial.print("HTTP Response code: ");
      Serial.println(httpResponseCode);
      String response = http.getString();
      Serial.println("Server response: " + response);
    } else {
      Serial.print("Error sending GET: ");
      Serial.println(httpResponseCode);
    }

    http.end();
  } else {
    Serial.println("Wi-Fi disconnected. Cannot upload.");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  // Initialize LCD (SDA = GPIO 21, SCL = GPIO 22)
  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Polybag Scale");
  lcd.setCursor(0, 1);
  lcd.print("Connecting WiFi");

  Serial.println("\n--- Initializing Polybag Scale ---");

  setupWiFiMulti();

  // Initialize HX711 Load Cell Amplifier
  scale.begin(LOADCELL_DOUT_PIN, LOADCELL_SCK_PIN);

  while (!scale.is_ready()) {
    Serial.println("Waiting for HX711 chip to wake up...");
    delay(200);
  }

  scale.set_scale(CALIBRATION_FACTOR);
  scale.tare(); // Zero scale on startup
  Serial.println("Tare complete. Ready to weigh.");

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Scale Ready!");
  delay(1000);
  lcd.clear();
}

void loop() {
  // Wi-Fi Self-Healing Check (every 30 seconds)
  // wifiMulti.run() automatically reconnects to whichever network is available
  if (millis() - lastWifiCheckTime >= 30000) {
    lastWifiCheckTime = millis();
    if (wifiMulti.run() != WL_CONNECTED) {
      Serial.println("Wi-Fi dropped or searching for network...");
    }
  }

  if (scale.is_ready()) {
    // Read average of 5 measurements
    float weight = scale.get_units(5);

    // Prevent minor negative zero-drift from displaying below 0
    if (weight < 0.005 && weight > -0.010) {
      weight = 0.000;
    }

    // Output to Serial Monitor
    Serial.print("Weight: ");
    Serial.print(weight, 3);
    Serial.println(" kg");

    // Line 1: Weight display
    lcd.setCursor(0, 0);
    lcd.print("Weight:         ");
    lcd.setCursor(8, 0);
    lcd.print(weight, 3);
    lcd.print("kg");

    // Line 2: Real-time Wi-Fi connectivity status
    lcd.setCursor(0, 1);
    if (WiFi.status() == WL_CONNECTED) {
      lcd.print("WiFi: Online    ");
    } else {
      lcd.print("WiFi: Offline   ");
    }

    // Push measurement to Google Sheet at the set interval
    if (millis() - lastLogTime >= LOG_INTERVAL_MS) {
      sendWeightToSheet(weight);
      lastLogTime = millis();
    }

    delay(300);
  } else {
    Serial.println("Waiting for HX711...");
    delay(1000);
  }
}
