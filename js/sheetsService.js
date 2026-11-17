/**
 * KH COCOSCALE — GOOGLE SHEETS & APPS SCRIPT SYNC SERVICE
 * Supports:
 *  1) Standard Google Sheet URL / Spreadsheet ID + GID or Tab Name (Anyone with link: Viewer)
 *  2) Published-to-Web CSV URL (/d/e/2PACX-.../pub)
 *  3) Google Apps Script Web App JSON/CSV Endpoint (script.google.com/macros/s/.../exec)
 * Includes smart MY/US Date + Time disambiguation & Google Sheets 1899-12-30 Time cell handling.
 */

class SheetsService {
  static parseSheetReference(inputUrl = "", fallbackGid = "", fallbackTab = "") {
    const raw = (inputUrl || "").trim();
    if (!raw) return null;

    // 1. Google Apps Script Web App URL
    if (raw.includes("script.google.com/macros/s/")) {
      return { type: "apps_script", url: raw, tabName: fallbackTab };
    }

    // 2. Published-to-web Google Sheet (/spreadsheets/d/e/2PACX-...)
    const pubMatch = raw.match(/spreadsheets\/d\/e\/([a-zA-Z0-9-_]+)/);
    if (pubMatch) {
      const gidMatch = raw.match(/[?&#]gid=([0-9]+)/);
      const gid = fallbackGid || (gidMatch ? gidMatch[1] : "");
      let csvUrl = `https://docs.google.com/spreadsheets/d/e/${pubMatch[1]}/pub?output=csv`;
      if (gid !== "") {
        csvUrl += `&gid=${encodeURIComponent(gid)}&single=true`;
      }
      return { type: "published_csv", csvUrl, gid };
    }

    // 3. Standard Google Sheet URL (/spreadsheets/d/<ID>/...)
    const idMatch = raw.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (idMatch) {
      const spreadsheetId = idMatch[1];
      const urlGidMatch = raw.match(/[?&#]gid=([0-9]+)/);
      const gid = fallbackGid !== "" ? String(fallbackGid) : (urlGidMatch ? urlGidMatch[1] : "");
      return {
        type: "spreadsheet_id",
        spreadsheetId,
        gid,
        tabName: fallbackTab
      };
    }

    // 4. Bare Spreadsheet ID
    if (/^[a-zA-Z0-9-_]{25,60}$/.test(raw)) {
      return {
        type: "spreadsheet_id",
        spreadsheetId: raw,
        gid: fallbackGid !== "" ? String(fallbackGid) : "0",
        tabName: fallbackTab
      };
    }

    // 5. Direct CSV/JSON URL
    return { type: "direct_url", url: raw };
  }

  static buildCandidateUrls(station) {
    const src = station.sheetSource || {};
    const parsed = this.parseSheetReference(
      src.url || src.spreadsheetId || "",
      src.gid ?? "",
      src.tabName || ""
    );
    if (!parsed) return [];

    const cacheBust = `_cb=${Date.now()}`;

    if (parsed.type === "apps_script") {
      const sep = parsed.url.includes("?") ? "&" : "?";
      const plotParam = parsed.tabName ? `plot=${encodeURIComponent(parsed.tabName)}&` : "";
      return [`${parsed.url}${sep}${plotParam}action=read&${cacheBust}`];
    }

    if (parsed.type === "published_csv") {
      return [`${parsed.csvUrl}&${cacheBust}`];
    }

    if (parsed.type === "spreadsheet_id") {
      const id = parsed.spreadsheetId;
      const urls = [];
      if (parsed.gid !== "") {
        urls.push(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(parsed.gid)}&${cacheBust}`);
        urls.push(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodeURIComponent(parsed.gid)}&${cacheBust}`);
      } else if (parsed.tabName) {
        urls.push(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(parsed.tabName)}&${cacheBust}`);
      } else {
        urls.push(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=0&${cacheBust}`);
      }
      return urls;
    }

    return [parsed.url];
  }

  static async fetchStationRows(station, cacheKeyPrefix = "kh_cocoscale_rows_v2_6_") {
    const src = station.sheetSource || {};
    const parsed = this.parseSheetReference(
      src.url || src.spreadsheetId || "",
      src.gid ?? "",
      src.tabName || ""
    );
    const urls = this.buildCandidateUrls(station);
    if (!parsed || urls.length === 0) {
      return { ok: false, reason: "NO_URL", message: "No Google Sheet URL configured for this station.", rows: [] };
    }

    const saveCache = (rows) => {
      try {
        localStorage.setItem(
          `${cacheKeyPrefix}${station.id}`,
          JSON.stringify({
            savedAt: Date.now(),
            rows: rows.map((r) => ({ ...r, ts: r.ts.toISOString() }))
          })
        );
      } catch (_) {}
    };

    // When opened directly via file://, browser fetch() has Origin: null, so use Google's JSONP API first
    if (typeof window !== "undefined" && window.location?.protocol === "file:" && parsed.type === "spreadsheet_id") {
      try {
        const rows = await this.fetchViaGvizJsonp(parsed);
        saveCache(rows);
        return {
          ok: true,
          reason: rows.length > 0 ? "LIVE" : "EMPTY_SHEET",
          message: rows.length > 0 ? `Synced ${rows.length} readings` : "Connected to Google Sheet (no weight rows yet).",
          rows
        };
      } catch (_) {}
    }

    let sawAuthWall = false;
    let lastError = "";

    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: "no-store", credentials: "omit" });
        const text = await res.text();

        if (!text || !text.trim()) continue;

        // Detect Google Account Sign-In HTML wall (Sheet still set to Restricted)
        const trimmed = text.trim();
        if (
          trimmed.startsWith("<!DOCTYPE html") ||
          trimmed.startsWith("<html") ||
          trimmed.includes("accounts.google.com/ServiceLogin") ||
          trimmed.includes("show-login-page")
        ) {
          sawAuthWall = true;
          continue;
        }

        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          continue;
        }

