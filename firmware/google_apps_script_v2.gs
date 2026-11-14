/**
 * KH COCOSCALE — GOOGLE APPS SCRIPT CLOUD BRIDGE (v2.0)
 * ---------------------------------------------------------------------------
 * Features:
 *  1. Logs ESP32 weight readings (Date, Time, Weight_kg) for Plot1, Plot2, Plot3...
 *     - Keeps Plot1 compatible with your existing first sheet tab (gid=0)
 *     - Auto-creates Plot2 / Plot3 tabs when additional scales come online
 *     - Ignores requests without ?weight= so opening the URL never adds blank rows
 *  2. 2-Way Remote Hardware Control from KH CocoScale Web App:
 *     - Reading Gap Interval (1–240 minutes)
 *     - LCD Backlight Mode ('on' | 'text_only' | 'flash' | 'off')
 *     - Power Mode ('always_on' | 'deep_sleep')
 *     - Remote Tare trigger (one-shot tareId with ESP32 acknowledgement)
 *  3. Mirrors live ESP32 check-in status into a 'DeviceConfig' tab in your Sheet.
 *
 * HOW TO UPDATE YOUR EXISTING DEPLOYMENT:
 *  1. Open your Google Sheet -> Extensions -> Apps Script
 *  2. Replace Code.gs with this entire script and click Save (Ctrl+S)
 *  3. Click Deploy -> Manage deployments -> Pencil (Edit) icon
 *  4. Version: Select "New version" -> Click Deploy
 *     (Using Manage deployments keeps your existing /exec URL unchanged!)
 */

const BRIDGE_VERSION = 2;
const TIMEZONE = "Asia/Kuala_Lumpur"; // GMT+8 Malaysia

function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const action = String(params.action || "").trim();
  const plot = sanitizePlotName(params.plot || "Plot1");
  const callback = params.callback ? String(params.callback).replace(/[^a-zA-Z0-9_$.]/g, "") : "";

  try {
    // 1. Web App updating remote hardware configuration
    if (action === "setConfig") {
      const updated = savePlotConfig(plot, params);
      syncConfigSheetRow(plot, updated);
      return respond({
        ok: true,
        v: BRIDGE_VERSION,
        action: "setConfig",
        plot: plot,
        config: updated
      }, callback);
    }

    // 2. ESP32 or Web App polling current configuration
    if (action === "getConfig") {
      const cfg = loadPlotConfig(plot);
      if (params.fw || params.rssi || params.ackTareId || params.applied) {
        recordEsp32CheckIn(plot, cfg, params, false);
      }
      return respond(buildEspResponse(plot, cfg, false), callback);
    }

    // 3. ESP32 uploading a weight measurement (?weight=12.345&plot=Plot1)
    if (params.weight !== undefined && String(params.weight).trim() !== "") {
      const weightVal = parseFloat(params.weight);
      if (isNaN(weightVal)) {
        return respond({ ok: false, v: BRIDGE_VERSION, error: "Invalid weight value" }, callback);
      }

      appendWeightReading(plot, weightVal, params);
      const cfg = loadPlotConfig(plot);
      recordEsp32CheckIn(plot, cfg, params, true);

      return respond(buildEspResponse(plot, cfg, true), callback);
    }

    // 4. Health check (opened in browser with no params — never writes blank rows)
    return respond({
      ok: true,
      v: BRIDGE_VERSION,
      service: "KH CocoScale Cloud Bridge v2.0",
      plot: plot,
      config: loadPlotConfig(plot)
    }, callback);

  } catch (err) {
    return respond({
      ok: false,
      v: BRIDGE_VERSION,
      error: String(err && err.message ? err.message : err)
    }, callback);
  }
}

function sanitizePlotName(raw) {
  const cleaned = String(raw || "Plot1").replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || "Plot1";
}

function getDefaultConfig() {
  return {
    intervalMin: 1,
    powerMode: "always_on", // 'always_on' | 'deep_sleep'
    lcdMode: "on",          // 'on' | 'text_only' | 'flash' | 'off'
    tareId: 0,
    updatedAt: "",
    lastSeenAt: "",
    lastAckTareId: 0,
    lastRssi: "",
    lastWeightKg: "",
    appliedState: ""
  };
}

function loadPlotConfig(plot) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty("CFG_" + plot);
  const base = getDefaultConfig();
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw);
    return Object.assign(base, parsed);
  } catch (_) {
    return base;
  }
}

function savePlotConfig(plot, params) {
  const cfg = loadPlotConfig(plot);

  if (params.intervalMin !== undefined) {
    const m = parseInt(params.intervalMin, 10);
    if (!isNaN(m)) cfg.intervalMin = Math.max(1, Math.min(240, m));
  }

  if (params.powerMode !== undefined) {
    const pm = String(params.powerMode).trim();
    if (pm === "always_on" || pm === "smart_saver" || pm === "deep_sleep") cfg.powerMode = pm;
  }

  if (params.lcdMode !== undefined) {
    const lm = String(params.lcdMode).trim();
    if (lm === "on" || lm === "text_only" || lm === "flash" || lm === "off") {
      cfg.lcdMode = lm;
    }
  }

  if (String(params.tareCmd || "") === "1") {
    cfg.tareId = Math.floor(Date.now() / 1000);
  }

  cfg.updatedAt = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");

  PropertiesService.getScriptProperties().setProperty("CFG_" + plot, JSON.stringify(cfg));
  return cfg;
}

