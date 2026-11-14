/**
 * KH COCOSCALE — RAINPOINT LIGHTING (LUX) & TEMPERATURE BRIDGE
 * Pulls real-time & historical Solar Illuminance (Lux) and Temperature (°C)
 * from the KH Agrifarm RainPoint Cloud Telemetry Bridge (Firebase RTDB),
 * ignoring capacitive moisture % so load-cell weight remains the source of truth for moisture.
 */

class RainpointService {
  static PROBE_OPTIONS = [
    { id: "p1_s1", label: "Plot 1 — RainPoint Sensor 1 (D01)" },
    { id: "p2_s1", label: "Plot 2 — RainPoint Sensor 1 (D02)" },
    { id: "p2_s2", label: "Plot 2 — RainPoint Sensor 2 (D03)" },
    { id: "avg",   label: "All Probes Average (Lux & Temp)" },
    { id: "none",  label: "None (Disable RainPoint Overlay)" }
  ];

  static async fetchTelemetry(endpointUrl, cacheKey = "kh_cocoscale_rainpoint_v1") {
    if (!endpointUrl || !endpointUrl.trim()) {
      return { ok: false, message: "No RainPoint telemetry URL configured.", payload: null };
    }

    const sep = endpointUrl.includes("?") ? "&" : "?";
    const url = `${endpointUrl.trim()}${sep}_cb=${Date.now()}`;

    try {
      const res = await fetch(url, { cache: "no-store", credentials: "omit" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      if (!json || (!json.soilSensors && !json.soilHistory)) {
        throw new Error("Telemetry JSON missing soilSensors / soilHistory");
      }

      try {
        localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), payload: json }));
      } catch (_) {}

