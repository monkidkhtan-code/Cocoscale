/**
 * KH COCOSCALE — ESP32 INSTANT (<1s) HARDWARE & LCD CONTROL SERVICE
 * Uses a 3-Tier Fast Architecture:
 *  1. Direct LAN HTTP (http://<ESP32-IP>/cmd) -> <50 ms instant switching on same Wi-Fi
 *  2. Firebase RTDB Fast Bridge (cocoscale_devices/<Plot>.json) -> ~80-150 ms cloud push + 1.2s ESP32 Core 0 poll
 *  3. Google Apps Script v2.0 Background Sync -> mirrors settings into the Google Sheet 'DeviceConfig' tab
 */

class DeviceService {
  static FIREBASE_BASE_URL = "https://kh-agrifarm-default-rtdb.asia-southeast1.firebasedatabase.app/cocoscale_devices";

  static INTERVAL_PRESETS = [1, 5, 10, 15, 30, 60];

  static LCD_MODES = [
    {
      id: "on",
      label: "Backlight ON",
      shortLabel: "LCD Glow ON",
      desc: "Screen text + bright LED backlight stay ON while awake (~22 mA)."
    },
    {
      id: "text_only",
      label: "Backlight OFF (Text Only)",
      shortLabel: "Backlight OFF",
      desc: "Switches LED glow OFF immediately (lcd.noBacklight) — saves ~22 mA & night bug-safe."
    },
    {
      id: "flash",
      label: "Flash 8s on Sync",
      shortLabel: "LCD Flash 8s",
      desc: "Backlight stays OFF, lighting up briefly for 8 sec during each Sheet upload."
    },
    {
      id: "off",
      label: "Screen Fully OFF",
      shortLabel: "LCD Dark",
      desc: "Completely dark headless mode. Pressing the ESP32 BOOT button still wakes LCD for 30s."
    }
  ];

  static POWER_MODES = [
    {
      id: "always_on",
      label: "Always Awake (Live 50Hz LCD & Scale)",
      shortLabel: "Always Awake",
      desc: "Keeps HX711 & LCD active continuously (~75–98 mA). Best when calibrating or on USB/Solar."
    },
    {
      id: "smart_saver",
      label: "Smart Saver (<1s Instant Wake · 3× Battery)",
      shortLabel: "Smart Saver (<1s)",
      desc: "Turns LCD & HX711 OFF + 80 MHz + WIFI_PS_MAX_MODEM + 45s cloud poll (~23 mA). Wakes LCD in <1s from App!"
    },
    {
      id: "deep_sleep",
      label: "Ultra Deep Sleep (Max Battery · 5–10+ Days)",
      shortLabel: "Ultra Deep Sleep",
      desc: "Physically shuts down Wi-Fi & CPU (esp_deep_sleep_start) between readings (~9 mA). Wakes on timer or BOOT button."
    }
  ];

