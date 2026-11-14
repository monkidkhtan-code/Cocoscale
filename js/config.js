/**
 * KH COCOSCALE — CONFIGURATION & MULTI-PLOT STATION REGISTRY
 * Separated standalone app for gravimetric cocopeat moisture monitoring.
 */

const DEFAULT_CONFIG = {
  appName: "KH CocoScale",
  appSubtitle: "Gravimetric Cocopeat Moisture & Dry-Back Monitor",
  farmName: "KH Agrifarm · Chili Fertigation",
  version: "1.3.0",
  pollIntervalSec: 60, // Auto-sync every 60s
  staleMinutes: 35,    // Mark sensor stale if last log > 35 mins old

  // Live RainPoint Cloud Telemetry Bridge (Solar Lux & Temperature °C)
  rainpointEndpointUrl: "https://kh-agrifarm-default-rtdb.asia-southeast1.firebasedatabase.app/telemetry.json",

  // Default Google Sheet & Apps Script Cloud Bridge URLs
  defaultSheetUrl: "https://docs.google.com/spreadsheets/d/1qNIP7qnraa2BVOawSMyFE7bcmNUvLZLjF65Scfz7Yd8/edit?gid=0#gid=0",
  defaultSpreadsheetId: "1qNIP7qnraa2BVOawSMyFE7bcmNUvLZLjF65Scfz7Yd8",
  defaultScriptUrl: "https://script.google.com/macros/s/AKfycbzpVPqtHfPaVJjyqnRiW4oF-FR5359P2ewcCebXO61lufeeXKDYJzviX7xIRhQeiX4xMw/exec",

  // Multi-Scale Station Registry (Extensible: Plot 1 active now, Plot 2 & 3 ready, + unlimited custom stations)
  stations: [
    {
      id: "scale-plot-1",
      name: "Plot 1 — Scale Station 1",
      shortName: "PLOT 1",
      crop: "Chili (Polybag Cocopeat · Prototype Scale)",
      enabled: true,
      color: "#10b981",
      rainpointProbe: "p1_s1",
      deviceControl: {
        plotKey: "Plot1",
        scriptUrl: "https://script.google.com/macros/s/AKfycbzpVPqtHfPaVJjyqnRiW4oF-FR5359P2ewcCebXO61lufeeXKDYJzviX7xIRhQeiX4xMw/exec",
        intervalMin: 1,
        powerMode: "always_on",
        lcdMode: "on",
        batteryMah: 3000
      },
      sheetSource: {
        mode: "sheet_url", // 'sheet_url' | 'apps_script'
        url: "https://docs.google.com/spreadsheets/d/1qNIP7qnraa2BVOawSMyFE7bcmNUvLZLjF65Scfz7Yd8/edit?gid=0#gid=0",
        spreadsheetId: "1qNIP7qnraa2BVOawSMyFE7bcmNUvLZLjF65Scfz7Yd8",
        gid: "0",
        tabName: "Plot1"
      },
      calibration: {
        fieldCapacityKg: 0.65,     // Pre-set to Bench Prototype range (0–0.65 kg); switch to 13.5 kg when polybag is placed
        dryWeightKg: 0.00,         // 0% Baseline tare
        plantBiomassKg: 0.00,      // Plant + fruit growth offset (kg)
        irrigateTriggerPct: 65,    // Refill trigger %
        criticalFloorPct: 40,      // Stress warning floor %
        targetRunoffPct: 15,       // Desired drainage % per fertigation shot for EC flush
        irrigationJumpKg: 0.05,    // 50g jump sensitivity for bench prototype (0.15 kg for field polybag)
        scaleMultiplier: 1.0,      // In-app hardware scale calibration multiplier
        scaleOffset: 0.0           // In-app scale zero offset adjustment (kg)
      }
    },
    {
      id: "scale-plot-2",
      name: "Plot 2 — Scale Station 2",
      shortName: "PLOT 2",
      crop: "Chili (Polybag Cocopeat)",
      enabled: false, // Toggle ON once hardware #2 is deployed
      color: "#38bdf8",
      rainpointProbe: "p2_s1",
      deviceControl: {
        plotKey: "Plot2",
        scriptUrl: "https://script.google.com/macros/s/AKfycbzpVPqtHfPaVJjyqnRiW4oF-FR5359P2ewcCebXO61lufeeXKDYJzviX7xIRhQeiX4xMw/exec",
        intervalMin: 15,
        powerMode: "deep_sleep",
        lcdMode: "off",
        batteryMah: 3000
      },
      sheetSource: {
        mode: "sheet_url",
        url: "https://docs.google.com/spreadsheets/d/1qNIP7qnraa2BVOawSMyFE7bcmNUvLZLjF65Scfz7Yd8/edit?gid=0#gid=0",
        spreadsheetId: "1qNIP7qnraa2BVOawSMyFE7bcmNUvLZLjF65Scfz7Yd8",
        gid: "",
        tabName: "Plot2"
      },
      calibration: {
        fieldCapacityKg: 13.50,
        dryWeightKg: 3.50,
        plantBiomassKg: 0.00,
        irrigateTriggerPct: 70,
        criticalFloorPct: 50,
        targetRunoffPct: 15,
        irrigationJumpKg: 0.15,
        scaleMultiplier: 1.0,
        scaleOffset: 0.0
      }
    },
    {
      id: "scale-plot-3",
      name: "Plot 3 — Scale Station 3",
      shortName: "PLOT 3",
      crop: "Chili (Polybag Cocopeat)",
      enabled: false, // Toggle ON once hardware #3 is deployed
      color: "#f59e0b",
      rainpointProbe: "p2_s2",
      deviceControl: {
        plotKey: "Plot3",
        scriptUrl: "https://script.google.com/macros/s/AKfycbzpVPqtHfPaVJjyqnRiW4oF-FR5359P2ewcCebXO61lufeeXKDYJzviX7xIRhQeiX4xMw/exec",
        intervalMin: 15,
        powerMode: "deep_sleep",
        lcdMode: "off",
        batteryMah: 3000
      },
      sheetSource: {
        mode: "sheet_url",
        url: "https://docs.google.com/spreadsheets/d/1qNIP7qnraa2BVOawSMyFE7bcmNUvLZLjF65Scfz7Yd8/edit?gid=0#gid=0",
        spreadsheetId: "1qNIP7qnraa2BVOawSMyFE7bcmNUvLZLjF65Scfz7Yd8",
        gid: "",
        tabName: "Plot3"
      },
      calibration: {
        fieldCapacityKg: 13.50,
        dryWeightKg: 3.50,
        plantBiomassKg: 0.00,
        irrigateTriggerPct: 70,
        criticalFloorPct: 50,
        targetRunoffPct: 15,
        irrigationJumpKg: 0.15,
        scaleMultiplier: 1.0,
        scaleOffset: 0.0
      }
    }
  ],

  storageKeys: {
    userConfig: "kh_cocoscale_config_v3",
    readingsCachePrefix: "kh_cocoscale_rows_v2_6_",
    rainpointCache: "kh_cocoscale_rainpoint_v1"
  }
};