function recordEsp32CheckIn(plot, cfg, params, forceSheetUpdate) {
  const now = new Date();
  const nowStr = Utilities.formatDate(now, TIMEZONE, "yyyy-MM-dd HH:mm:ss");
  const prevSeen = cfg.lastSeenAt || "";
  let stateChanged = false;

  cfg.lastSeenAt = nowStr;

  if (params.rssi !== undefined && params.rssi !== "") {
    cfg.lastRssi = String(params.rssi);
  }
  if (params.weight !== undefined && params.weight !== "") {
    cfg.lastWeightKg = Number(parseFloat(params.weight).toFixed(3));
  }
  if (params.ackTareId !== undefined && params.ackTareId !== "") {
    const ack = parseInt(params.ackTareId, 10);
    if (!isNaN(ack) && ack !== cfg.lastAckTareId) {
      cfg.lastAckTareId = ack;
      stateChanged = true;
    }
  }
  if (params.applied !== undefined && params.applied !== "") {
    if (cfg.appliedState !== String(params.applied)) {
      cfg.appliedState = String(params.applied);
      stateChanged = true;
    }
  }
  if (params.battVolt !== undefined && params.battVolt !== "") {
    cfg.battVolt = Number(parseFloat(params.battVolt).toFixed(2));
  }
  if (params.battPct !== undefined && params.battPct !== "") {
    cfg.battPct = parseInt(params.battPct, 10);
  }
  if (params.pwrSource !== undefined && params.pwrSource !== "") {
    cfg.pwrSource = String(params.pwrSource);
  }
  if (params.chgState !== undefined && params.chgState !== "") {
    cfg.chgState = String(params.chgState);
  }

  const props = PropertiesService.getScriptProperties();
  props.setProperty("CFG_" + plot, JSON.stringify(cfg));

  // Throttle DeviceConfig sheet writes during 20s heartbeats unless state changed or >=55s elapsed
  const lastSheetWriteMs = Number(props.getProperty("LAST_SW_" + plot) || "0");
  if (forceSheetUpdate || stateChanged || !prevSeen || (now.getTime() - lastSheetWriteMs >= 55000)) {
    props.setProperty("LAST_SW_" + plot, String(now.getTime()));
    syncConfigSheetRow(plot, cfg);
  }
}

function buildEspResponse(plot, cfg, logged) {
  return {
    ok: true,
    v: BRIDGE_VERSION,
    logged: Boolean(logged),
    plot: plot,
    intervalMin: Number(cfg.intervalMin) || 1,
    powerMode: cfg.powerMode || "always_on",
    lcdMode: cfg.lcdMode || "on",
    tareId: Number(cfg.tareId) || 0,
    updatedAt: cfg.updatedAt || "",
    lastSeenAt: cfg.lastSeenAt || "",
    lastRssi: cfg.lastRssi || "",
    appliedState: cfg.appliedState || ""
  };
}

function appendWeightReading(plot, weightVal, params) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(plot);

  // Backward-compatible with existing Plot 1 primary tab (gid=0)
  if (!sheet) {
    if (plot === "Plot1") {
      sheet = ss.getSheets()[0];
    } else {
      sheet = ss.insertSheet(plot);
      sheet.appendRow(["Date", "Time", "Weight_kg", "Battery_V", "Battery_Pct"]);
      sheet.getRange("A1:E1").setFontWeight("bold");
    }
  }

  const now = new Date();
  const dateStr = Utilities.formatDate(now, TIMEZONE, "yyyy-MM-dd");
  const timeStr = Utilities.formatDate(now, TIMEZONE, "HH:mm:ss");

  const row = [dateStr, timeStr, Number(weightVal.toFixed(3))];
  if (params && (params.battVolt !== undefined || params.battPct !== undefined || params.pwrSource !== undefined)) {
    row.push(params.battVolt !== undefined ? Number(parseFloat(params.battVolt).toFixed(2)) : "");
    row.push(params.battPct !== undefined ? parseInt(params.battPct, 10) : "");
    if (params.pwrSource !== undefined || params.chgState !== undefined) {
      row.push(params.pwrSource || "");
      row.push(params.chgState || "");
    }
  }
  sheet.appendRow(row);
}

function syncConfigSheetRow(plot, cfg) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("DeviceConfig");
  const headers = [
    "Plot_Key",
    "Interval_Min",
    "Power_Mode",
    "LCD_Mode",
    "Tare_ID",
    "Updated_At",
    "Last_ESP32_Seen",
    "Last_Ack_Tare_ID",
    "Last_RSSI",
    "Applied_State"
  ];

  if (!sheet) {
    sheet = ss.insertSheet("DeviceConfig");
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  }

  const data = sheet.getDataRange().getValues();
  let targetRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === plot) {
      targetRow = i + 1;
      break;
    }
  }

  const rowValues = [
    plot,
    cfg.intervalMin,
    cfg.powerMode,
    cfg.lcdMode,
    cfg.tareId || 0,
    cfg.updatedAt || "",
    cfg.lastSeenAt || "",
    cfg.lastAckTareId || 0,
    cfg.lastRssi || "",
    cfg.appliedState || ""
  ];

  if (targetRow > 0) {
    sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}

function respond(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