  /**
   * Fast read (~80ms) of all ESP32 station states from Firebase Realtime DB,
   * falling back to Google Sheets 'DeviceConfig' tab if offline.
   */
  static async fetchDeviceConfigTab(spreadsheetId) {
    const plots = {};
    let tabExists = false;

    // 1. Primary: Fast Firebase RTDB cocoscale_devices.json (~80ms)
    try {
      const res = await fetch(`${this.FIREBASE_BASE_URL}.json?_cb=${Date.now()}`, {
        cache: "no-store",
        credentials: "omit"
      });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === "object") {
          tabExists = true;
          for (const [plotKey, node] of Object.entries(data)) {
            if (!node || typeof node !== "object") continue;
            plots[plotKey] = this.normalizeDeviceNode(plotKey, node);
          }
        }
      }
    } catch (_) {}

    if (Object.keys(plots).length > 0) {
      return { ok: true, tabExists: true, plots };
    }

    // 2. Fallback: Read-only Google Visualization JSONP on 'DeviceConfig' tab
    return this.fetchFromSheetGviz(spreadsheetId);
  }

  static async fetchSinglePlotFast(plotKey = "Plot1") {
    try {
      const res = await fetch(`${this.FIREBASE_BASE_URL}/${encodeURIComponent(plotKey)}.json?_cb=${Date.now()}`, {
        cache: "no-store",
        credentials: "omit"
      });
      if (!res.ok) return null;
      const node = await res.json();
      if (!node || typeof node !== "object") return null;
      return this.normalizeDeviceNode(plotKey, node);
    } catch (_) {
      return null;
    }
  }

  static normalizeDeviceNode(plotKey, node) {
    const intervalMin = parseInt(node.intervalMin, 10) || 1;
    const powerMode = node.powerMode || "always_on";
    const lcdMode = node.lcdMode || "on";
    const tareId = parseInt(node.tareId, 10) || 0;
    const lastAckTareId = parseInt(node.ackTareId ?? node.lastAckTareId, 10) || 0;
    const appliedState = String(node.appliedState || "");
    const desiredTag = `${intervalMin}:${powerMode}:${lcdMode}`;
    const isAcked = Boolean(appliedState && appliedState === desiredTag && (!tareId || lastAckTareId === tareId));

    const updatedAt = node.updatedAt || "";
    const lastSeenAt = node.lastSeenAt || updatedAt || "";

    return {
      plotKey,
      intervalMin,
      powerMode,
      lcdMode,
      tareId,
      updatedAt,
      lastSeenAt,
      lastSeenDate: this.parseGmt8Timestamp(lastSeenAt),
      lastAckTareId,
      lastRssi: node.rssi !== undefined ? String(node.rssi) : (node.lastRssi || ""),
      battVolt: node.battVolt !== undefined ? Number(node.battVolt) : null,
      battPct: node.battPct !== undefined ? Math.round(Number(node.battPct)) : null,
      pwrSource: node.pwrSource || "",
      chgState: node.chgState || "",
      localIp: node.localIp || "",
      ssid: node.ssid || node.wifiSsid || "",
      fw: node.fw || "",
      calFactor: node.calFactor !== undefined ? Number(node.calFactor) : null,
      nightEco: node.nightEco !== undefined ? (Number(node.nightEco) === 1 || node.nightEco === true) : true,
      nightIntMin: parseInt(node.nightIntMin, 10) || 20,
      activeIntervalMin: parseInt(node.activeIntervalMin, 10) || intervalMin,
      nightEcoActive: Boolean(node.nightEcoActive),
      cloudCalibration: node.cloudCalibration && typeof node.cloudCalibration === "object" ? node.cloudCalibration : null,
      lastWeightKg: node.lastWeightKg !== undefined ? Number(node.lastWeightKg) : null,
      appliedState,
      desiredTag,
      isAcked
    };
  }

  /**
   * Determine whether an ESP32 scale unit is currently Online or Offline.
   * Considers both Firebase Realtime DB heartbeat/check-in and latest Sheet log row.
   */
  static checkDeviceOnlineStatus(cloud, latestSheetRow, intervalMin = 1) {
    let latestActivityMs = 0;
    if (cloud?.lastSeenDate instanceof Date && !isNaN(cloud.lastSeenDate.getTime())) {
      latestActivityMs = Math.max(latestActivityMs, cloud.lastSeenDate.getTime());
    }
    if (latestSheetRow?.ts instanceof Date && !isNaN(latestSheetRow.ts.getTime())) {
      latestActivityMs = Math.max(latestActivityMs, latestSheetRow.ts.getTime());
    }

    if (!latestActivityMs) {
      return {
        isOnline: false,
        status: "offline",
        badge: "🔴 Offline",
        shortBadge: "🔴 Off",
        label: "Offline · Awaiting connection",
        color: "#f87171",
        ageSec: null,
        ageMin: null,
        lastSeenStr: "Never seen"
      };
    }

    const ageSec = Math.max(0, Math.round((Date.now() - latestActivityMs) / 1000));
    const ageMin = ageSec / 60;
    const mins = Math.max(1, Number(intervalMin) || 1);
    // Dynamic timeout threshold: e.g. 1m interval allows ~3.5m; 10m allows ~22m; 30m deep sleep allows ~65m
    const allowedTimeoutMin = Math.max(3.5, mins * 2.2);

    const isOnline = ageMin <= allowedTimeoutMin;

    let timeText = "";
    if (ageSec < 45) {
      timeText = "Active just now";
    } else if (ageSec < 120) {
      timeText = "~1m ago";
    } else if (ageMin < 60) {
      timeText = `${Math.round(ageMin)}m ago`;
    } else if (ageMin < 1440) {
      const h = Math.floor(ageMin / 60);
      const m = Math.round(ageMin % 60);
      timeText = `${h}h ${m}m ago`;
    } else {
      const d = Math.floor(ageMin / 1440);
      timeText = `${d}d ago`;
    }

    if (isOnline) {
      return {
        isOnline: true,
        status: "online",
        badge: "🟢 Online",
        shortBadge: "🟢 On",
        label: `Online · ${timeText}`,
        color: "#34d399",
        ageSec,
        ageMin,
        lastSeenStr: timeText
      };
    }

    return {
      isOnline: false,
      status: "offline",
      badge: "🔴 Offline",
      shortBadge: "🔴 Off",
      label: `Offline · Last seen ${timeText}`,
      color: "#f87171",
      ageSec,
      ageMin,
      lastSeenStr: `Last seen ${timeText}`
    };
  }

  /**
   * Detect Power Source (Direct USB vs Battery) & Charging State (Solar vs USB).
   * Cross-references voltage, discharge/charge slope, and RainPoint Lux.
   */
  static describePowerAndBattery(cloud, historicalRows = [], rainpointLux = null) {
    if (!cloud || cloud.battVolt === null || cloud.battVolt === undefined || isNaN(cloud.battVolt)) {
      return {
        hasData: false,
        hasBatt: false,
        source: "unknown",
        sourceLabel: "Power Unknown",
        sourceSub: "Awaiting ESP32 GPIO 35 voltage telemetry",
        pillLabel: "🔋 --%",
        pillTitle: "Awaiting battery telemetry from GPIO 35",
        label: "🔋 --%",
        shortLabel: "🔋 --%",
        color: "#94a3b8",
        volt: null,
        pct: null,
        desc: "Awaiting signal",
        isCharging: false,
        isSolar: false,
        isUsbDirect: false,
        isBattery: false
      };
    }

    const rawVolt = Number(cloud.battVolt);
    const volt = Math.max(0, rawVolt);
    const fwPwr = String(cloud.pwrSource || "").toLowerCase();
    const fwChg = String(cloud.chgState || "").toLowerCase();

    // 1. Detect Direct USB Power (without battery cell, or continuous 5V rail)
    // When ESP32 is powered via USB cable and the battery holder is empty or disconnected,
    // the voltage divider on GPIO 35 reads 0V (or < 1.8V floating).
    if (volt < 2.0 || volt >= 4.45 || fwPwr === "usb_direct" || fwPwr === "usb_5v") {
      const is5vRail = volt >= 4.45;
      const vStr = is5vRail ? `${volt.toFixed(2)}V` : "0V";
      return {
        hasData: true,
        hasBatt: true,
        source: "usb_direct",
        sourceLabel: "⚡ Direct USB Power",
        sourceSub: is5vRail ? "Continuous 5V USB power supply" : "ESP32 running on USB · Battery disconnected (0V)",
        pillLabel: "⚡ USB Direct",
        pillTitle: `Powered via USB (${vStr}) · No battery cell connected`,
        label: `⚡ USB Direct (${vStr})`,
        shortLabel: "⚡ USB Direct",
        desc: "Direct USB Power (No Battery)",
        color: "#38bdf8",
        volt: volt.toFixed(2),
        pct: 100,
        isCharging: false,
        isSolar: false,
        isUsbDirect: true,
        isBattery: false
      };
    }

    // 2. Battery is Connected (Li-ion 18650 / LiPo 2.8V - 4.40V)
    let pct = cloud.battPct !== null && !isNaN(cloud.battPct)
      ? Math.max(0, Math.min(100, Math.round(cloud.battPct)))
      : Math.max(0, Math.min(100, Math.round(((volt - 3.2) / (4.2 - 3.2)) * 100)));

    // Calculate voltage trend & slope over recent continuous session (last 15 mins to 4 hours)
    let slopePerDay = 0;
    let isRising = false;
    let hasSlope = false;

    if (Array.isArray(historicalRows) && historicalRows.length >= 2) {
      const validRows = historicalRows.filter((r) =>
        r.battPct !== null &&
        !isNaN(r.battPct) &&
        r.ts instanceof Date &&
        (r.battVolt === null || r.battVolt === undefined || (r.battVolt >= 2.5 && r.battVolt <= 4.38))
      );
      if (validRows.length >= 2) {
        const last = validRows[validRows.length - 1];
        let first = validRows[0];

        // Walk backwards from latest reading up to 3.5 hours to find the start of the current continuous trend
        for (let i = validRows.length - 1; i >= 0; i--) {
          const cur = validRows[i];
          const ageHours = (last.ts.getTime() - cur.ts.getTime()) / 3600000;
          if (ageHours > 3.5 && (last.ts.getTime() - first.ts.getTime()) / 3600000 >= 0.15) {
            break;
          }
          if (i < validRows.length - 1) {
            const next = validRows[i + 1];
            const stepPct = Math.abs(next.battPct - cur.battPct);
            const stepGapMin = (next.ts.getTime() - cur.ts.getTime()) / 60000;
            // Stop before a sudden >22% jump in <15 mins (battery swap or charger plug/unplug)
            if (stepPct > 22 && stepGapMin < 15) {
              break;
            }
          }
          first = cur;
        }

        const hours = (last.ts.getTime() - first.ts.getTime()) / 3600000;
        const pctDelta = last.battPct - first.battPct;
        const vDelta = (last.battVolt && first.battVolt) ? (last.battVolt - first.battVolt) : 0;

        if (pctDelta > 0 && hours >= 0.15) {
          // Charging trend can be detected within ~10-15 mins
          hasSlope = true;
          slopePerDay = (pctDelta / hours) * 24;
          if (slopePerDay >= 1.5 && vDelta >= 0.035) {
            isRising = true;
          }
        } else if (pctDelta < 0 && hours >= 2.0) {
          // Require at least 2 hours of discharge before extrapolating a 24h daily slope
          // (avoids multiplying the first 20-30 mins of post-charger surface-charge relaxation by 50x-70x!)
          hasSlope = true;
          slopePerDay = (pctDelta / hours) * 24;
        }
      }
    }

    // Check if firmware explicitly flagged charging (only if above noise floor)
    if (fwChg === "charging") {
      isRising = true;
    }

    // Determine if charging is Solar vs USB
    // Solar criteria: RainPoint sensor reports daytime outdoor light (>= 700 Lux)
    const hasSunlightLux = rainpointLux !== null && rainpointLux >= 700;

    if (isRising) {
      if (hasSunlightLux) {
        // Confirmed Solar Charging via live RainPoint Lux sensor
        const luxNote = `Sunlight: ${Math.round(rainpointLux).toLocaleString()} Lux`;
        return {
          hasData: true,
          hasBatt: true,
          source: "solar_charging",
          sourceLabel: "☀️ Solar Charging",
          sourceSub: `${luxNote} · Solar panel charging battery`,
          pillLabel: `☀️ ${pct}% Solar Chg`,
          pillTitle: `Solar Charging: ${pct}% (${volt.toFixed(2)}V) · ${luxNote}`,
          label: `☀️ ${pct}% Solar Chg (${volt.toFixed(2)}V)`,
          shortLabel: `☀️ ${pct}% Solar`,
          desc: "Solar Charging Active",
          color: "#facc15", // Sun Gold
          volt: volt.toFixed(2),
          pct,
          slopePerDay,
          isCharging: true,
          isSolar: true,
          isUsbDirect: false,
          isBattery: true
        };
      } else {
        // USB Charging (indoors / dark / night)
        return {
          hasData: true,
          hasBatt: true,
          source: "usb_charging",
          sourceLabel: "🔌 USB Charging",
          sourceSub: "Connected to 5V USB charger · Battery gaining charge",
          pillLabel: `🔌 ${pct}% Charging`,
          pillTitle: `USB Charging: ${pct}% (${volt.toFixed(2)}V)`,
          label: `🔌 ${pct}% Charging (${volt.toFixed(2)}V)`,
          shortLabel: `🔌 ${pct}% Chg`,
          desc: "USB Charging Active",
          color: "#2dd4bf", // Teal
          volt: volt.toFixed(2),
          pct,
          slopePerDay,
          isCharging: true,
          isSolar: false,
          isUsbDirect: false,
          isBattery: true
        };
      }
    }

    // Normal Battery Discharge
    let color = "#34d399"; // Green
    let healthDesc = "Healthy / Normal";
    if (pct <= 20) {
      color = "#f87171"; // Red
      healthDesc = "Low / Recharge soon";
    } else if (pct <= 45) {
      color = "#fbbf24"; // Amber
      healthDesc = "Moderate";
    }

    const rateSub = hasSlope && slopePerDay < -0.1
      ? `Discharging at ${slopePerDay.toFixed(1)}%/day`
      : `Discharging · ${healthDesc}`;

    return {
      hasData: true,
      hasBatt: true,
      source: "battery",
      sourceLabel: "🔋 Battery Power",
      sourceSub: `18650 Li-ion Cell (${volt.toFixed(2)}V) · ${rateSub}`,
      pillLabel: `🔋 ${pct}%`,
      pillTitle: `Battery Power: ${pct}% (${volt.toFixed(2)}V) · ${rateSub}`,
      label: `🔋 ${pct}% (${volt.toFixed(2)}V)`,
      shortLabel: `🔋 ${pct}%`,
      desc: healthDesc,
      color,
      volt: volt.toFixed(2),
      pct,
      slopePerDay,
      isCharging: false,
      isSolar: false,
      isUsbDirect: false,
      isBattery: true
    };
  }

  /**
   * Convert Battery voltage/percentage into human-friendly badge & color (delegates to describePowerAndBattery)
   */
  static describeBattery(cloud, historicalRows = [], rainpointLux = null) {
    return this.describePowerAndBattery(cloud, historicalRows, rainpointLux);
  }

  /**
   * Convert ESP32 Wi-Fi RSSI (dBm) into human-friendly signal quality, % and 4-bar level
   */
  static describeWifiSignal(cloud) {
    if (!cloud || cloud.lastRssi === undefined || cloud.lastRssi === "") {
      return {
        hasRssi: false,
        rssi: null,
        pct: 0,
        bars: 0,
        quality: "Awaiting Signal",
        color: "#94a3b8",
        localIp: cloud?.localIp || "",
        ssid: cloud?.ssid || ""
      };
    }

    const rssi = Number(cloud.lastRssi);
    if (!Number.isFinite(rssi) || rssi === 0 || rssi < -115 || rssi > 0) {
      return {
        hasRssi: false,
        rssi: null,
        pct: 0,
        bars: 0,
        quality: "Offline",
        color: "#94a3b8",
        localIp: cloud.localIp || "",
        ssid: cloud.ssid || ""
      };
    }

    // Standard Wi-Fi RSSI (-100 dBm to -50 dBm) -> 0% to 100%
    const pct = Math.min(100, Math.max(4, Math.round(2 * (rssi + 100))));
    let bars = 1;
    let quality = "Weak";
    let color = "#f87171";

    if (rssi >= -58) {
      bars = 4;
      quality = "Excellent";
      color = "#34d399";
    } else if (rssi >= -68) {
      bars = 3;
      quality = "Good";
      color = "#2dd4bf";
    } else if (rssi >= -78) {
      bars = 2;
      quality = "Fair";
      color = "#fbbf24";
    }

    return {
      hasRssi: true,
      rssi,
      pct,
      bars,
      quality,
      color,
      localIp: cloud.localIp || "",
      ssid: cloud.ssid || ""
    };
  }

  /**
   * Instant Push:
   *  1) Direct LAN HTTP to ESP32 (<50ms if on same Wi-Fi & HTTP)
   *  2) Firebase RTDB PATCH (<100ms — ESP32 Core 0 picks up within ~0.6-1.2s!)
   *  3) Non-blocking background sync to Google Apps Script 'DeviceConfig' tab
   */
  static async pushConfig(scriptUrl, { plotKey = "Plot1", intervalMin = 1, powerMode = "always_on", lcdMode = "on", tareCmd = false, calFactor = null, nightEco = null, nightIntMin = null, localIp = "" }) {
    const cleanMin = Math.max(1, Math.min(240, Number(intervalMin) || 1));
    const tareId = tareCmd ? Math.floor(Date.now() / 1000) : undefined;
    const nowStr = this.formatGmt8Now();

    const fbPayload = {
      plotKey,
      intervalMin: cleanMin,
      powerMode,
      lcdMode,
      updatedAt: nowStr
    };
    if (nightEco !== null && nightEco !== undefined) {
      fbPayload.nightEco = nightEco ? 1 : 0;
    }
    if (nightIntMin !== null && !isNaN(nightIntMin) && Number(nightIntMin) >= 5) {
      fbPayload.nightIntMin = Math.max(5, Math.min(240, Number(nightIntMin)));
    }
    if (tareId) {
      fbPayload.tareId = tareId;
    }
    if (calFactor !== null && !isNaN(calFactor) && Number(calFactor) > 0) {
      fbPayload.calFactor = Number(calFactor);
    }

    let lanAcked = false;
    let lanData = null;
    let fbOk = false;

    // 1. Fire Direct LAN HTTP (<50ms) via known localIp or mDNS (cocoscale-plot1.local)
    const lanPromise = (async () => {
      if (window.location.protocol === "https:") return false;
      const hosts = [];
      if (localIp) hosts.push(localIp);
      const mdnsHost = `cocoscale-${plotKey.toLowerCase()}.local`;
      if (!hosts.includes(mdnsHost)) hosts.push(mdnsHost);

      const qs = new URLSearchParams({
        intervalMin: String(cleanMin),
        powerMode,
        lcdMode
      });
      if (tareId) qs.set("tareId", String(tareId));
      if (calFactor !== null && !isNaN(calFactor) && Number(calFactor) > 0) qs.set("calFactor", String(calFactor));

      for (const host of hosts) {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 950);
          const r = await fetch(`http://${host}/cmd?${qs.toString()}`, {
            method: "GET",
            mode: "cors",
            cache: "no-store",
            signal: controller.signal
          });
          clearTimeout(t);
          if (r.ok) {
            lanData = await r.json().catch(() => null);
            lanAcked = true;
            return true;
          }
        } catch (_) {}
      }
      return false;
    })();

    // 2. Fire Firebase RTDB PATCH (~80-120ms)
    const fbPromise = (async () => {
      try {
        if (lanAcked) {
          fbPayload.appliedState = `${cleanMin}:${powerMode}:${lcdMode}`;
        }
        const r = await fetch(`${this.FIREBASE_BASE_URL}/${encodeURIComponent(plotKey)}.json`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fbPayload),
          cache: "no-store",
          credentials: "omit"
        });
        if (r.ok) {
          fbOk = true;
          return true;
        }
      } catch (_) {}
      return false;
    })();

    await Promise.all([lanPromise, fbPromise]);

    // If LAN responded first, make sure Firebase also reflects appliedState immediately
    if (lanAcked && fbOk) {
      fetch(`${this.FIREBASE_BASE_URL}/${encodeURIComponent(plotKey)}.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appliedState: `${cleanMin}:${powerMode}:${lcdMode}` }),
        cache: "no-store",
        credentials: "omit"
      }).catch(() => {});
    }

    // 3. Mirror to Google Apps Script in the background (non-blocking so UI stays instant)
    if (scriptUrl && scriptUrl.trim().startsWith("https://script.google.com/")) {
      const qs = new URLSearchParams({
        action: "setConfig",
        plot: plotKey,
        intervalMin: String(cleanMin),
        powerMode,
        lcdMode,
        _cb: String(Date.now())
      });
      if (tareCmd) qs.set("tareCmd", "1");
      if (calFactor !== null && !isNaN(calFactor) && Number(calFactor) > 0) qs.set("calFactor", String(calFactor));
      const sep = scriptUrl.includes("?") ? "&" : "?";
      fetch(`${scriptUrl.trim()}${sep}${qs.toString()}`, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        mode: "no-cors"
      }).catch(() => {});
    }

    if (fbOk || lanAcked) {
      return {
        ok: true,
        via: lanAcked ? "lan" : "firebase",
        data: {
          ok: true,
          v: 2,
          config: {
            ...fbPayload,
            ...(lanData || {}),
            appliedState: lanAcked ? `${cleanMin}:${powerMode}:${lcdMode}` : ""
          }
        }
      };
    }

    return {
      ok: false,
      reason: "NETWORK_ERROR",
      message: "Could not reach Firebase Cloud Bridge or ESP32 LAN IP. Check your internet connection."
    };
  }

  static fetchFromSheetGviz(spreadsheetId) {
    if (!spreadsheetId) {
      return Promise.resolve({ ok: false, tabExists: false, plots: {} });
    }

    return new Promise((resolve) => {
      const cbName = `__khDevCfgCb_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      const script = document.createElement("script");
      let settled = false;

      const cleanup = () => {
        if (script.parentNode) script.parentNode.removeChild(script);
        try {
          delete window[cbName];
        } catch (_) {
          window[cbName] = undefined;
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: false, tabExists: false, plots: {} });
      }, 8000);

      window[cbName] = (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();

        try {
          if (!resp || resp.status === "error" || !resp.table) {
            resolve({ ok: false, tabExists: false, plots: {} });
            return;
          }

          const cols = (resp.table.cols || []).map((c) => String(c.label || "").trim());
          const rows = resp.table.rows || [];

          let headerInFirstRow = false;
          if (cols[0] !== "Plot_Key") {
            const r0c0 = rows[0]?.c?.[0]?.v ? String(rows[0].c[0].v).trim() : "";
            if (r0c0 === "Plot_Key") {
              headerInFirstRow = true;
            } else {
              resolve({ ok: true, tabExists: false, plots: {} });
              return;
            }
          }

          const plots = {};
          const startIdx = headerInFirstRow ? 1 : 0;
          for (let i = startIdx; i < rows.length; i++) {
            const cells = rows[i]?.c || [];
            const val = (idx) => {
              const cell = cells[idx];
              if (!cell || cell.v === null || cell.v === undefined) return "";
              return cell.f ? String(cell.f).trim() : String(cell.v).trim();
            };

            const plotKey = val(0);
            if (!plotKey || plotKey === "Plot_Key") continue;

            plots[plotKey] = this.normalizeDeviceNode(plotKey, {
              intervalMin: val(1),
              powerMode: val(2),
              lcdMode: val(3),
              tareId: val(4),
              updatedAt: val(5),
              lastSeenAt: val(6),
              lastAckTareId: val(7),
              lastRssi: val(8),
              appliedState: val(9)
            });
          }

          resolve({ ok: true, tabExists: true, plots });
        } catch (_) {
          resolve({ ok: false, tabExists: false, plots: {} });
        }
      };

      script.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({ ok: false, tabExists: false, plots: {} });
      };

      script.src = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/gviz/tq?tqx=responseHandler:${cbName}&sheet=DeviceConfig&_cb=${Date.now()}`;
      document.head.appendChild(script);
    });
  }

  /**
   * Estimate realistic average current draw (mA) and battery runtime (days) for ESP32 DevKit + HX711 + 16x2 I2C LCD
   * (Includes 3.7V->5V boost conversion efficiency and DevKit board quiescent overhead)
   */
  static estimateBatteryProfile({ intervalMin = 15, powerMode = "smart_saver", lcdMode = "off", batteryMah = 3000 }) {
    const mins = Math.max(1, Number(intervalMin) || 15);
    const mah = Math.max(200, Number(batteryMah) || 3000);
    // 3.7V Li-ion stepped up to 5V delivers ~68% of rated 3.7V mAh at the 5V rail
    const usable5vMah = mah * 0.68;

    let avgMa = 0;

    if (powerMode === "deep_sleep") {
      // Ultra Deep Sleep (esp_deep_sleep_start + WIFI_OFF):
      // DevKit CP2102 + AMS1117 + PCF8574 dark quiescent = ~8.5 mA; wakes for 5.5s per interval
      const sleepMa = 8.5;
      const wakeSec = 5.5;
      const cycleSec = Math.max(wakeSec + 2, mins * 60);
      const lcdWakeMa = lcdMode === "on" ? 22 : (lcdMode === "flash" ? 18 : 0);
      const wakeMa = 115 + lcdWakeMa;
      const duty = Math.min(1, wakeSec / cycleSec);
      avgMa = sleepMa * (1 - duty) + wakeMa * duty;
    } else if (powerMode === "smart_saver") {
      // Smart Saver (<1s Instant Wake):
      // 80 MHz + WIFI_PS_MAX_MODEM + btStop + LCD/HX711 OFF + 45s cloud poll (~23.5 mA base + upload burst)
      const uploadBurstAvgMa = (4.5 / (mins * 60)) * 75;
      avgMa = 23.5 + uploadBurstAvgMa;
    } else {
      // Always Awake (240 MHz + WIFI_PS_MIN_MODEM + HX711 active + LCD mode)
      const lcdMa = lcdMode === "on" ? 23.0 : (lcdMode === "flash" ? 2.0 : (lcdMode === "text_only" ? 1.5 : 0.5));
      const uploadBurstAvgMa = (4.5 / (mins * 60)) * 65;
      avgMa = 64.0 + lcdMa + uploadBurstAvgMa;
    }

    const totalHours = usable5vMah / avgMa;
    const days = totalHours / 24;

    return {
      avgMa: Math.round(avgMa * 10) / 10,
      totalHours: Math.round(totalHours),
      days: Math.round(days * 10) / 10
    };
  }

  static estimateBatteryDays(powerMode = "always_on", batteryMah = 3000, intervalMin = 15, lcdMode = "off") {
    return this.estimateBatteryProfile({ intervalMin, powerMode, lcdMode, batteryMah });
  }

  static formatGmt8Now() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.toISOString().replace("T", " ").slice(0, 19);
  }

  static parseGmt8Timestamp(str) {
    if (!str) return null;
    const s = String(str).trim();
    if (!s) return null;
    const iso = s.includes("T") ? s : `${s.replace(" ", "T")}+08:00`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}

window.DeviceService = DeviceService;