const STATION_PALETTE = [
  "#10b981", "#38bdf8", "#f59e0b", "#a855f7", "#ec4899", "#14b8a6", "#f97316"
];

class ConfigStore {
  static load() {
    try {
      const saved = localStorage.getItem(DEFAULT_CONFIG.storageKeys.userConfig);
      if (!saved) return structuredClone(DEFAULT_CONFIG);
      const parsed = JSON.parse(saved);
      const rawStations = Array.isArray(parsed.stations) && parsed.stations.length > 0
        ? parsed.stations
        : structuredClone(DEFAULT_CONFIG.stations);

      const stations = rawStations.map((st, idx) => {
        const defSt = DEFAULT_CONFIG.stations[idx] || DEFAULT_CONFIG.stations[0];
        const fallbackPlotKey = st.sheetSource?.tabName || `Plot${idx + 1}`;
        return {
          ...st,
          deviceControl: {
            plotKey: fallbackPlotKey,
            scriptUrl: DEFAULT_CONFIG.defaultScriptUrl,
            intervalMin: 1,
            powerMode: "always_on",
            lcdMode: "on",
            batteryMah: 3000,
            ...(defSt?.deviceControl || {}),
            ...(st.deviceControl || {})
          }
        };
      });

      return {
        ...structuredClone(DEFAULT_CONFIG),
        ...parsed,
        stations
      };
    } catch (e) {
      console.warn("Failed to parse saved config, using defaults:", e);
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  static save(config) {
    try {
      localStorage.setItem(DEFAULT_CONFIG.storageKeys.userConfig, JSON.stringify(config));
    } catch (e) {
      console.error("Failed to save config:", e);
    }
  }

  static reset() {
    localStorage.removeItem(DEFAULT_CONFIG.storageKeys.userConfig);
    return structuredClone(DEFAULT_CONFIG);
  }
}

window.DEFAULT_CONFIG = DEFAULT_CONFIG;
window.STATION_PALETTE = STATION_PALETTE;
window.ConfigStore = ConfigStore;