      return { ok: true, message: "RainPoint synced", payload: json };
    } catch (err) {
      // Fall back only to previously cached real Firebase snapshot
      try {
        const raw = localStorage.getItem(cacheKey);
        if (raw) {
          const cached = JSON.parse(raw);
          if (cached && cached.payload) {
            return { ok: false, cached: true, message: err.message || "Offline cache", payload: cached.payload };
          }
        }
      } catch (_) {}

      return { ok: false, message: err.message || "Unable to reach RainPoint cloud bridge.", payload: null };
    }
  }

  /**
   * Extract live probe snapshot + chronological [{ ts, ms, temp, lux }] series for a probe key
   */
  static extractProbeSeries(payload, probeKey = "p1_s1") {
    if (!payload || !probeKey || probeKey === "none") {
      return { enabled: false, live: null, series: [] };
    }

    const sensorsRoot = payload.soilSensors || {};
    const plots = sensorsRoot.plots || {};
    const p1Sensors = plots["plot-1"]?.sensors || [];
    const p2Sensors = plots["plot-2"]?.sensors || [];

    const d01 = p1Sensors[0] || null;
    const d02 = p2Sensors.find((s) => s.slot === "D02" || s.slot === "s1") || p2Sensors[0] || null;
    const d03 = p2Sensors.find((s) => s.slot === "D03" || s.slot === "s2") || p2Sensors[1] || null;

    let liveObj = null;
    let probeLabel = "";

    if (probeKey === "p1_s1" && d01) {
      probeLabel = "Plot 1 · D01";
      liveObj = d01;
    } else if (probeKey === "p2_s1" && d02) {
      probeLabel = "Plot 2 · D02";
      liveObj = d02;
    } else if (probeKey === "p2_s2" && d03) {
      probeLabel = "Plot 2 · D03";
      liveObj = d03;
    } else if (probeKey === "avg") {
      const available = [d01, d02, d03].filter(Boolean);
      if (available.length > 0) {
        probeLabel = "Farm Avg";
        const avgTemp = available.reduce((s, x) => s + Number(x.temperature || 0), 0) / available.length;
        const avgLux = available.reduce((s, x) => s + Number(x.lux || 0), 0) / available.length;
        const minBat = Math.min(...available.map((x) => Number(x.battery ?? 100)));
        liveObj = {
          temperature: Math.round(avgTemp * 10) / 10,
          lux: Math.round(avgLux),
          battery: minBat,
          syncTime: available[0].syncTime || sensorsRoot.lastUpdated || ""
        };
      }
    }

    let live = null;
    if (liveObj) {
      const syncDate = this.parseRainpointTimestamp(liveObj.syncTime || sensorsRoot.lastUpdated);
      const ageMinutes = syncDate ? Math.max(0, Math.round((Date.now() - syncDate.getTime()) / 60000)) : null;
      live = {
        probeKey,
        probeLabel,
        temperature: Number.isFinite(Number(liveObj.temperature)) ? Number(liveObj.temperature) : null,
        lux: Number.isFinite(Number(liveObj.lux)) ? Math.round(Number(liveObj.lux)) : null,
        battery: liveObj.battery ?? null,
        syncTimeStr: liveObj.syncTime || "",
        syncDate,
        ageMinutes
      };
    }

    // Parse historical records from soilHistory.records
    const rawRecords = payload.soilHistory?.records || [];
    const series = [];

    for (const r of rawRecords) {
      const ts = this.parseRainpointTimestamp(r.timestamp);
      if (!ts) continue;

      let temp = null;
      let lux = null;

      if (probeKey === "p1_s1") {
        temp = r.p1_s1_temp ?? r.temp ?? null;
        lux = r.p1_s1_lux ?? r.lux ?? null;
      } else if (probeKey === "p2_s1") {
        temp = r.p2_s1_temp ?? r.temp ?? null;
        lux = r.p2_s1_lux ?? r.lux ?? null;
      } else if (probeKey === "p2_s2") {
        temp = r.p2_s2_temp ?? r.temp ?? null;
        lux = r.p2_s2_lux ?? r.lux ?? null;
      } else if (probeKey === "avg") {
        const tVals = [r.p1_s1_temp, r.p2_s1_temp, r.p2_s2_temp].filter((v) => v !== undefined && v !== null);
        const lVals = [r.p1_s1_lux, r.p2_s1_lux, r.p2_s2_lux].filter((v) => v !== undefined && v !== null);
        temp = tVals.length ? Math.round((tVals.reduce((a, b) => a + Number(b), 0) / tVals.length) * 10) / 10 : (r.temp ?? null);
        lux = lVals.length ? Math.round(lVals.reduce((a, b) => a + Number(b), 0) / lVals.length) : (r.lux ?? null);
      }

      const numTemp = temp !== null && temp !== "" ? Number(temp) : null;
      const numLux = lux !== null && lux !== "" ? Math.round(Number(lux)) : null;
      if (numTemp === null && numLux === null) continue;

      series.push({
        ts,
        ms: ts.getTime(),
        temp: Number.isFinite(numTemp) ? numTemp : null,
        lux: Number.isFinite(numLux) ? numLux : null
      });
    }

    // Append current live reading if newer than last historical record
    if (live && live.syncDate) {
      const liveMs = live.syncDate.getTime();
      const lastMs = series.length > 0 ? series[series.length - 1].ms : 0;
      if (liveMs > lastMs + 60000) {
        series.push({
          ts: live.syncDate,
          ms: liveMs,
          temp: live.temperature,
          lux: live.lux
        });
      }
    }

    series.sort((a, b) => a.ms - b.ms);

    return {
      enabled: true,
      live,
      series
    };
  }

  static parseRainpointTimestamp(str) {
    if (!str) return null;
    const s = String(str).trim();
    if (!s) return null;

    if (s.includes("T")) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    // Format "2026-11-03 12:55" or "2026-11-03 12:54:30" (Malaysia GMT+8)
    const isoLike = s.replace(" ", "T");
    const withTz = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(isoLike)
      ? `${isoLike}:00+08:00`
      : (/([+-]\d{2}:?\d{2}|Z)$/.test(isoLike) ? isoLike : `${isoLike}+08:00`);
    const d = new Date(withTz);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}

window.RainpointService = RainpointService;