        let rows = [];
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          rows = this.parseJsonPayload(trimmed);
        } else {
          rows = this.parseSheetCsv(trimmed);
        }

        saveCache(rows);
        return {
          ok: true,
          reason: rows.length > 0 ? "LIVE" : "EMPTY_SHEET",
          message: rows.length > 0 ? `Synced ${rows.length} readings` : "Connected to Google Sheet, waiting for first ESP32 weight row.",
          rows
        };
      } catch (err) {
        lastError = err.message || "Network / CORS fetch error";
      }
    }

    // Fallback to Google Visualization JSONP if standard fetch encountered CORS restriction
    if (!sawAuthWall && typeof document !== "undefined" && parsed.type === "spreadsheet_id") {
      try {
        const rows = await this.fetchViaGvizJsonp(parsed);
        saveCache(rows);
        return {
          ok: true,
          reason: rows.length > 0 ? "LIVE" : "EMPTY_SHEET",
          message: rows.length > 0 ? `Synced ${rows.length} readings` : "Connected to Google Sheet (no weight rows yet).",
          rows
        };
      } catch (err) {
        lastError = err.message || lastError;
      }
    }

    if (sawAuthWall) {
      return {
        ok: false,
        reason: "AUTH_REQUIRED",
        message: "Google Sheet is currently set to Restricted (Private). Enable 'Anyone with the link -> Viewer' in Google Sheets.",
        rows: this.loadCachedRows(station.id, cacheKeyPrefix)
      };
    }

    const cached = this.loadCachedRows(station.id, cacheKeyPrefix);
    return {
      ok: false,
      reason: "NETWORK_ERROR",
      message: lastError || "Unable to reach Google Sheets.",
      rows: cached
    };
  }

  /**
   * CORS-free Google Visualization JSONP loader (works even on file:// local HTML)
   */
  static fetchViaGvizJsonp(parsed) {
    return new Promise((resolve, reject) => {
      const cbName = `__cocoGvizCb_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      const script = document.createElement("script");
      let settled = false;

      const cleanup = () => {
        try { delete window[cbName]; } catch (_) { window[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Google Sheet JSONP timeout"));
      }, 9000);

      window[cbName] = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (!payload || payload.status !== "ok" || !payload.table) {
          reject(new Error("Google Sheet returned an error or requires sharing access"));
          return;
        }
        try {
          const grid = this.gvizTableToGrid(payload.table);
          const csvLike = grid.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
          resolve(this.parseSheetCsv(csvLike));
        } catch (e) {
          reject(e);
        }
      };

      script.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error("Failed to load Google Sheet script"));
      };

      let targetParam = "gid=0";
      if (parsed.gid !== "") {
        targetParam = `gid=${encodeURIComponent(parsed.gid)}`;
      } else if (parsed.tabName) {
        targetParam = `sheet=${encodeURIComponent(parsed.tabName)}`;
      }

      script.src = `https://docs.google.com/spreadsheets/d/${parsed.spreadsheetId}/gviz/tq?${targetParam}&tqx=responseHandler:${cbName}&_cb=${Date.now()}`;
      document.head.appendChild(script);
    });
  }

  static gvizTableToGrid(table) {
    const headers = (table.cols || []).map((c) => c.label || c.id || "");
    const grid = [headers];
    for (const rowObj of table.rows || []) {
      const cells = (rowObj.c || []).map((cell) => {
        if (!cell || (cell.v === null && cell.f == null)) return "";
        if (cell.f != null) return String(cell.f).trim();
        const vStr = String(cell.v ?? "");
        const dm = vStr.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)/);
        if (dm) {
          const yr = parseInt(dm[1], 10);
          const mo = String(parseInt(dm[2], 10) + 1).padStart(2, "0");
          const da = String(parseInt(dm[3], 10)).padStart(2, "0");
          if (yr === 1899 && dm[4] !== undefined) {
            return `${String(dm[4]).padStart(2, "0")}:${String(dm[5]).padStart(2, "0")}:${String(dm[6]).padStart(2, "0")}`;
          }
          return `${yr}-${mo}-${da}`;
        }
        return vStr.trim();
      });
      if (cells.some((c) => c !== "")) grid.push(cells);
    }
    return grid;
  }

  static loadCachedRows(stationId, cacheKeyPrefix) {
    try {
      const raw = localStorage.getItem(`${cacheKeyPrefix}${stationId}`);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.rows)) return [];
      return parsed.rows
        .map((r) => ({ ...r, ts: new Date(r.ts) }))
        .filter((r) => !Number.isNaN(r.ts.getTime()));
    } catch (_) {
      return [];
    }
  }

  /**
   * RFC-4180 compliant CSV tokenizer
   */
  static tokenizeCsv(csvText) {
    let text = csvText;
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (ch === '"') {
        if (inQuotes && next === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        row.push(cell.trim());
        cell = "";
      } else if ((ch === "\r" || ch === "\n") && !inQuotes) {
        if (ch === "\r" && next === "\n") i++;
        row.push(cell.trim());
        if (row.some((c) => c !== "")) rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += ch;
      }
    }
    if (cell !== "" || row.length > 0) {
      row.push(cell.trim());
      if (row.some((c) => c !== "")) rows.push(row);
    }
    return rows;
  }

  /**
   * Parse CSV with columns: Date, Time, Weight_kg (flexible header & locale support)
   */
  static parseSheetCsv(csvText) {
    const rawGrid = this.tokenizeCsv(csvText);
    if (rawGrid.length === 0) return [];

    // Locate header row (or detect data on row 0 if headerless)
    let headerIdx = -1;
    let dateCol = 0;
    let timeCol = 1;
    let weightCol = 2;
    let battVoltCol = -1;
    let battPctCol = -1;
    let pwrSourceCol = -1;
    let chgStateCol = -1;
    let weightInGrams = false;

    for (let i = 0; i < Math.min(5, rawGrid.length); i++) {
      const lower = rawGrid[i].map((c) => c.toLowerCase().replace(/[^a-z0-9_]/g, ""));
      const dIdx = lower.findIndex((c) => c.includes("date") || c.includes("tarikh") || c === "timestamp" || c === "datetime");
      const tIdx = lower.findIndex((c) => c === "time" || c.includes("masa") || (c.includes("time") && c !== "timestamp" && c !== "datetime"));
      const wIdx = lower.findIndex((c) => c.includes("weight") || c.includes("berat") || c.includes("kg") || c === "load");
      const bvIdx = lower.findIndex((c) => c.includes("battvolt") || c.includes("batteryvolt") || c === "volt" || c === "voltage");
      const bpIdx = lower.findIndex((c) => c.includes("battpct") || c.includes("batterypct") || c.includes("battery_pct") || c === "batt");
      const psIdx = lower.findIndex((c) => c.includes("pwrsource") || c.includes("powersource") || c.includes("power_source") || c === "source");
      const csIdx = lower.findIndex((c) => c.includes("chgstate") || c.includes("chargestate") || c.includes("charge_state"));

      if (wIdx !== -1 || dIdx !== -1) {
        headerIdx = i;
        if (dIdx !== -1) dateCol = dIdx;
        if (tIdx !== -1) timeCol = tIdx;
        else if (rawGrid[i].length === 2) timeCol = -1; // Combined Timestamp + Weight_kg
        if (wIdx !== -1) {
          weightCol = wIdx;
          if (lower[wIdx].endsWith("_g") || lower[wIdx] === "grams" || lower[wIdx] === "weightg") {
            weightInGrams = true;
          }
        } else if (rawGrid[i].length >= 3) {
          weightCol = 2;
        } else if (rawGrid[i].length === 2) {
          weightCol = 1;
        }
        if (bvIdx !== -1) battVoltCol = bvIdx;
        if (bpIdx !== -1) battPctCol = bpIdx;
        if (psIdx !== -1) pwrSourceCol = psIdx;
        if (csIdx !== -1) chgStateCol = csIdx;

        // Auto-detect standard CocoScale telemetry columns if headers are empty or unlabeled
        // Standard Column Layout: 0: Date, 1: Time, 2: Weight_kg, 3: BattVolt, 4: BattPct, 5: PwrSource, 6: ChgState
        const numCols = rawGrid[i].length;
        if (battVoltCol === -1 && numCols >= 4) battVoltCol = 3;
        if (battPctCol === -1 && numCols >= 5) battPctCol = 4;
        if (pwrSourceCol === -1 && numCols >= 6) pwrSourceCol = 5;
        if (chgStateCol === -1 && numCols >= 7) chgStateCol = 6;
        break;
      }
    }

    const dataRows = headerIdx >= 0 ? rawGrid.slice(headerIdx + 1) : rawGrid;
    if (dataRows.length > 0) {
      const sampleCols = dataRows[0].length;
      if (battVoltCol === -1 && sampleCols >= 4) battVoltCol = 3;
      if (battPctCol === -1 && sampleCols >= 5) battPctCol = 4;
      if (pwrSourceCol === -1 && sampleCols >= 6) pwrSourceCol = 5;
      if (chgStateCol === -1 && sampleCols >= 7) chgStateCol = 6;
    }
    return this.normalizeRecords(
      dataRows.map((cols) => ({
        dateRaw: cols[dateCol] ?? "",
        timeRaw: timeCol >= 0 ? (cols[timeCol] ?? "") : "",
        weightRaw: cols[weightCol] ?? "",
        battVoltRaw: battVoltCol >= 0 ? (cols[battVoltCol] ?? "") : "",
        battPctRaw: battPctCol >= 0 ? (cols[battPctCol] ?? "") : "",
        pwrSourceRaw: pwrSourceCol >= 0 ? (cols[pwrSourceCol] ?? "") : "",
        chgStateRaw: chgStateCol >= 0 ? (cols[chgStateCol] ?? "") : ""
      })),
      weightInGrams
    );
  }

  static parseJsonPayload(jsonText) {
    const parsed = JSON.parse(jsonText);
    const arr = Array.isArray(parsed) ? parsed : (parsed.rows || parsed.data || []);
    if (!Array.isArray(arr)) return [];

    const mapped = arr.map((item) => {
      if (Array.isArray(item)) {
        return {
          dateRaw: String(item[0] ?? ""),
          timeRaw: String(item[1] ?? ""),
          weightRaw: String(item[2] ?? ""),
          battVoltRaw: item[3] !== undefined ? String(item[3]) : "",
          battPctRaw: item[4] !== undefined ? String(item[4]) : "",
          pwrSourceRaw: item[5] !== undefined ? String(item[5]) : "",
          chgStateRaw: item[6] !== undefined ? String(item[6]) : ""
        };
      }
      const keys = Object.keys(item);
      const findKey = (pred) => keys.find((k) => pred(k.toLowerCase()));
      const dKey = findKey((k) => k.includes("date") || k.includes("timestamp")) || keys[0];
      const tKey = findKey((k) => k === "time" || (k.includes("time") && !k.includes("stamp")));
      const wKey = findKey((k) => k.includes("weight") || k.includes("kg")) || keys[keys.length - 1];
      return {
        dateRaw: String(item[dKey] ?? ""),
        timeRaw: tKey ? String(item[tKey] ?? "") : "",
        weightRaw: String(item[wKey] ?? "")
      };
    });

    return this.normalizeRecords(mapped, false);
  }

  /**
   * Smart disambiguation between DD/MM/YYYY (MY) and MM/DD/YYYY (US Sheets default)
   */
  static detectDateOrder(records) {
    let dmyVotes = 0;
    let mdyVotes = 0;

    for (const r of records) {
      const m = String(r.dateRaw).trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
      if (!m) continue;
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (a > 12 && b <= 12) dmyVotes++;
      else if (b > 12 && a <= 12) mdyVotes++;
    }

    if (dmyVotes > mdyVotes) return "DMY";
    if (mdyVotes > dmyVotes) return "MDY";

    // Ambiguous (e.g., 03/11/2026 vs 11/03/2026): pick whichever puts the latest row closest to Date.now()
    const lastSlash = [...records].reverse().find((r) => /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(String(r.dateRaw).trim()));
    if (lastSlash) {
      const m = String(lastSlash.dateRaw).trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
      if (m) {
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        let yr = parseInt(m[3], 10);
        if (yr < 100) yr += 2000;
        const now = Date.now();
        const maxFuture = now + 48 * 3600 * 1000;

        const dmyDate = new Date(yr, b - 1, a, 12, 0, 0).getTime();
        const mdyDate = new Date(yr, a - 1, b, 12, 0, 0).getTime();

        const dmyScore = dmyDate <= maxFuture ? Math.abs(now - dmyDate) : Math.abs(now - dmyDate) + 1e12;
        const mdyScore = mdyDate <= maxFuture ? Math.abs(now - mdyDate) : Math.abs(now - mdyDate) + 1e12;
        return dmyScore <= mdyScore ? "DMY" : "MDY";
      }
    }

    return "DMY"; // Default Malaysia DD/MM/YYYY
  }

  static normalizeRecords(records, weightInGrams = false) {
    const dateOrder = this.detectDateOrder(records);
    const valid = [];

    for (const rec of records) {
      const wClean = String(rec.weightRaw || "").replace(/[^0-9.\-]/g, "");
      if (!wClean) continue;
      let weightKg = parseFloat(wClean);
      if (!Number.isFinite(weightKg) || weightKg < -5) continue;
      if (weightInGrams) weightKg = weightKg / 1000;

      const ts = this.parseDateTime(rec.dateRaw, rec.timeRaw, dateOrder);
      if (!ts || Number.isNaN(ts.getTime())) continue;

      const yyyy = ts.getFullYear();
      const mm = String(ts.getMonth() + 1).padStart(2, "0");
      const dd = String(ts.getDate()).padStart(2, "0");
      const hh = String(ts.getHours()).padStart(2, "0");
      const mi = String(ts.getMinutes()).padStart(2, "0");
      const ss = String(ts.getSeconds()).padStart(2, "0");

      const bvClean = String(rec.battVoltRaw || "").replace(/[^0-9.\-]/g, "");
      const bpClean = String(rec.battPctRaw || "").replace(/[^0-9.\-]/g, "");
      const battVolt = bvClean !== "" ? parseFloat(bvClean) : null;
      const battPct = bpClean !== "" ? Math.round(parseFloat(bpClean)) : (battVolt !== null ? Math.max(0, Math.min(100, Math.round(((battVolt - 3.2) / (4.2 - 3.2)) * 100))) : null);

      valid.push({
        ts,
        dateStr: `${yyyy}-${mm}-${dd}`,
        timeStr: `${hh}:${mi}:${ss}`,
        weightKg: Math.round(weightKg * 1000) / 1000,
        battVolt: (battVolt !== null && Number.isFinite(battVolt)) ? Math.round(battVolt * 100) / 100 : null,
        battPct: (battPct !== null && Number.isFinite(battPct)) ? battPct : null,
        pwrSource: rec.pwrSourceRaw ? String(rec.pwrSourceRaw).trim() : null,
        chgState: rec.chgStateRaw ? String(rec.chgStateRaw).trim() : null
      });
    }

    valid.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    return valid;
  }

  static parseDateTime(dateRaw, timeRaw, dateOrder = "DMY") {
    const dStr = String(dateRaw || "").trim();
    const tStr = String(timeRaw || "").trim();
    if (!dStr && !tStr) return null;

    let year, month, day;

    // 1. ISO YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = dStr.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (isoMatch) {
      year = parseInt(isoMatch[1], 10);
      month = parseInt(isoMatch[2], 10);
      day = parseInt(isoMatch[3], 10);
    } else {
      // 2. Slash/dash D/M/Y or M/D/Y
      const slashMatch = dStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
      if (slashMatch) {
        const p1 = parseInt(slashMatch[1], 10);
        const p2 = parseInt(slashMatch[2], 10);
        year = parseInt(slashMatch[3], 10);
        if (year < 100) year += 2000;
        if (dateOrder === "DMY") {
          day = p1;
          month = p2;
        } else {
          month = p1;
          day = p2;
        }
      } else {
        // 3. Fallback native Date parse (e.g., "Nov 3, 2026" or ISO timestamp)
        const parsedD = new Date(dStr);
        if (!Number.isNaN(parsedD.getTime())) {
          // If no separate time column, and dStr already includes time
          if (!tStr && /\d{1,2}:\d{2}/.test(dStr)) {
            return parsedD;
          }
          year = parsedD.getFullYear();
          month = parsedD.getMonth() + 1;
          day = parsedD.getDate();
        } else {
          return null;
        }
      }
    }

    // Parse time part
    let hours = 0, minutes = 0, seconds = 0;
    if (tStr) {
      // Handle Google Sheets 1899-12-30T... ISO time string from Apps Script JSON
      if (tStr.includes("T") && tStr.includes(":")) {
        const tDate = new Date(tStr);
        if (!Number.isNaN(tDate.getTime())) {
          hours = tDate.getHours();
          minutes = tDate.getMinutes();
          seconds = tDate.getSeconds();
          return new Date(year, month - 1, day, hours, minutes, seconds);
        }
      }

      const tm = tStr.match(/(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM|am|pm)?/);
      if (tm) {
        hours = parseInt(tm[1], 10);
        minutes = parseInt(tm[2], 10);
        seconds = tm[3] ? parseInt(tm[3], 10) : 0;
        const ampm = tm[4] ? tm[4].toUpperCase() : "";
        if (ampm === "PM" && hours < 12) hours += 12;
        if (ampm === "AM" && hours === 12) hours = 0;
      }
    } else {
      // Check if dateRaw also carried HH:mm:ss
      const inlineTm = dStr.match(/(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM|am|pm)?/);
      if (inlineTm) {
        hours = parseInt(inlineTm[1], 10);
        minutes = parseInt(inlineTm[2], 10);
        seconds = inlineTm[3] ? parseInt(inlineTm[3], 10) : 0;
        const ampm = inlineTm[4] ? inlineTm[4].toUpperCase() : "";
        if (ampm === "PM" && hours < 12) hours += 12;
        if (ampm === "AM" && hours === 12) hours = 0;
      }
    }

    return new Date(year, month - 1, day, hours, minutes, seconds);
  }

  /**
   * Fetch saved BagCalibration settings row from Google Sheet 'BagCalibration' tab
   */
  static async fetchSheetBagCalibration(spreadsheetId, scriptUrl, plotKey = "Plot1") {
    // 1. First try Google Apps Script direct getCalibration action
    if (scriptUrl) {
      try {
        const res = await fetch(`${scriptUrl}?action=getCalibration&plot=${encodeURIComponent(plotKey)}&_cb=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.ok && data.calibration) {
            return { ok: true, source: "apps_script", calibration: data.calibration };
          }
        }
      } catch (_) {}
    }

    // 2. Fetch directly from Google Sheets 'BagCalibration' tab using GViz JSONP (CORS-safe)
    if (spreadsheetId) {
      try {
        const rawGrid = await this.fetchRawGvizGrid(spreadsheetId, "BagCalibration");
        if (rawGrid && rawGrid.length > 1) {
          const cleanPlot = String(plotKey).trim().toLowerCase();
          for (let i = 1; i < rawGrid.length; i++) {
            const row = rawGrid[i];
            const rowPlot = String(row[0] || "").trim().toLowerCase();
            if (rowPlot === cleanPlot || rowPlot === cleanPlot.replace(/\s+/g, "") || rowPlot === "plot1") {
              const fc = parseFloat(row[1]);
              const dry = parseFloat(row[2]);
              if (!isNaN(fc) && !isNaN(dry) && fc > 0) {
                const yModeRaw = String(row[10] || "").trim().toLowerCase();
                const yMinRaw = parseFloat(row[11]);
                const yMaxRaw = parseFloat(row[12]);
                const calObj = {
                  fieldCapacityKg: fc,
                  dryWeightKg: dry,
                  plantBiomassKg: parseFloat(row[3]) || 0.0,
                  irrigateTriggerPct: parseFloat(row[4]) || 75,
                  criticalFloorPct: parseFloat(row[5]) || 55,
                  targetRunoffPct: parseFloat(row[6]) || 15,
                  scaleMultiplier: parseFloat(row[7]) || 1.0,
                  scaleOffset: parseFloat(row[8]) || 0.0,
                  updatedAt: String(row[9] || "")
                };
                if (yModeRaw === "fixed" || yModeRaw === "adaptive") calObj.chartYMode = yModeRaw;
                if (!isNaN(yMinRaw)) calObj.chartYMinKg = yMinRaw;
                if (!isNaN(yMaxRaw)) calObj.chartYMaxKg = yMaxRaw;
                return {
                  ok: true,
                  source: "sheet_tab",
                  calibration: calObj
                };
              }
            }
          }
        }
      } catch (_) {}
    }

    return { ok: false };
  }

  /**
   * Push calibration settings to Google Apps Script which writes it into 'BagCalibration' sheet tab
   */
  static async pushSheetBagCalibration(scriptUrl, plotKey, cal) {
    if (!scriptUrl) return { ok: false, reason: "NO_SCRIPT_URL" };
    try {
      const qs = new URLSearchParams({
        action: "saveCalibration",
        plot: plotKey || "Plot1",
        fc: String(cal.fieldCapacityKg),
        dry: String(cal.dryWeightKg),
        biomass: String(cal.plantBiomassKg || 0),
        trigger: String(cal.irrigateTriggerPct || 75),
        critical: String(cal.criticalFloorPct || 55),
        runoff: String(cal.targetRunoffPct || 15),
        mult: String(cal.scaleMultiplier || 1.0),
        offset: String(cal.scaleOffset || 0.0),
        chartYMode: String(cal.chartYMode || "adaptive"),
        chartYMinKg: String(cal.chartYMinKg !== undefined ? cal.chartYMinKg : 2.0),
        chartYMaxKg: String(cal.chartYMaxKg !== undefined ? cal.chartYMaxKg : 9.0),
        _cb: String(Date.now())
      });
      fetch(`${scriptUrl}?${qs.toString()}`, {
        method: "GET",
        mode: "no-cors",
        cache: "no-store"
      }).catch(() => {});
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Raw GViz table fetcher for any sheet tab (e.g. BagCalibration)
   */
  static fetchRawGvizGrid(spreadsheetId, tabName = "BagCalibration") {
    return new Promise((resolve, reject) => {
      const cbName = `__cocoCalGvizCb_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      const script = document.createElement("script");
      let settled = false;

      const cleanup = () => {
        try { delete window[cbName]; } catch (_) { window[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Timeout loading BagCalibration sheet"));
      }, 7000);

      window[cbName] = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (!payload || payload.status !== "ok" || !payload.table) {
          reject(new Error("Sheet error"));
          return;
        }
        try {
          resolve(this.gvizTableToGrid(payload.table));
        } catch (e) {
          reject(e);
        }
      };

      script.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error("Failed to load script"));
      };

      script.src = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?sheet=${encodeURIComponent(tabName)}&tqx=responseHandler:${cbName}&_cb=${Date.now()}`;
      document.head.appendChild(script);
    });
  }
}

window.SheetsService = SheetsService;
