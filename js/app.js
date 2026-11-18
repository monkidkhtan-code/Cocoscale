/**
 * KH COCOSCALE — MAIN DASHBOARD CONTROLLER
 */

class CocoScaleApp {
  constructor() {
    this.config = ConfigStore.load();
    this.selectedStationId = (this.config.stations.find((s) => s.enabled) || this.config.stations[0]).id;
    this.stationData = {}; // { [id]: { rawSync, rows, analysis } }
    this.rainpointSync = null; // { ok, cached, message, payload }
    this.deviceCloudMap = {}; // { [plotKey]: { intervalMin, powerMode, lcdMode, lastSeenAt, ... } }
    this.deviceTabExists = false;
    this.hwDraft = null;
    this.chartMode = this.config.chartPrefs?.mode || "weight"; // 'weight' | 'moisture' | 'compare'
    this.chartHours = Number.isFinite(Number(this.config.chartPrefs?.hours)) ? Number(this.config.chartPrefs.hours) : 24;
    this.chartSelectedDay = null; // null = Live rolling window; Date at local 00:00:00 = single-day view
    this.chartYMode = this.config.chartYScale?.mode || "adaptive"; // 'adaptive' | 'fixed'
    this.chartYMinKg = Number.isFinite(Number(this.config.chartYScale?.minKg)) ? Number(this.config.chartYScale.minKg) : 2.0;
    this.chartYMaxKg = Number.isFinite(Number(this.config.chartYScale?.maxKg)) ? Number(this.config.chartYScale.maxKg) : 9.0;
    this.showLuxOverlay = this.config.chartPrefs?.showLux !== undefined ? Boolean(this.config.chartPrefs.showLux) : true;
    this.showTempOverlay = this.config.chartPrefs?.showTemp !== undefined ? Boolean(this.config.chartPrefs.showTemp) : true;
    this.batteryHours = 12; // Default 12H
    this.batteryChart = null;
    this.chartInstance = null;
    this.pollTimer = null;
    this.countdownTimer = null;
    this.draftStations = null;
    this.stationWeightRows = {};
  }

  getStationRows(stationId) {
    if (!stationId) return [];
    return this.stationData[stationId]?.rows || this.stationData[stationId]?.analysis?.enrichedRows || [];
  }

  async init() {
    if (window.lucide) window.lucide.createIcons();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js?v=1.9.27").then((reg) => {
        reg.update();
        reg.addEventListener("updatefound", () => {
          const installingWorker = reg.installing;
          if (installingWorker) {
            installingWorker.addEventListener("statechange", () => {
              if (installingWorker.state === "installed" && navigator.serviceWorker.controller) {
                console.log("[SW] New version available, reloading...");
                window.location.reload();
              }
            });
          }
        });
      }).catch(() => {});
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        window.location.reload();
      });
    }

    this.bindEvents();
    this.renderStationStrip();
    await this.syncAllEnabledStations();
    this.setupAutoPoll();
    this.setupCountdownTicker();
  }

  bindEvents() {
    document.getElementById("btn-sync-now").addEventListener("click", () => this.syncAllEnabledStations(true));
    const btnReload = document.getElementById("btn-force-reload");
    if (btnReload) {
      btnReload.addEventListener("click", async () => {
        try {
          if ("caches" in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
          if ("serviceWorker" in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const reg of regs) await reg.unregister();
          }
        } catch (_) {}
        window.location.href = window.location.origin + window.location.pathname + "?force=" + Date.now();
      });
    }
    document.getElementById("btn-open-hardware").addEventListener("click", () => this.openHardwareModal());
    document.getElementById("btn-hero-open-hardware").addEventListener("click", () => this.openHardwareModal());
    document.getElementById("btn-instant-lcd-toggle").addEventListener("click", () => this.instantToggleLcdBacklight());
    document.getElementById("btn-open-stations").addEventListener("click", () => this.openStationsModal());
    document.getElementById("btn-open-guide").addEventListener("click", () => this.openModal("modal-guide"));
    const btnChangelog = document.getElementById("btn-open-changelog");
    if (btnChangelog) {
      btnChangelog.addEventListener("click", () => this.openModal("modal-changelog"));
    }
    document.getElementById("btn-open-calibrate").addEventListener("click", () => this.openCalibrateModal());
    document.getElementById("btn-set-fc-now").addEventListener("click", () => this.setCurrentAsFieldCapacity());
    document.getElementById("btn-export-csv").addEventListener("click", () => this.exportActiveCsv());

    // Hardware Control Modal events
    document.getElementById("btn-hw-open-v2-guide").addEventListener("click", () => {
      this.closeModal("modal-hardware");
      this.openModal("modal-guide");
    });
    document.getElementById("hw-interval-presets").addEventListener("click", (e) => {
      const btn = e.target.closest(".hw-interval-btn");
      if (!btn || !this.hwDraft) return;
      const mins = Number(btn.dataset.min) || 1;
      this.hwDraft.intervalMin = mins;
      document.getElementById("hw-interval-input").value = String(mins);
      this.renderHardwareModalSelections();
      this.submitHardwareForm(false);
    });
    document.getElementById("hw-interval-input").addEventListener("input", (e) => {
      if (!this.hwDraft) return;
      this.hwDraft.intervalMin = Math.max(1, Math.min(240, Number(e.target.value) || 1));
      this.renderHardwareModalSelections();
    });
    const nightToggleEl = document.getElementById("hw-night-eco-toggle");
    const nightSelectEl = document.getElementById("hw-night-interval-select");
    if (nightToggleEl) {
      nightToggleEl.addEventListener("change", () => {
        if (!this.hwDraft) return;
        this.hwDraft.nightEco = nightToggleEl.checked;
        if (nightSelectEl) nightSelectEl.disabled = !this.hwDraft.nightEco;
        this.submitHardwareForm(false);
      });
    }
    if (nightSelectEl) {
      nightSelectEl.addEventListener("change", () => {
        if (!this.hwDraft) return;
        this.hwDraft.nightIntMin = Number(nightSelectEl.value) || 20;
        this.submitHardwareForm(false);
      });
    }
    document.getElementById("hw-battery-mah").addEventListener("input", (e) => {
      if (!this.hwDraft) return;
      this.hwDraft.batteryMah = Math.max(300, Number(e.target.value) || 3000);
      this.renderHardwareModalSelections();
    });
    document.getElementById("btn-hw-remote-tare").addEventListener("click", () => {
      const ok = window.confirm(
        "IMPORTANT: Lift the cocopeat polybag OFF the scale first so the platform is 100% empty!\n\nQueue a one-time Remote Tare command for the ESP32?"
      );
      if (ok) this.submitHardwareForm(true);
    });
    document.getElementById("form-hardware").addEventListener("submit", (e) => {
      e.preventDefault();
      this.submitHardwareForm(false);
    });

    // RainPoint Light & Temp overlay toggles
    document.getElementById("btn-overlay-lux").addEventListener("click", (e) => {
      this.showLuxOverlay = !this.showLuxOverlay;
      this.syncChartToolbarUI();
      this.saveChartYScaleSettings();
      this.renderChart();
    });
    document.getElementById("btn-overlay-temp").addEventListener("click", (e) => {
      this.showTempOverlay = !this.showTempOverlay;
      this.syncChartToolbarUI();
      this.saveChartYScaleSettings();
      this.renderChart();
    });

    // Dedicated Battery Modal open triggers
    const liveBattEl = document.getElementById("hw-live-battery");
    if (liveBattEl) liveBattEl.addEventListener("click", () => this.openBatteryModal());

    const hwBattHead = document.getElementById("hw-battery-telemetry-headline");
    if (hwBattHead) hwBattHead.addEventListener("click", () => this.openBatteryModal());

    const btnOpenBatt = document.getElementById("btn-open-battery-from-hw");
    if (btnOpenBatt) {
      btnOpenBatt.addEventListener("click", () => {
        this.closeModal("modal-hardware");
        this.openBatteryModal();
      });
    }

    const btnBattToHw = document.getElementById("btn-batt-open-hardware");
    if (btnBattToHw) {
      btnBattToHw.addEventListener("click", () => {
        this.closeModal("modal-battery");
        this.openHardwareModal();
      });
    }

    // Battery modal chart range buttons
    const battRangeGroup = document.getElementById("batt-chart-range-group");
    if (battRangeGroup) {
      battRangeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest(".pill-btn");
        if (!btn) return;
        this.batteryHours = Number(btn.dataset.hours);
        battRangeGroup.querySelectorAll(".pill-btn").forEach((b) => b.classList.toggle("active", b === btn));
        this.renderBatteryChart();
      });
    }

    // Chart mode pills
    document.getElementById("chart-mode-group").addEventListener("click", (e) => {
      const btn = e.target.closest(".pill-btn");
      if (!btn) return;
      this.chartMode = btn.dataset.mode;
      this.syncChartToolbarUI();
      this.saveChartYScaleSettings();
      this.renderChart();
    });

    // Chart range pills
    document.getElementById("chart-range-group").addEventListener("click", (e) => {
      const btn = e.target.closest(".pill-btn");
      if (!btn) return;
      this.chartHours = Number(btn.dataset.hours);
      this.chartSelectedDay = null;
      this.syncChartToolbarUI();
      this.saveChartYScaleSettings();
      this.renderChart();
    });

    // Day-by-day chart navigation (◀ / Day / ▶)
    const getLocalMidnight = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const btnDayPrev = document.getElementById("btn-chart-day-prev");
    const btnDayLabel = document.getElementById("btn-chart-day-label");
    const btnDayNext = document.getElementById("btn-chart-day-next");
    if (btnDayPrev && btnDayLabel && btnDayNext) {
      btnDayPrev.addEventListener("click", () => {
        const base = this.chartSelectedDay ? new Date(this.chartSelectedDay.getTime()) : getLocalMidnight();
        base.setDate(base.getDate() - 1);
        this.chartSelectedDay = base;
        this.syncChartToolbarUI();
        this.renderChart();
      });
      btnDayNext.addEventListener("click", () => {
        if (!this.chartSelectedDay) return;
        const next = new Date(this.chartSelectedDay.getTime());
        next.setDate(next.getDate() + 1);
        const today = getLocalMidnight();
        this.chartSelectedDay = next.getTime() > today.getTime() ? null : next;
        this.syncChartToolbarUI();
        this.renderChart();
      });
      btnDayLabel.addEventListener("click", () => {
        this.chartSelectedDay = this.chartSelectedDay ? null : getLocalMidnight();
        this.syncChartToolbarUI();
        this.renderChart();
      });
    }

    // Graph Y-Axis Weight Range Settings Panel
    this.syncChartToolbarUI();
    this.syncChartScalePanelUI();
    const btnToggleScale = document.getElementById("btn-toggle-chart-scale");
    const scalePanel = document.getElementById("chart-scale-panel");
    if (btnToggleScale && scalePanel) {
      btnToggleScale.addEventListener("click", () => {
        scalePanel.classList.toggle("hidden");
        this.syncChartScalePanelUI();
      });
    }
    const btnCloseScale = document.getElementById("btn-close-chart-scale");
    if (btnCloseScale && scalePanel) {
      btnCloseScale.addEventListener("click", () => {
        scalePanel.classList.add("hidden");
      });
    }
    const yModeGroup = document.getElementById("chart-y-mode-group");
    if (yModeGroup) {
      yModeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest(".pill-btn");
        if (!btn) return;
        const mode = btn.dataset.ymode;
        if (mode === "adaptive" || mode === "fixed") {
          this.chartYMode = mode;
          this.saveChartYScaleSettings();
          this.syncChartScalePanelUI();
          this.renderChart();
          this.showToast(mode === "adaptive" ? "Graph Y-axis set to Adaptive (Auto-Fit)" : `Graph Y-axis locked to ${this.chartYMinKg.toFixed(1)}–${this.chartYMaxKg.toFixed(1)} kg`);
        }
      });
    }
    const btnApplyScale = document.getElementById("btn-apply-chart-scale");
    if (btnApplyScale) {
      btnApplyScale.addEventListener("click", () => {
        const minIn = parseFloat(document.getElementById("chart-y-min-input")?.value);
        const maxIn = parseFloat(document.getElementById("chart-y-max-input")?.value);
        if (isNaN(minIn) || isNaN(maxIn) || maxIn <= minIn) {
          this.showToast("Max weight must be greater than Min weight.");
          return;
        }
        this.chartYMinKg = Number(minIn.toFixed(2));
        this.chartYMaxKg = Number(maxIn.toFixed(2));
        this.chartYMode = "fixed";
        this.saveChartYScaleSettings();
        this.syncChartScalePanelUI();
        this.renderChart();
        this.showToast(`Locked graph weight range to ${this.chartYMinKg.toFixed(1)} – ${this.chartYMaxKg.toFixed(1)} kg`);
      });
    }
    document.querySelectorAll("[data-yrange-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = btn.dataset.yrangePreset;
        if (preset === "bag") {
          const st = this.getSelectedStation();
          const cal = st?.calibration || {};
          const dry = Number(cal.dryWeightKg) || 3.0;
          const fc = Number(cal.fieldCapacityKg) || 8.5;
          const bio = Number(cal.plantBiomassKg) || 0.0;
          this.chartYMinKg = Math.max(0, Number((dry - 0.5).toFixed(1)));
          this.chartYMaxKg = Number((fc + bio + 0.5).toFixed(1));
        } else {
          const parts = preset.split(",").map(Number);
          if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]) && parts[1] > parts[0]) {
            this.chartYMinKg = parts[0];
            this.chartYMaxKg = parts[1];
          }
        }
        this.chartYMode = "fixed";
        this.saveChartYScaleSettings();
        this.syncChartScalePanelUI();
        this.renderChart();
        this.showToast(`Locked graph weight range to ${this.chartYMinKg.toFixed(1)} – ${this.chartYMaxKg.toFixed(1)} kg`);
      });
    });

    // Modal close buttons (explicit X and Cancel buttons)
    document.querySelectorAll("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => this.closeModal(btn.dataset.close));
    });

    // Backdrop click: Never close form modals (modal-calibrate, modal-hardware, modal-stations)
    // on backdrop click to prevent accidental dismissal while dragging mouse, selecting text, or tuning inputs.
    // For read-only modals, require both mousedown and mouseup directly on the backdrop.
    const formModalIds = new Set(["modal-calibrate", "modal-hardware", "modal-stations"]);
    document.querySelectorAll(".modal-backdrop").forEach((bd) => {
      let mousedownOnBackdrop = false;
      bd.addEventListener("mousedown", (e) => {
        mousedownOnBackdrop = (e.target === bd);
      });
      bd.addEventListener("mouseup", (e) => {
        if (mousedownOnBackdrop && e.target === bd && !formModalIds.has(bd.id)) {
          bd.classList.add("hidden");
        }
        mousedownOnBackdrop = false;
      });
    });

    // Calibration form live preview & save
    document.querySelectorAll("[data-cal-preset]").forEach((btn) => {
      btn.addEventListener("click", () => this.applyCalibrationPreset(btn.dataset.calPreset));
    });
    ["cal-fc-kg", "cal-dry-kg", "cal-biomass-kg", "cal-trig-pct", "cal-crit-pct"].forEach((id) => {
      document.getElementById(id).addEventListener("input", () => this.updateCalibrationModalHints());
    });
    document.getElementById("form-calibrate").addEventListener("submit", (e) => {
      e.preventDefault();
      this.saveCalibrationForm();
    });
    const btnKnownCal = document.getElementById("btn-apply-known-cal");
    if (btnKnownCal) {
      btnKnownCal.addEventListener("click", () => this.applyKnownWeightCalibration());
    }
    const btnFetchLive = document.getElementById("btn-fetch-live-scale");
    if (btnFetchLive) {
      btnFetchLive.addEventListener("click", () => this.fetchLiveWeightForCalibration());
    }

    // Station Manager events
    document.getElementById("btn-add-station").addEventListener("click", () => this.addDraftStation());
    document.getElementById("btn-save-stations").addEventListener("click", () => this.saveStationsModal());

    // Copy Apps Script & Full ESP32 v2 Sketch buttons
    document.getElementById("btn-copy-apps-script").addEventListener("click", async () => {
      try {
        const res = await fetch(`./firmware/google_apps_script_v2.gs?_cb=${Date.now()}`);
        if (!res.ok) throw new Error();
        const code = await res.text();
        await navigator.clipboard.writeText(code);
        this.showToast(`Copied complete Google Apps Script (${code.split("\n").length} lines) with BagCalibration tab support!`);
      } catch (_) {
        const code = document.getElementById("apps-script-snippet").textContent;
        navigator.clipboard.writeText(code).then(() => {
          this.showToast("Copied Google Apps Script snippet to clipboard!");
        });
      }
    });
    document.getElementById("btn-copy-esp32-sketch").addEventListener("click", async () => {
      try {
        const res = await fetch(`./firmware/cocoscale_esp32_v2/cocoscale_esp32_v2.ino?_cb=${Date.now()}`);
        if (!res.ok) throw new Error("Could not load .ino file");
        const ino = await res.text();
        await navigator.clipboard.writeText(ino);
        this.showToast(`Copied complete ESP32 v2 sketch (${ino.split("\n").length} lines) to clipboard!`);
      } catch (_) {
        this.showToast("Open firmware/cocoscale_esp32_v2/cocoscale_esp32_v2.ino directly in Arduino IDE.");
      }
    });
  }

  setupAutoPoll() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    const sec = Number(this.config.pollIntervalSec) || 0;
    if (sec > 0) {
      this.pollTimer = setInterval(() => this.syncAllEnabledStations(false), sec * 1000);
    }
  }

  setupCountdownTicker() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = setInterval(() => this.tickCountdown(), 1000);
    this.tickCountdown();
  }

  getEffectiveIntervalInfo(cloud, dc) {
    const baseMin = Number(cloud?.intervalMin) || Number(dc?.intervalMin) || 10;
    const nightEcoEnabled = cloud?.nightEco !== undefined ? !!cloud.nightEco : (dc?.nightEco !== false);
    const nightIntMin = Number(cloud?.nightIntMin) || Number(dc?.nightIntMin) || 20;
    const hr = new Date().getHours();
    const isNightWindow = hr >= 19 || hr < 6;
    const isNightEco = nightEcoEnabled && isNightWindow;

    if (Number(cloud?.activeIntervalMin) > 0) {
      return {
        mins: Number(cloud.activeIntervalMin),
        isNightEco: isNightEco || Number(cloud.activeIntervalMin) > baseMin
      };
    }
    return {
      mins: isNightEco ? Math.max(baseMin, nightIntMin) : baseMin,
      isNightEco
    };
  }

  tickCountdown() {
    const heroValEl = document.getElementById("hero-countdown-val");
    const barEl = document.getElementById("hw-live-countdown");
    if (!heroValEl && !barEl) return;

    const st = this.getSelectedStation();
    if (!st) return;

    const rows = this.getStationRows(st.id);
    const latestRow = rows.slice(-1)[0] || null;
    const sdc = st.deviceControl || {};
    const cloud = sdc.plotKey ? this.deviceCloudMap[sdc.plotKey] : null;
    const intervalMin = this.getEffectiveIntervalInfo(cloud, sdc).mins;

    if (!latestRow || !(latestRow.ts instanceof Date) || isNaN(latestRow.ts.getTime())) {
      if (heroValEl) heroValEl.textContent = "Awaiting reading";
      if (barEl) barEl.textContent = "⏳ Next: --:--";
      return;
    }

    const lastMs = latestRow.ts.getTime();
    const intervalMs = intervalMin * 60 * 1000;
    const nextTargetMs = lastMs + intervalMs;
    const nowMs = Date.now();
    const diffMs = nextTargetMs - nowMs;

    let countdownStr = "";
    let shortBarStr = "";
    let isImminent = false;
    let isOverdue = false;

    if (diffMs > 0) {
      const totalSec = Math.floor(diffMs / 1000);
      const mm = Math.floor(totalSec / 60);
      const ss = totalSec % 60;
      const ssPad = String(ss).padStart(2, "0");

      if (mm >= 60) {
        const hh = Math.floor(mm / 60);
        const remMm = mm % 60;
        countdownStr = `${hh}h ${remMm}m ${ssPad}s`;
        shortBarStr = `⏳ Next: ${hh}h ${remMm}m`;
      } else {
        countdownStr = `${mm}m ${ssPad}s`;
        shortBarStr = `⏳ Next: ${String(mm).padStart(2, "0")}:${ssPad}`;
      }
      isImminent = diffMs <= 60000;
    } else if (diffMs > -120000) {
      // Due within the last 2 minutes -> scale is waking & logging right now!
      countdownStr = "Capturing now...";
      shortBarStr = "⏳ Capturing now...";
      isImminent = true;
    } else {
      // Overdue
      const overdueMins = Math.floor(Math.abs(diffMs) / 60000);
      countdownStr = `Overdue +${overdueMins}m`;
      shortBarStr = `⏳ Overdue +${overdueMins}m`;
      isOverdue = true;
    }

    if (heroValEl) {
      heroValEl.textContent = countdownStr;
      if (isImminent) {
        heroValEl.style.color = "#34d399";
      } else if (isOverdue) {
        heroValEl.style.color = "#fb923c";
      } else {
        heroValEl.style.color = "#38bdf8";
      }
    }

    if (barEl) {
      barEl.textContent = shortBarStr;
      if (isImminent) {
        barEl.style.color = "#34d399";
        barEl.style.borderColor = "rgba(52, 211, 153, 0.5)";
      } else if (isOverdue) {
        barEl.style.color = "#fb923c";
        barEl.style.borderColor = "rgba(251, 146, 60, 0.5)";
      } else {
        barEl.style.color = "#38bdf8";
        barEl.style.borderColor = "rgba(56, 189, 248, 0.4)";
      }
    }
  }

  getSelectedStation() {
    return this.config.stations.find((s) => s.id === this.selectedStationId) || this.config.stations[0];
  }

  getStationRainpoint(st) {
    const probeKey = st?.rainpointProbe || "p1_s1";
    return RainpointService.extractProbeSeries(this.rainpointSync?.payload, probeKey);
  }

  async syncAllEnabledStations(manual = false) {
    const syncIcon = document.getElementById("icon-sync");
    if (syncIcon) syncIcon.classList.add("spin");
    document.getElementById("sync-status-text").textContent = "Syncing...";

    const enabledStations = this.config.stations.filter((s) => s.enabled);

    const sheetTasks = enabledStations.map(async (st) => {
      const sync = await SheetsService.fetchStationRows(st, this.config.storageKeys.readingsCachePrefix);
      this.stationData[st.id] = {
        rawSync: sync,
        rows: [],
        analysis: null
      };
    });

    const rpTask = RainpointService.fetchTelemetry(
      this.config.rainpointEndpointUrl,
      this.config.storageKeys.rainpointCache
    ).then((res) => {
      this.rainpointSync = res;
    });

    const selSheetId = this.getSelectedStation()?.sheetSource?.spreadsheetId || this.config.defaultSpreadsheetId;
    const devCfgTask = DeviceService.fetchDeviceConfigTab(selSheetId).then((res) => {
      if (res.ok) {
        this.deviceTabExists = res.tabExists;
        if (res.tabExists) {
          this.deviceCloudMap = res.plots || {};
          // Keep station local settings aligned with cloud DeviceConfig truth
          let updatedLocal = false;
          for (const st of this.config.stations) {
            const pk = st.deviceControl?.plotKey;
            const cloud = pk ? this.deviceCloudMap[pk] : null;
            if (cloud) {
              st.deviceControl.intervalMin = cloud.intervalMin;
              st.deviceControl.powerMode = cloud.powerMode;
              st.deviceControl.lcdMode = cloud.lcdMode;
              if (cloud.cloudCalibration && typeof cloud.cloudCalibration === "object" && cloud.cloudCalibration.fieldCapacityKg) {
                st.calibration = { ...st.calibration, ...cloud.cloudCalibration };
              }
              updatedLocal = true;
            }
          }
          if (updatedLocal) ConfigStore.save(this.config);
        }
      }
    });

    const sheetCalTasks = this.config.stations.filter((s) => s.enabled).map(async (st) => {
      const sheetId = st.sheetSource?.spreadsheetId || this.config.defaultSpreadsheetId;
      const scriptUrl = st.deviceControl?.scriptUrl || this.config.defaultScriptUrl;
      const pk = st.deviceControl?.plotKey || st.sheetSource?.tabName || "Plot1";
      try {
        const res = await SheetsService.fetchSheetBagCalibration(sheetId, scriptUrl, pk);
        if (res.ok && res.calibration) {
          st.calibration = { ...st.calibration, ...res.calibration };
          return true;
        }
      } catch (_) {}
      return false;
    });

    await Promise.all([...sheetTasks, rpTask, devCfgTask, ...sheetCalTasks]);

    // Sync Graph settings (Y-Axis range, Light/Temp, Mode, Timeframe) from cloud / Google Sheet BagCalibration
    const activeSt = this.getSelectedStation();
    if (activeSt?.calibration) {
      const cal = activeSt.calibration;
      if (cal.chartYMode === "fixed" || cal.chartYMode === "adaptive") {
        this.chartYMode = cal.chartYMode;
      }
      if (Number.isFinite(Number(cal.chartYMinKg))) {
        this.chartYMinKg = Number(cal.chartYMinKg);
      }
      if (Number.isFinite(Number(cal.chartYMaxKg)) && Number(cal.chartYMaxKg) > this.chartYMinKg) {
        this.chartYMaxKg = Number(cal.chartYMaxKg);
      }
      if (cal.chartShowLux !== undefined) {
        this.showLuxOverlay = Boolean(cal.chartShowLux);
      }
      if (cal.chartShowTemp !== undefined) {
        this.showTempOverlay = Boolean(cal.chartShowTemp);
      }
      if (cal.chartMode === "weight" || cal.chartMode === "moisture" || cal.chartMode === "compare") {
        this.chartMode = cal.chartMode;
      }
      if (cal.chartHours !== undefined && Number.isFinite(Number(cal.chartHours))) {
        this.chartHours = Number(cal.chartHours);
      }
      this.config.chartYScale = {
        mode: this.chartYMode,
        minKg: this.chartYMinKg,
        maxKg: this.chartYMaxKg
      };
      this.config.chartPrefs = {
        showLux: this.showLuxOverlay,
        showTemp: this.showTempOverlay,
        mode: this.chartMode,
        hours: this.chartHours
      };
      ConfigStore.save(this.config);
      this.syncChartToolbarUI();
      this.syncChartScalePanelUI();
    }

    this.recomputeAllStations();
    this.renderAll();
    if (!document.getElementById("modal-hardware").classList.contains("hidden")) {
      this.renderHardwareModalBanner();
    }

    const nowStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    document.getElementById("last-sync-clock").textContent = `Last checked: ${nowStr}`;
    if (syncIcon) syncIcon.classList.remove("spin");

    if (manual) {
      const selSync = this.stationData[this.selectedStationId]?.rawSync;
      const rpNote = this.rainpointSync?.ok ? " + RainPoint Light/Temp" : "";
      if (selSync?.ok) {
        this.showToast(`Synced ${selSync.rows.length} Sheet rows${rpNote}!`);
      } else if (selSync?.reason === "AUTH_REQUIRED") {
        this.showToast("Google Sheet is Restricted — enable 'Anyone with the link (Viewer)'.");
      } else {
        this.showToast(selSync?.message || "Sync completed");
      }
    }
  }

  recomputeAllStations() {
    for (const st of this.config.stations) {
      if (!st.enabled) {
        this.stationData[st.id] = {
          rawSync: { ok: false, reason: "STANDBY", message: "Standby station", rows: [] },
          rows: [],
          analysis: MoistureEngine.analyzeSeries([], st, this.config.staleMinutes)
        };
        continue;
      }

      const existing = this.stationData[st.id]?.rawSync || { ok: false, reason: "PENDING", rows: [] };
      const rows = existing.rows || [];
      const analysis = MoistureEngine.analyzeSeries(rows, st, this.config.staleMinutes);
      this.stationWeightRows[st.id] = rows;
      this.stationData[st.id] = {
        rawSync: existing,
        rows,
        analysis
      };
    }
  }

  renderAll() {
    this.renderHeaderStatus();
    this.renderNoticeBanner();
    this.renderStationStrip();
    this.renderHero();
    this.renderChart();
    this.renderDetails();
    if (window.lucide) window.lucide.createIcons();
  }

  renderHeaderStatus() {
    const pill = document.getElementById("sync-status-pill");
    const txt = document.getElementById("sync-status-text");
    pill.className = "sync-pill";

    const st = this.getSelectedStation();
    const state = this.stationData[st.id];
    if (!st.enabled) {
      txt.textContent = `${st.shortName}: Standby`;
      return;
    }
    if (!state) {
      txt.textContent = "Connecting...";
      return;
    }

    if (state.rawSync?.ok && state.rows.length > 0) {
      pill.classList.add("live");
      txt.textContent = `LIVE SHEET · ${state.rows.length} rows`;
    } else if (state.rawSync?.reason === "AUTH_REQUIRED") {
      pill.classList.add("locked");
      txt.textContent = "SHEET RESTRICTED";
    } else if (state.rows.length > 0) {
      txt.textContent = `CACHED · ${state.rows.length} rows`;
    } else {
      txt.textContent = state.rawSync?.reason === "EMPTY_SHEET" ? "SHEET EMPTY" : "OFFLINE";
    }
  }

  renderNoticeBanner() {
    const banner = document.getElementById("notice-banner");
    const titleEl = document.getElementById("notice-title");
    const descEl = document.getElementById("notice-desc");
    const openBtn = document.getElementById("btn-banner-open-sheet");

    const st = this.getSelectedStation();
    const state = this.stationData[st.id];
    if (!st.enabled || !state) {
      banner.classList.add("hidden");
      return;
    }

    openBtn.href = st.sheetSource?.url || this.config.defaultSheetUrl;

    if (state.rawSync?.reason === "AUTH_REQUIRED") {
      banner.className = "notice-banner";
      titleEl.textContent = "Google Sheet Currently Restricted (Sign-In Wall)";
      descEl.textContent =
        "Open your Google Sheet -> click Share -> change 'Restricted' to 'Anyone with the link (Viewer)', then click Sync Sheet.";
      return;
    }

    if (state.rawSync?.reason === "EMPTY_SHEET") {
      banner.className = "notice-banner info-mode";
      titleEl.textContent = "Google Sheet Connected — Waiting for First ESP32 Reading";
      descEl.textContent =
        "Connected to your Google Sheet. Waiting for Date, Time, Weight_kg rows from your ESP32 load-cell scale.";
      return;
    }

    if (!state.rawSync?.ok && state.rawSync?.reason === "NETWORK_ERROR") {
      banner.className = "notice-banner";
      titleEl.textContent = "Unable to Reach Google Sheets";
      descEl.textContent = state.rows.length > 0
        ? `Showing ${state.rows.length} last-synced rows from local cache (${state.rawSync.message}).`
        : `Could not fetch Google Sheet (${state.rawSync.message}). Check internet connection and click Sync Sheet.`;
      return;
    }

    banner.classList.add("hidden");
  }

  renderStationStrip() {
    const container = document.getElementById("station-strip");
    const tabsHtml = this.config.stations.map((st) => {
      const state = this.stationData[st.id];
      const isSelected = st.id === this.selectedStationId;
      const analysis = state?.analysis;

      if (!st.enabled) {
        return `
          <button type="button" class="station-tab standby ${isSelected ? "selected" : ""}" style="--station-color:${st.color}" data-station-id="${st.id}">
            <span class="station-short">${this.escapeHtml(st.shortName)}</span>
            <span class="status-chip tone-muted" style="font-size:0.62rem; padding:0.1rem 0.4rem;">Standby</span>
          </button>
        `;
      }

      const hasData = analysis && analysis.hasData;
      const m = analysis?.metrics;
      const weightDecimals = hasData && Math.abs(m.rawWeightKg) < 2 ? 3 : 2;
      const weightText = hasData ? `${m.rawWeightKg.toFixed(weightDecimals)} kg` : "--.-- kg";
      const pctText = hasData ? `${m.displayPct.toFixed(1)}%` : "--%";
      const sdc = st.deviceControl || {};
      const sCloud = sdc.plotKey ? this.deviceCloudMap[sdc.plotKey] : null;
      const sRows = this.getStationRows(st.id);
      const sLatest = sRows.slice(-1)[0] || null;
      const sOnline = DeviceService.checkDeviceOnlineStatus(sCloud, sLatest, sdc.intervalMin || 1);
      const onlineDot = `<span style="font-size:0.6rem; color:${sOnline.color};" title="Scale ${sOnline.label}">●</span>`;
      const sRp = this.getStationRainpoint(st);
      const sTemp = sRp?.live?.temperature;
      const sLux = sRp?.live?.lux;
      const sCanDrip = hasData && ((m.rawWeightKg <= m.triggerRawKg) || (m.rawPct <= m.triggerPct)) && (sTemp !== null && sTemp > 28.0) && (sLux !== null && sLux > 500);
      const dripBadge = sCanDrip ? `<span style="font-size:0.65rem; font-weight:800; color:#34d399;" title="All 3 conditions met: Drip Ready!">💧</span>` : "";

      return `
        <button type="button" class="station-tab ${isSelected ? "selected" : ""}" style="--station-color:${st.color}" data-station-id="${st.id}">
          ${onlineDot}
          <span class="station-short">${this.escapeHtml(st.shortName)}</span>
          <span class="station-tab-val mono">${weightText}</span>
          <span class="station-tab-pct mono">${pctText}</span>
          ${dripBadge}
        </button>
      `;
    }).join("");

    const addTabHtml = `
      <button type="button" class="station-tab station-tab-add" id="card-quick-add-station" title="Add or configure Plot 2, Plot 3 &amp; more">
        <i data-lucide="plus-circle" style="width:14px; height:14px;"></i>
        <span>Add Plot</span>
      </button>
    `;

    container.innerHTML = tabsHtml + addTabHtml;

    container.querySelectorAll("[data-station-id]").forEach((tab) => {
      tab.addEventListener("click", () => {
        this.selectedStationId = tab.dataset.stationId;
        this.renderAll();
      });
    });

    document.getElementById("card-quick-add-station")?.addEventListener("click", () => this.openStationsModal());
  }

  renderRainpointBar(st) {
    const luxEl = document.getElementById("rp-live-lux");
    const tempEl = document.getElementById("rp-live-temp");
    const metaEl = document.getElementById("rp-live-meta");
    if (!luxEl || !tempEl || !metaEl) return;

    const rp = this.getStationRainpoint(st);
    if (!rp.enabled) {
      luxEl.textContent = "☀ Off";
      tempEl.textContent = "🌡 Off";
      metaEl.textContent = "Overlay disabled for this station";
      return;
    }

    if (!rp.live) {
      luxEl.textContent = "☀ -- Lux";
      tempEl.textContent = "🌡 -- °C";
      metaEl.textContent = this.rainpointSync ? "RainPoint offline" : "Syncing...";
      return;
    }

    luxEl.textContent = rp.live.lux !== null ? `☀ ${rp.live.lux.toLocaleString()} Lux` : "☀ -- Lux";
    tempEl.textContent = rp.live.temperature !== null ? `🌡 ${rp.live.temperature.toFixed(1)} °C` : "🌡 -- °C";

    let agePart = "";
    if (rp.live.ageMinutes !== null) {
      if (rp.live.ageMinutes <= 6) {
        agePart = "Live";
      } else if (rp.live.ageMinutes < 60) {
        agePart = `${rp.live.ageMinutes}m ago`;
      } else {
        const h = Math.floor(rp.live.ageMinutes / 60);
        const m = rp.live.ageMinutes % 60;
        agePart = `${h}h ${m}m ago`;
      }
    }
    const batPart = rp.live.battery !== null ? ` · 🔋${rp.live.battery}%` : "";
    const cacheTag = this.rainpointSync?.cached ? " (Cached)" : "";
    metaEl.textContent = `${rp.live.probeLabel}${agePart ? ` · ${agePart}` : ""}${batPart}${cacheTag}`;
  }

  renderHardwareLiveBar(st) {
    const onlineEl = document.getElementById("hw-live-online");
    const intEl = document.getElementById("hw-live-interval");
    const powEl = document.getElementById("hw-live-power");
    const lcdEl = document.getElementById("hw-live-lcd");
    const battEl = document.getElementById("hw-live-battery");
    const wifiEl = document.getElementById("hw-live-wifi");
    const syncEl = document.getElementById("hw-live-sync");
    if (!intEl || !powEl || !lcdEl || !syncEl) return;

    const dc = st.deviceControl || {};
    const cloud = dc.plotKey ? this.deviceCloudMap[dc.plotKey] : null;
    const { mins, isNightEco } = this.getEffectiveIntervalInfo(cloud, dc);
    const pMode = cloud?.powerMode || dc.powerMode || "always_on";
    const lMode = cloud?.lcdMode || dc.lcdMode || "on";

    const rows = this.getStationRows(st.id);
    const latestRow = rows.slice(-1)[0] || null;

    if (onlineEl) {
      const onStatus = DeviceService.checkDeviceOnlineStatus(cloud, latestRow, mins);
      onlineEl.textContent = onStatus.badge;
      onlineEl.style.color = onStatus.color;
      onlineEl.style.borderColor = `${onStatus.color}55`;
      onlineEl.className = `wifi-live-pill ${onStatus.isOnline ? "is-online" : "is-offline"}`;
      onlineEl.title = `Scale Connectivity: ${onStatus.label}`;
    }

    const pMeta = DeviceService.POWER_MODES.find((x) => x.id === pMode) || DeviceService.POWER_MODES[0];
    const lMeta = DeviceService.LCD_MODES.find((x) => x.id === lMode) || DeviceService.LCD_MODES[0];

    intEl.textContent = isNightEco ? `Every ${mins}m 🌙 Night` : `Every ${mins}m`;
    powEl.textContent = pMeta.shortLabel;
    lcdEl.textContent = lMeta.shortLabel;
    lcdEl.style.color = lMode === "on" ? "#fde047" : "#94a3b8";

    if (battEl) {
      const pwr = DeviceService.describePowerAndBattery(cloud, rows, this.rainpointSync?.live?.lux ?? null);
      battEl.style.color = pwr.color;
      battEl.style.borderColor = `${pwr.color}55`;
      battEl.textContent = pwr.hasData ? pwr.pillLabel : "🔋 --%";
      battEl.title = pwr.hasData ? `${pwr.pillTitle} (Click for Solar & Battery Curve)` : "Awaiting battery telemetry from GPIO 35";
    }

    if (wifiEl) {
      const wf = DeviceService.describeWifiSignal(cloud);
      if (wf.hasRssi) {
        const barGlyph = ["", "▂___", "▂▄__", "▂▄▆_", "▂▄▆█"][wf.bars] || "▂▄▆█";
        wifiEl.style.color = wf.color;
        wifiEl.style.borderColor = `${wf.color}55`;
        wifiEl.textContent = `${barGlyph} Wi-Fi ${wf.pct}% (${wf.rssi} dBm)`;
        const ipPart = wf.localIp ? ` · IP: ${wf.localIp}` : "";
        const ssidPart = wf.ssid ? ` · SSID: ${wf.ssid}` : "";
        wifiEl.title = `ESP32 Wi-Fi ${wf.quality}: ${wf.rssi} dBm (${wf.pct}%)${ssidPart}${ipPart}`;
      } else {
        wifiEl.style.color = "#94a3b8";
        wifiEl.style.borderColor = "rgba(148, 163, 184, 0.28)";
        wifiEl.textContent = "📶 Wi-Fi --";
        wifiEl.title = "Waiting for ESP32 Wi-Fi RSSI telemetry";
      }
    }

    const quickBtn = document.getElementById("btn-instant-lcd-toggle");
    const quickLbl = document.getElementById("btn-instant-lcd-label");
    if (quickBtn && quickLbl) {
      const isLit = lMode === "on";
      quickLbl.textContent = isLit ? "LCD Light: ON" : "LCD Light: OFF";
      quickBtn.style.borderColor = isLit ? "rgba(250,204,21,0.55)" : "rgba(148,163,184,0.35)";
      quickBtn.style.color = isLit ? "#fde047" : "#cbd5e1";
    }

    if (cloud) {
      let seenText = "";
      if (cloud.lastSeenDate) {
        const ageSec = Math.max(0, Math.round((Date.now() - cloud.lastSeenDate.getTime()) / 1000));
        seenText = ageSec < 90 ? " · Live" : (ageSec < 3600 ? ` · ${Math.round(ageSec / 60)}m ago` : "");
      }
      if (cloud.isAcked) {
        syncEl.style.color = "#34d399";
        syncEl.textContent = `● Active on ESP32${seenText}`;
      } else {
        syncEl.style.color = "#fbbf24";
        syncEl.textContent = `◐ Queued for next check-in${seenText}`;
      }
    } else {
      syncEl.style.color = "var(--text-secondary)";
      syncEl.textContent = "Click Control ESP32";
    }

    this.tickCountdown();
  }

  renderHero() {
    const st = this.getSelectedStation();
    const state = this.stationData[st.id];
    const cal = st.calibration;
    const analysis = state?.analysis;

    document.getElementById("active-station-title").textContent = st.name;
    document.getElementById("btn-open-active-sheet").href = st.sheetSource?.url || this.config.defaultSheetUrl;

    this.renderHardwareLiveBar(st);
    this.renderRainpointBar(st);

    // Update calibration bar & tank markers even when empty
    const previewMetrics = MoistureEngine.computeReadingMetrics(cal.fieldCapacityKg + (cal.plantBiomassKg || 0), cal);
    document.getElementById("marker-fc-kg").textContent = `${previewMetrics.fieldCapacityRawKg.toFixed(1)}kg`;
    document.getElementById("marker-trig-kg").textContent = `${previewMetrics.triggerRawKg.toFixed(1)}kg`;
    document.getElementById("marker-crit-kg").textContent = `${previewMetrics.criticalRawKg.toFixed(1)}kg`;

    document.getElementById("marker-trigger").style.bottom = `${Math.min(88, Math.max(10, cal.irrigateTriggerPct * 0.92))}%`;
    document.getElementById("marker-critical").style.bottom = `${Math.min(80, Math.max(6, cal.criticalFloorPct * 0.92))}%`;

    const visualWrap = document.getElementById("polybag-chili-visual");

    if (!st.enabled) {
      if (visualWrap) visualWrap.className = "bag-tank-wrap state-unloaded";
      document.getElementById("active-status-chip").className = "status-chip tone-muted";
      document.getElementById("active-status-chip").textContent = "Standby Station";
      document.getElementById("bag-water-fill").style.height = "0%";
      document.getElementById("hero-weight-kg").textContent = "--.--";
      document.getElementById("hero-moisture-pct").textContent = "--%";
      document.getElementById("hero-water-liters").textContent = "Station currently in standby mode.";
      document.getElementById("hero-advisory").className = "advisory-box";
      document.getElementById("hero-advisory").textContent =
        `${st.name} is pre-configured and waiting for hardware deployment. Click 'Scale Stations' whenever Scale #${st.shortName.replace(/\D/g, "") || "2"} is ready!`;
      document.getElementById("reading-age-badge").textContent = "Standby";
      this.clearKpis();
      return;
    }

    if (!analysis || !analysis.hasData) {
      if (visualWrap) visualWrap.className = "bag-tank-wrap state-unloaded";
      document.getElementById("active-status-chip").className = "status-chip tone-muted";
      document.getElementById("active-status-chip").textContent = "Awaiting Data";
      document.getElementById("bag-water-fill").style.height = "0%";
      document.getElementById("hero-weight-kg").textContent = "--.--";
      document.getElementById("hero-moisture-pct").textContent = "--%";
      document.getElementById("hero-water-liters").textContent = "Available Water: -- L / -- L";
      document.getElementById("hero-advisory").className = "advisory-box";
      document.getElementById("hero-advisory").textContent =
        "No readings received yet from Google Sheet. Click 'Sync Sheet' to refresh.";
      document.getElementById("reading-age-badge").textContent = "No rows loaded";
      this.clearKpis();
      return;
    }

    const m = analysis.metrics;
    const statusChip = document.getElementById("active-status-chip");
    statusChip.className = `status-chip tone-${m.statusTone}`;
    statusChip.textContent = m.statusLabel;

    if (visualWrap) {
      let vState = "state-optimal";
      if (m.status === "UNLOADED") vState = "state-unloaded";
      else if (m.statusTone === "danger") vState = "state-danger";
      else if (m.statusTone === "warn" || m.statusTone === "watch") vState = "state-warn";
      visualWrap.className = `bag-tank-wrap ${vState}`;
    }

    // Tank fill height (scaled so 100% FC aligns with 92% marker line)
    const tankPct = m.status === "UNLOADED" ? 0 : Math.min(100, Math.max(2, m.displayPct * 0.92));
    const fillEl = document.getElementById("bag-water-fill");
    fillEl.style.height = `${tankPct}%`;
    fillEl.className = "bag-water-fill";
    if (m.statusTone === "warn" || m.statusTone === "watch") fillEl.classList.add("warn");
    if (m.statusTone === "danger") fillEl.classList.add("danger");

    const markerCurrent = document.getElementById("marker-current");
    const markerCurrentKg = document.getElementById("marker-current-kg");
    if (markerCurrent && markerCurrentKg) {
      markerCurrent.style.bottom = `${tankPct}%`;
      markerCurrentKg.textContent = `${m.rawWeightKg.toFixed(2)}kg`;
    }

    const weightDecimals = Math.abs(m.rawWeightKg) < 2 ? 3 : 2;
    document.getElementById("hero-weight-kg").textContent = m.rawWeightKg.toFixed(weightDecimals);
    document.getElementById("hero-moisture-pct").textContent = m.status === "UNLOADED" ? "Tare" : `${m.displayPct.toFixed(1)}%`;
    const waterLitersEl = document.getElementById("hero-water-liters");
    if (m.status === "UNLOADED") {
      waterLitersEl.textContent = `Water Capacity: ${m.waterCapacityKg.toFixed(2)} L · Scale Unloaded (awaiting ${Number(cal.dryWeightKg).toFixed(1)}–${m.fieldCapacityRawKg.toFixed(1)} kg polybag)`;
    } else {
      waterLitersEl.innerHTML = `<div>Water in Bag: ${m.waterKg.toFixed(2)} L / ${m.waterCapacityKg.toFixed(2)} L</div><div>Dry-Back from FC: ${m.dryBackFromFcPct.toFixed(1)}%</div>`;
    }

    const advEl = document.getElementById("hero-advisory");
    advEl.className = `advisory-box ${m.statusTone === "good" ? "" : m.statusTone}`;
    advEl.textContent = m.advisory;

    let humanAge = `${analysis.ageMinutes}m ago`;
    if (analysis.ageMinutes >= 1440) {
      const d = Math.floor(analysis.ageMinutes / 1440);
      const h = Math.floor((analysis.ageMinutes % 1440) / 60);
      humanAge = `${d}d ${h}h ago`;
    } else if (analysis.ageMinutes >= 60) {
      const h = Math.floor(analysis.ageMinutes / 60);
      const mi = analysis.ageMinutes % 60;
      humanAge = `${h}h ${mi}m ago`;
    }

    const ageTxt = analysis.ageMinutes <= 1
      ? "Live · Just now"
      : `${analysis.isStale ? "⚠ Stale · " : ""}${humanAge} (${analysis.latest.dateStr.slice(5)} ${analysis.latest.timeStr.slice(0, 5)})`;
    document.getElementById("reading-age-badge").textContent = ageTxt;

    // KPIs
    document.getElementById("kpi-deficit-ml").textContent = `${m.deficitMl.toLocaleString()} mL`;
    document.getElementById("kpi-deficit-sub").textContent =
      `-${(m.deficitMl / 1000).toFixed(2)} kg below ${m.fieldCapacityRawKg.toFixed(2)} kg FC`;

    document.getElementById("kpi-shot-ml").textContent =
      m.recommendedShotMl > 0 ? `${m.recommendedShotMl.toLocaleString()} mL` : "0 mL (Full)";
    document.getElementById("kpi-shot-sub").textContent =
      `Includes ${cal.targetRunoffPct || 15}% target runoff for EC salt flush`;

    if (analysis.dryBackToday) {
      const db = analysis.dryBackToday;
      document.getElementById("kpi-dryback-today").textContent = `-${db.dropMoisturePct.toFixed(1)}%`;
      document.getElementById("kpi-dryback-sub").textContent =
        `Peak ${db.peakWeightKg.toFixed(2)} kg (-${db.dropMl} mL) · ${db.shotsToday} shot${db.shotsToday === 1 ? "" : "s"} today`;
    } else {
      document.getElementById("kpi-dryback-today").textContent = `${m.dryBackFromFcPct.toFixed(1)}%`;
      document.getElementById("kpi-dryback-sub").textContent = "Awaiting more today's readings";
    }

    if (analysis.dryingRateMlPerHr !== null) {
      document.getElementById("kpi-uptake-rate").textContent = `${analysis.dryingRateMlPerHr} mL/hr`;
      let etaPart = "Trigger reached";
      if (analysis.hoursToTrigger !== null && analysis.hoursToTrigger > 0) {
        const hrs = Math.floor(analysis.hoursToTrigger);
        const mins = Math.round((analysis.hoursToTrigger - hrs) * 60);
        etaPart = hrs > 0 ? `~${hrs}h ${mins}m to trigger` : `~${mins}m to trigger`;
      } else if (analysis.dryingRateMlPerHr === 0) {
        etaPart = "Steady / minimal loss";
      }
      const onb = analysis.overnightDryBack
        ? ` · Overnight: -${analysis.overnightDryBack.lossPct}%`
        : "";
      document.getElementById("kpi-uptake-sub").textContent = `${etaPart}${onb}`;
    } else {
      document.getElementById("kpi-uptake-rate").textContent = "-- mL/hr";
      document.getElementById("kpi-uptake-sub").textContent = "Calculates after ≥20 mins of readings";
    }

    // 3-Parameter Drip Decision (Weight Dry-Back, Temp > 28°C, Light > 500 Lux)
    const rp = this.getStationRainpoint(st);
    this.renderDripDecision(st, m, rp);
  }

  renderDripDecision(st, m, rp) {
    const cardEl = document.getElementById("drip-decision-card");
    const iconEl = document.getElementById("drip-decision-badge-icon");
    const badgeTextEl = document.getElementById("drip-decision-badge-text");
    const summaryEl = document.getElementById("drip-decision-summary");

    const ruleWeightEl = document.getElementById("drip-rule-weight");
    const valWeightEl = document.getElementById("drip-rule-weight-val");

    const ruleTempEl = document.getElementById("drip-rule-temp");
    const valTempEl = document.getElementById("drip-rule-temp-val");

    const ruleLightEl = document.getElementById("drip-rule-light");
    const valLightEl = document.getElementById("drip-rule-light-val");

    if (!cardEl || !badgeTextEl || !summaryEl) return;

    if (!m) {
      cardEl.className = "drip-decision-card hold";
      if (iconEl) iconEl.textContent = "⏸️";
      badgeTextEl.textContent = "AWAITING DATA";
      summaryEl.textContent = "Awaiting scale & weather telemetry...";
      return;
    }

    // 1. Parameter 1: Weight / Moisture Dry-Back Trigger
    // Must be dry back or hit trigger point. If still saturated (above trigger), hold the drip.
    const isDryBackReached = (m.rawWeightKg <= m.triggerRawKg) || (m.rawPct <= m.triggerPct);
    const weightExcessKg = m.rawWeightKg - m.triggerRawKg;
    const excessMl = Math.round(weightExcessKg * 1000);

    const lblWeightEl = document.getElementById("drip-rule-weight-lbl");
    const lblTempEl = document.getElementById("drip-rule-temp-lbl");
    const lblLightEl = document.getElementById("drip-rule-light-lbl");

    if (isDryBackReached) {
      ruleWeightEl.className = "drip-rule-chip pass";
      ruleWeightEl.querySelector(".drip-rule-icon").textContent = "✓";
      if (lblWeightEl) lblWeightEl.textContent = "🌱 Dry-back OK";
      valWeightEl.textContent = `${m.rawWeightKg.toFixed(2)} kg`;
      ruleWeightEl.title = `Current ${m.rawWeightKg.toFixed(2)} kg has reached or dropped below irrigation trigger (${m.triggerRawKg.toFixed(2)} kg / ${m.triggerPct}%). Dry-back satisfied.`;
    } else {
      ruleWeightEl.className = "drip-rule-chip fail";
      ruleWeightEl.querySelector(".drip-rule-icon").textContent = "✕";
      if (lblWeightEl) lblWeightEl.textContent = "💧 Saturated";
      valWeightEl.textContent = `${m.rawWeightKg.toFixed(2)} kg`;
      ruleWeightEl.title = `Current ${m.rawWeightKg.toFixed(2)} kg is ${excessMl} mL above the irrigation trigger (${m.triggerRawKg.toFixed(2)} kg). Cocopeat still holds adequate moisture.`;
    }

    // 2. Parameter 2: Temperature > 28°C
    const temp = rp?.live?.temperature ?? null;
    const isTempOk = (temp !== null && !isNaN(temp) && temp > 28.0);

    if (temp === null || isNaN(temp)) {
      ruleTempEl.className = "drip-rule-chip fail";
      ruleTempEl.querySelector(".drip-rule-icon").textContent = "✕";
      if (lblTempEl) lblTempEl.textContent = "🌡️ No Temp";
      valTempEl.textContent = "-- °C";
      ruleTempEl.title = "Awaiting live temperature from RainPoint climate sensor.";
    } else if (isTempOk) {
      ruleTempEl.className = "drip-rule-chip pass";
      ruleTempEl.querySelector(".drip-rule-icon").textContent = "✓";
      if (lblTempEl) lblTempEl.textContent = "🌡️ Ideal Temp";
      valTempEl.textContent = `${temp.toFixed(1)} °C`;
      ruleTempEl.title = `Ambient temperature is ${temp.toFixed(1)}°C (>28°C). Chili root uptake and leaf transpiration are active.`;
    } else {
      ruleTempEl.className = "drip-rule-chip fail";
      ruleTempEl.querySelector(".drip-rule-icon").textContent = "✕";
      if (lblTempEl) lblTempEl.textContent = "❄️ Cool Temp";
      valTempEl.textContent = `${temp.toFixed(1)} °C`;
      ruleTempEl.title = `Ambient temperature is ${temp.toFixed(1)}°C (≤28°C). Transpiration is low; irrigating now risks root suffocation.`;
    }

    // 3. Parameter 3: Light > 500 Lux
    const lux = rp?.live?.lux ?? null;
    const isLightOk = (lux !== null && !isNaN(lux) && lux > 500);

    if (lux === null || isNaN(lux)) {
      ruleLightEl.className = "drip-rule-chip fail";
      ruleLightEl.querySelector(".drip-rule-icon").textContent = "✕";
      if (lblLightEl) lblLightEl.textContent = "🌥️ No Light";
      valLightEl.textContent = "-- Lx";
      ruleLightEl.title = "Awaiting live light reading from RainPoint sensor.";
    } else if (isLightOk) {
      ruleLightEl.className = "drip-rule-chip pass";
      ruleLightEl.querySelector(".drip-rule-icon").textContent = "✓";
      if (lblLightEl) lblLightEl.textContent = "☀️ Bright Sun";
      valLightEl.textContent = `${Math.round(lux).toLocaleString()} Lx`;
      ruleLightEl.title = `Solar radiation is ${Math.round(lux).toLocaleString()} Lux (>500 Lux). Stomata are open and photosynthesizing.`;
    } else {
      ruleLightEl.className = "drip-rule-chip fail";
      ruleLightEl.querySelector(".drip-rule-icon").textContent = "✕";
      if (lblLightEl) lblLightEl.textContent = `${lux <= 50 ? "🌙" : "☁️"} Low Light`;
      valLightEl.textContent = `${Math.round(lux).toLocaleString()} Lx`;
      ruleLightEl.title = `Solar radiation is ${Math.round(lux).toLocaleString()} Lux (≤500 Lux). Insufficient sunlight for active water uptake.`;
    }

    // Combined Drip Advisory Decision
    const canDrip = isDryBackReached && isTempOk && isLightOk;

    if (canDrip) {
      cardEl.className = "drip-decision-card proceed";
      if (iconEl) iconEl.textContent = "🟢";
      badgeTextEl.textContent = "PROCEED TO DRIP";
      const shotTxt = m.recommendedShotMl > 0 ? ` Apply recommended dose (~${m.recommendedShotMl.toLocaleString()} mL).` : "";
      summaryEl.textContent = `All 3 conditions satisfied: Dry-back reached, temp is ${temp.toFixed(1)}°C (>28°C), and solar light is ${Math.round(lux).toLocaleString()} Lux (>500 Lx).${shotTxt}`;
    } else {
      cardEl.className = "drip-decision-card hold";
      if (iconEl) iconEl.textContent = "🛑";
      badgeTextEl.textContent = "HOLD DRIP";

      const holdReasons = [];
      if (!isDryBackReached) {
        holdReasons.push(`Moisture still saturated (+${excessMl} mL above trigger)`);
      }
      if (!isTempOk) {
        if (temp === null) holdReasons.push("Awaiting temperature data");
        else holdReasons.push(`Temp ${temp.toFixed(1)}°C is ≤ 28.0°C`);
      }
      if (!isLightOk) {
        if (lux === null) holdReasons.push("Awaiting light data");
        else holdReasons.push(`Light ${Math.round(lux).toLocaleString()} Lx is ≤ 500 Lx`);
      }
      summaryEl.textContent = `Hold Drip: ${holdReasons.join(" · ")}.`;
    }
  }

  clearKpis() {
    document.getElementById("kpi-deficit-ml").textContent = "-- mL";
    document.getElementById("kpi-shot-ml").textContent = "-- mL";
    document.getElementById("kpi-dryback-today").textContent = "--%";
    document.getElementById("kpi-uptake-rate").textContent = "-- mL/hr";
    const cardEl = document.getElementById("drip-decision-card");
    if (cardEl) {
      cardEl.className = "drip-decision-card hold";
      const iconEl = document.getElementById("drip-decision-badge-icon");
      if (iconEl) iconEl.textContent = "⏸️";
      document.getElementById("drip-decision-badge-text").textContent = "AWAITING DATA";
      document.getElementById("drip-decision-summary").textContent = "Awaiting live scale & RainPoint weather telemetry...";
      document.getElementById("drip-rule-weight-val").textContent = "-- kg (Awaiting)";
      document.getElementById("drip-rule-temp-val").textContent = "-- °C";
      document.getElementById("drip-rule-light-val").textContent = "-- Lux";
      document.getElementById("drip-rule-weight").className = "drip-rule-chip fail";
      document.getElementById("drip-rule-temp").className = "drip-rule-chip fail";
      document.getElementById("drip-rule-light").className = "drip-rule-chip fail";
    }
    const heroValEl = document.getElementById("hero-countdown-val");
    if (heroValEl) heroValEl.textContent = "--:--";
    const barEl = document.getElementById("hw-live-countdown");
    if (barEl) barEl.textContent = "⏳ Next: --:--";
  }

  renderChart() {
    const ctx = document.getElementById("telemetry-chart").getContext("2d");
    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }

    const st = this.getSelectedStation();
    const state = this.stationData[st.id];
    const cal = st.calibration;

    // Resolve RainPoint probe series (use Farm Avg in Compare mode, or station-linked probe otherwise)
    const rp = this.chartMode === "compare"
      ? RainpointService.extractProbeSeries(this.rainpointSync?.payload, "avg")
      : this.getStationRainpoint(st);
    const overlaysWanted = rp.enabled && (this.showLuxOverlay || this.showTempOverlay);

    // Compute common time cutoff anchored to newest available timestamp across active streams
    let latestWeightMs = 0;
    if (this.chartMode === "compare") {
      for (const s of this.config.stations) {
        const er = this.stationData[s.id]?.analysis?.enrichedRows;
        if (s.enabled && er && er.length > 0) {
          latestWeightMs = Math.max(latestWeightMs, er[er.length - 1].ts.getTime());
        }
      }
    } else if (state?.analysis?.hasData) {
      const er = state.analysis.enrichedRows;
      latestWeightMs = er[er.length - 1].ts.getTime();
    }

    const latestRpMs = overlaysWanted && rp.series.length > 0
      ? rp.series[rp.series.length - 1].ms
      : 0;
    const anchorMs = Math.max(latestWeightMs, latestRpMs);
    const dayStartMs = this.chartSelectedDay ? this.chartSelectedDay.getTime() : 0;
    const dayEndMs = this.chartSelectedDay ? dayStartMs + 24 * 3600 * 1000 - 1 : 0;
    const cutoffMs = !this.chartSelectedDay && this.chartHours > 0 && anchorMs > 0
      ? anchorMs - this.chartHours * 3600 * 1000
      : 0;

    const filterWeightRows = (rows) => {
      if (!rows || rows.length === 0) return [];
      if (this.chartSelectedDay) {
        return rows.filter((r) => {
          const t = r.ts.getTime();
          return t >= dayStartMs && t <= dayEndMs;
        });
      }
      if (!cutoffMs) return rows;
      return rows.filter((r) => r.ts.getTime() >= cutoffMs);
    };

    const rpFiltered = overlaysWanted
      ? (this.chartSelectedDay
          ? rp.series.filter((p) => p.ms >= dayStartMs && p.ms <= dayEndMs)
          : (cutoffMs ? rp.series.filter((p) => p.ms >= cutoffMs) : rp.series))
      : [];

    let datasets = [];
    let refLines = [];
    let activeWeightRows = [];
    let allX = [];

    if (this.chartMode === "compare") {
      const enabled = this.config.stations.filter((s) => s.enabled && this.stationData[s.id]?.analysis?.hasData);
      datasets = enabled.map((s) => {
        const sRows = filterWeightRows(this.stationData[s.id].analysis.enrichedRows);
        const pts = sRows.map((r) => {
          const ms = r.ts.getTime();
          allX.push(ms);
          return { x: ms, y: r.moisturePct };
        });
        return {
          label: `${s.shortName} Moisture (%)`,
          data: pts,
          borderColor: s.color,
          backgroundColor: `${s.color}22`,
          borderWidth: 2.2,
          pointRadius: pts.length > 80 ? 0 : 2.5,
          tension: 0.28,
          fill: false,
          yAxisID: "y",
          order: 1
        };
      });
    } else {
      activeWeightRows = state?.analysis?.hasData ? filterWeightRows(state.analysis.enrichedRows) : [];
      const isWeight = this.chartMode === "weight";
      const pts = activeWeightRows.map((r) => {
        const ms = r.ts.getTime();
        allX.push(ms);
        return { x: ms, y: isWeight ? r.weightKg : r.moisturePct };
      });

      const grad = ctx.createLinearGradient(0, 0, 0, 300);
      grad.addColorStop(0, "rgba(20, 184, 166, 0.32)");
      grad.addColorStop(1, "rgba(20, 184, 166, 0.0)");

      datasets.push({
        label: isWeight ? `${st.shortName} Weight (kg)` : `${st.shortName} Moisture (%)`,
        data: pts,
        borderColor: st.color || "#14b8a6",
        backgroundColor: grad,
        borderWidth: 2.4,
        pointRadius: pts.length > 90 ? 0 : 2.5,
        pointHoverRadius: 5,
        tension: 0.25,
        fill: true,
        yAxisID: "y",
        order: 1
      });

      const refM = MoistureEngine.computeReadingMetrics(cal.fieldCapacityKg, cal);
      if (isWeight) {
        refLines = [
          { y: refM.fieldCapacityRawKg, label: `100% FC (${refM.fieldCapacityRawKg.toFixed(2)} kg)`, color: "#38bdf8" },
          { y: refM.triggerRawKg, label: `Trigger (${refM.triggerRawKg.toFixed(2)} kg)`, color: "#f59e0b" },
          { y: refM.criticalRawKg, label: `Critical (${refM.criticalRawKg.toFixed(2)} kg)`, color: "#ef4444" }
        ];
      } else {
        refLines = [
          { y: 100, label: "100% Field Capacity", color: "#38bdf8" },
          { y: Number(cal.irrigateTriggerPct) || 70, label: `Trigger (${cal.irrigateTriggerPct}%)`, color: "#f59e0b" },
          { y: Number(cal.criticalFloorPct) || 50, label: `Critical (${cal.criticalFloorPct}%)`, color: "#ef4444" }
        ];
      }
    }

    // Stack RainPoint Temperature (°C) overlay
    let hasTempDataset = false;
    if (this.showTempOverlay && rpFiltered.length > 0) {
      const tempPts = rpFiltered
        .filter((p) => p.temp !== null)
        .map((p) => {
          allX.push(p.ms);
          return { x: p.ms, y: p.temp };
        });

      if (tempPts.length > 0) {
        hasTempDataset = true;
        datasets.push({
          label: `RainPoint Temp (${rp.live?.probeLabel || "Probe"})`,
          data: tempPts,
          borderColor: "#fb923c",
          backgroundColor: "rgba(251, 146, 60, 0.12)",
          borderDash: [4, 3],
          borderWidth: 1.8,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: false,
          yAxisID: "yTemp",
          order: 2
        });
      }
    }

    // Stack RainPoint Lighting (Lux) solar envelope overlay
    let peakLux = 0;
    if (this.showLuxOverlay && rpFiltered.length > 0) {
      const luxPts = rpFiltered
        .filter((p) => p.lux !== null)
        .map((p) => {
          allX.push(p.ms);
          if (p.lux > peakLux) peakLux = p.lux;
          return { x: p.ms, y: p.lux };
        });

      if (luxPts.length > 0) {
        datasets.push({
          label: `RainPoint Light (${rp.live?.probeLabel || "Probe"})`,
          data: luxPts,
          borderColor: "rgba(250, 204, 21, 0.85)",
          backgroundColor: "rgba(250, 204, 21, 0.12)",
          borderWidth: 1.4,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: true,
          yAxisID: "yLux",
          order: 3
        });
      }
    }

    const minX = allX.length > 0 ? Math.min(...allX) : 0;
    const maxX = allX.length > 0 ? Math.max(...allX) : 0;
    const spanHours = (maxX - minX) / 3600000;

    const formatTickMs = (ms) => {
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) return "";
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      if (spanHours > 30 || this.chartHours > 36 || this.chartHours === 0) {
        return `${d.getDate()}/${d.getMonth() + 1} ${hh}:${mm}`;
      }
      return `${hh}:${mm}`;
    };

    const thresholdPlugin = {
      id: "thresholdLines",
      afterDraw(chart) {
        if (!refLines.length) return;
        const { ctx: c, chartArea, scales } = chart;
        if (!chartArea || !scales.y) return;

        c.save();
        refLines.forEach((line) => {
          const yPix = scales.y.getPixelForValue(line.y);
          if (yPix < chartArea.top || yPix > chartArea.bottom) return;

          c.beginPath();
          c.setLineDash([5, 5]);
          c.strokeStyle = line.color;
          c.lineWidth = 1.2;
          c.moveTo(chartArea.left, yPix);
          c.lineTo(chartArea.right, yPix);
          c.stroke();

          c.setLineDash([]);
          c.fillStyle = line.color;
          c.font = "600 10px 'JetBrains Mono', monospace";
          c.fillText(line.label, chartArea.left + 6, yPix - 5);
        });
        c.restore();
      }
    };

    const isWeightMode = this.chartMode === "weight";

    this.chartInstance = new Chart(ctx, {
      type: "line",
      data: { datasets },
      plugins: [thresholdPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: {
          legend: {
            display: this.chartMode === "compare",
            labels: { color: "#cbd5e1", font: { family: "'Plus Jakarta Sans'" } }
          },
          tooltip: {
            backgroundColor: "rgba(9, 15, 22, 0.95)",
            borderColor: "rgba(148, 163, 184, 0.25)",
            borderWidth: 1,
            titleColor: "#f8fafc",
            bodyColor: "#cbd5e1",
            footerColor: "#94a3b8",
            callbacks: {
              title(items) {
                if (!items.length) return "";
                const d = new Date(items[0].parsed.x);
                return d.toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit"
                });
              },
              label(item) {
                const axis = item.dataset.yAxisID;
                const val = item.parsed.y;
                if (axis === "yTemp") return ` 🌡 ${item.dataset.label}: ${val.toFixed(1)} °C`;
                if (axis === "yLux") return ` ☀ ${item.dataset.label}: ${Math.round(val).toLocaleString()} Lux`;
                if (isWeightMode) return ` ⚖ ${item.dataset.label}: ${val.toFixed(3)} kg`;
                return ` 💧 ${item.dataset.label}: ${val.toFixed(1)}%`;
              },
              afterBody: (items) => {
                if (!items.length) return [];
                const hoveredMs = items[0].parsed.x;
                const shownAxes = new Set(items.map((it) => it.dataset.yAxisID));
                const extra = [];
                const maxGapMs = 20 * 60 * 1000; // ±20 min cross-sensor correlation window

                // If hovering Weight/Moisture, attach nearest concurrent RainPoint reading
                if ((!shownAxes.has("yTemp") || !shownAxes.has("yLux")) && rpFiltered.length > 0) {
                  let bestRp = null;
                  let bestDiff = Infinity;
                  for (const p of rpFiltered) {
                    const diff = Math.abs(p.ms - hoveredMs);
                    if (diff < bestDiff) {
                      bestDiff = diff;
                      bestRp = p;
                    }
                  }
                  if (bestRp && bestDiff <= maxGapMs) {
                    if (!shownAxes.has("yTemp") && this.showTempOverlay && bestRp.temp !== null) {
                      extra.push(` 🌡 RainPoint Temp: ${bestRp.temp.toFixed(1)} °C`);
                    }
                    if (!shownAxes.has("yLux") && this.showLuxOverlay && bestRp.lux !== null) {
                      extra.push(` ☀ RainPoint Light: ${bestRp.lux.toLocaleString()} Lux`);
                    }
                  }
                }

                // If hovering RainPoint curve, attach nearest concurrent Scale reading
                if (!shownAxes.has("y") && activeWeightRows.length > 0) {
                  let bestW = null;
                  let bestDiff = Infinity;
                  for (const r of activeWeightRows) {
                    const diff = Math.abs(r.ts.getTime() - hoveredMs);
                    if (diff < bestDiff) {
                      bestDiff = diff;
                      bestW = r;
                    }
                  }
                  if (bestW && bestDiff <= maxGapMs) {
                    extra.push(` ⚖ Scale: ${bestW.weightKg.toFixed(3)} kg (${bestW.moisturePct.toFixed(1)}%)`);
                  }
                }

                return extra;
              }
            }
          }
        },
        scales: {
          x: {
            type: "linear",
            bounds: "data",
            ticks: {
              color: "#64748b",
              maxTicksLimit: 9,
              font: { family: "'JetBrains Mono'", size: 10 },
              callback: (val) => formatTickMs(val)
            },
            grid: { color: "rgba(148, 163, 184, 0.06)" }
          },
          y: {
            position: "left",
            ...(isWeightMode && this.chartYMode === "fixed"
              ? { min: this.chartYMinKg, max: this.chartYMaxKg }
              : (!isWeightMode ? { min: 0, max: 110 } : {})),
            ticks: {
              color: "#5eead4",
              font: { family: "'JetBrains Mono'", size: 11 },
              callback: (v) => (isWeightMode ? `${Number(v).toFixed(2)} kg` : `${Number(v).toFixed(0)}%`)
            },
            grid: { color: "rgba(148, 163, 184, 0.09)" }
          },
          yTemp: {
            position: "right",
            display: hasTempDataset,
            suggestedMin: 20,
            suggestedMax: 40,
            ticks: {
              color: "#fb923c",
              font: { family: "'JetBrains Mono'", size: 10 },
              callback: (v) => `${Number(v).toFixed(0)}°C`
            },
            grid: { drawOnChartArea: false }
          },
          yLux: {
            position: "right",
            display: false,
            min: 0,
            suggestedMax: Math.max(3000, peakLux * 1.25)
          }
        }
      }
    });
  }

  syncChartToolbarUI() {
    const luxBtn = document.getElementById("btn-overlay-lux");
    if (luxBtn) luxBtn.classList.toggle("active", this.showLuxOverlay);

    const tempBtn = document.getElementById("btn-overlay-temp");
    if (tempBtn) tempBtn.classList.toggle("active", this.showTempOverlay);

    document.querySelectorAll("#chart-mode-group .pill-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === this.chartMode);
    });

    document.querySelectorAll("#chart-range-group .pill-btn").forEach((b) => {
      b.classList.toggle("active", !this.chartSelectedDay && Number(b.dataset.hours) === Number(this.chartHours));
    });

    const dayLabelEl = document.getElementById("btn-chart-day-label");
    const dayNextEl = document.getElementById("btn-chart-day-next");
    if (dayLabelEl) {
      if (this.chartSelectedDay) {
        const now = new Date();
        const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const selMs = this.chartSelectedDay.getTime();
        const diffDays = Math.round((todayMs - selMs) / (24 * 3600 * 1000));
        const label = diffDays === 0
          ? "Today"
          : this.chartSelectedDay.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        dayLabelEl.textContent = label;
        dayLabelEl.classList.add("active");
        if (dayNextEl) dayNextEl.classList.remove("disabled");
      } else {
        dayLabelEl.textContent = "Live";
        dayLabelEl.classList.remove("active");
        if (dayNextEl) dayNextEl.classList.add("disabled");
      }
    }
  }

  syncChartScalePanelUI() {
    const labelEl = document.getElementById("btn-chart-scale-label");
    if (labelEl) {
      labelEl.textContent = this.chartYMode === "fixed"
        ? `⚙ Range: ${this.chartYMinKg.toFixed(1)}–${this.chartYMaxKg.toFixed(1)} kg`
        : "⚙ Range: Adaptive";
    }
    const yModeGroup = document.getElementById("chart-y-mode-group");
    if (yModeGroup) {
      yModeGroup.querySelectorAll(".pill-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.ymode === this.chartYMode);
      });
    }
    const minIn = document.getElementById("chart-y-min-input");
    const maxIn = document.getElementById("chart-y-max-input");
    if (minIn && document.activeElement !== minIn) {
      minIn.value = this.chartYMinKg.toFixed(1);
    }
    if (maxIn && document.activeElement !== maxIn) {
      maxIn.value = this.chartYMaxKg.toFixed(1);
    }
    const fixedControls = document.getElementById("chart-y-fixed-controls");
    if (fixedControls) {
      fixedControls.style.opacity = this.chartYMode === "fixed" ? "1" : "0.78";
    }
  }

  saveChartYScaleSettings() {
    this.config.chartYScale = {
      mode: this.chartYMode,
      minKg: this.chartYMinKg,
      maxKg: this.chartYMaxKg
    };
    this.config.chartPrefs = {
      showLux: this.showLuxOverlay,
      showTemp: this.showTempOverlay,
      mode: this.chartMode,
      hours: this.chartHours
    };
    const st = this.getSelectedStation();
    if (st) {
      st.calibration = {
        ...st.calibration,
        chartYMode: this.chartYMode,
        chartYMinKg: this.chartYMinKg,
        chartYMaxKg: this.chartYMaxKg,
        chartShowLux: this.showLuxOverlay,
        chartShowTemp: this.showTempOverlay,
        chartMode: this.chartMode,
        chartHours: this.chartHours
      };
      const plotKey = st.deviceControl?.plotKey || st.sheetSource?.tabName || "Plot1";
      const scriptUrl = st.deviceControl?.scriptUrl || this.config.defaultScriptUrl;

      // 1. Sync directly to Google Sheet 'BagCalibration' tab
      SheetsService.pushSheetBagCalibration(scriptUrl, plotKey, st.calibration);

      // 2. Mirror to Firebase Realtime DB for instant cross-platform sync (<80ms)
      fetch(`${DeviceService.FIREBASE_BASE_URL}/${encodeURIComponent(plotKey)}.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cloudCalibration: st.calibration })
      }).catch(() => {});
    }
    ConfigStore.save(this.config);
  }

  renderDetails() {
    const st = this.getSelectedStation();
    const state = this.stationData[st.id];
    const analysis = state?.analysis;

    const eventsContainer = document.getElementById("irrigation-events-list");
    const badgeEl = document.getElementById("events-count-badge");
    const tbody = document.getElementById("log-table-body");

    if (!analysis || !analysis.hasData) {
      badgeEl.textContent = "0 events";
      eventsContainer.innerHTML = `<div class="empty-state">No irrigation pulses detected yet.</div>`;
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No telemetry rows loaded yet.</td></tr>`;
      return;
    }

    const evs = analysis.irrigationEvents;
    badgeEl.textContent = `${evs.length} shot${evs.length === 1 ? "" : "s"}`;

    if (evs.length === 0) {
      eventsContainer.innerHTML = `<div class="empty-state">No upward irrigation jumps (≥${st.calibration.irrigationJumpKg} kg) in current dataset.</div>`;
    } else {
      eventsContainer.innerHTML = evs.slice(0, 25).map((ev) => {
        const dtStr = ev.peakTs.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        });
        return `
          <div class="event-item">
            <div>
              <div style="font-weight:700;">${dtStr}</div>
              <div class="mono" style="font-size:0.73rem; color:var(--text-secondary);">
                ${ev.preWeightKg.toFixed(2)} kg &rarr; ${ev.peakWeightKg.toFixed(2)} kg
              </div>
            </div>
            <div class="event-gain mono">+${ev.gainMl.toLocaleString()} mL</div>
          </div>
        `;
      }).join("");
    }

    // Telemetry table (latest 80 rows newest first)
    const rows = analysis.enrichedRows;
    const recentRows = rows.slice(-80).reverse();
    tbody.innerHTML = recentRows.map((r, idx) => {
      const origIdx = rows.length - 1 - idx;
      const prev = origIdx > 0 ? rows[origIdx - 1] : null;
      const deltaMl = prev ? Math.round((r.weightKg - prev.weightKg) * 1000) : 0;
      const deltaColor = deltaMl > 50 ? "#38bdf8" : (deltaMl < -20 ? "#f59e0b" : "var(--text-secondary)");
      const deltaStr = prev ? `${deltaMl > 0 ? "+" : ""}${deltaMl}` : "—";

      return `
        <tr>
          <td class="mono">${r.dateStr}</td>
          <td class="mono">${r.timeStr}</td>
          <td class="mono" style="font-weight:700;">${r.weightKg.toFixed(3)}</td>
          <td class="mono">${r.moisturePct.toFixed(1)}%</td>
          <td class="mono" style="color:${deltaColor};">${deltaStr}</td>
        </tr>
      `;
    }).join("");
  }

  setCurrentAsFieldCapacity() {
    const st = this.getSelectedStation();
    const analysis = this.stationData[st.id]?.analysis;
    if (!analysis || !analysis.hasData) {
      this.showToast("Need a weight reading first before locking 100% Field Capacity.");
      return;
    }
    const rawKg = analysis.latest.weightKg;
    const biomass = Number(st.calibration.plantBiomassKg) || 0;
    const newFc = Math.round(Math.max(st.calibration.dryWeightKg + 0.5, rawKg - biomass) * 100) / 100;

    st.calibration.fieldCapacityKg = newFc;
    ConfigStore.save(this.config);

    const plotKey = st.deviceControl?.plotKey || st.sheetSource?.tabName || "Plot1";
    const scriptUrl = st.deviceControl?.scriptUrl || this.config.defaultScriptUrl;

    // 1. Sync calibration directly into Google Sheet 'BagCalibration' tab
    SheetsService.pushSheetBagCalibration(scriptUrl, plotKey, st.calibration);

    // 2. Also mirror to Firebase Realtime DB for instant cross-device broadcast
    fetch(`${DeviceService.FIREBASE_BASE_URL}/${encodeURIComponent(plotKey)}.json`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cloudCalibration: st.calibration })
    }).catch(() => {});

    this.recomputeAllStations();
    this.renderAll();
    this.showToast(`Locked ${rawKg.toFixed(2)} kg as 100% Field Capacity for ${st.shortName}!`);
  }

  openCalibrateModal() {
    const st = this.getSelectedStation();
    const cal = st.calibration;
    document.getElementById("cal-modal-title").textContent = `Calibrate ${st.name}`;
    document.getElementById("cal-fc-kg").value = cal.fieldCapacityKg;
    document.getElementById("cal-dry-kg").value = cal.dryWeightKg;
    document.getElementById("cal-biomass-kg").value = cal.plantBiomassKg || 0;
    document.getElementById("cal-runoff-pct").value = cal.targetRunoffPct || 15;
    document.getElementById("cal-trig-pct").value = cal.irrigateTriggerPct;
    document.getElementById("cal-crit-pct").value = cal.criticalFloorPct;
    document.getElementById("cal-jump-kg").value = cal.irrigationJumpKg || 0.15;

    // Load-cell hardware calibration controls
    const readingInput = document.getElementById("cal-scale-reading-input");
    const multInput = document.getElementById("cal-scale-multiplier");
    const offsetInput = document.getElementById("cal-scale-offset");
    const knownInput = document.getElementById("cal-known-weight-input");
    const resBanner = document.getElementById("cal-hw-result-banner");

    if (multInput) multInput.value = (cal.scaleMultiplier !== undefined ? cal.scaleMultiplier : 1.0).toFixed(4);
    if (offsetInput) offsetInput.value = (cal.scaleOffset !== undefined ? cal.scaleOffset : 0.0).toFixed(3);
    if (knownInput) knownInput.value = "";
    if (resBanner) {
      resBanner.style.display = "none";
      resBanner.textContent = "";
    }

    // Determine current live reading (uncalibrated raw scale weight)
    const plotKey = st.deviceControl?.plotKey || st.sheetSource?.tabName || "Plot1";
    const cloud = this.deviceCloudMap[plotKey] || st.deviceCloud;
    let currentRawKg = 0;
    if (cloud?.lastWeightKg !== undefined && !isNaN(cloud.lastWeightKg) && cloud.lastWeightKg > 0) {
      currentRawKg = cloud.lastWeightKg;
    } else if (st.analysis?.latest?.uncalibratedWeightKg !== undefined && !isNaN(st.analysis.latest.uncalibratedWeightKg) && st.analysis.latest.uncalibratedWeightKg > 0) {
      currentRawKg = st.analysis.latest.uncalibratedWeightKg;
    } else if (st.analysis?.latest?.weightKg !== undefined && !isNaN(st.analysis.latest.weightKg) && st.analysis.latest.weightKg > 0) {
      const m = cal.scaleMultiplier || 1.0;
      const o = cal.scaleOffset || 0.0;
      currentRawKg = (st.analysis.latest.weightKg - o) / (m || 1.0);
    } else if (st.analysis?.metrics?.rawWeightKg !== undefined && st.analysis.metrics.rawWeightKg > 0) {
      currentRawKg = st.analysis.metrics.rawWeightKg;
    }

    if (readingInput) {
      readingInput.value = (currentRawKg > 0) ? currentRawKg.toFixed(3) : "";
    }

    // Asynchronously fetch the freshest live weight from ESP32 / Firebase
    this.fetchLiveWeightForCalibration(true);

    this.updateCalibrationModalHints();
    this.openModal("modal-calibrate");
    if (window.lucide) window.lucide.createIcons();
  }

  async fetchLiveWeightForCalibration(silent = false) {
    const st = this.getSelectedStation();
    const plotKey = st.deviceControl?.plotKey || st.sheetSource?.tabName || "Plot1";
    const readingInput = document.getElementById("cal-scale-reading-input");
    const btn = document.getElementById("btn-fetch-live-scale");
    if (btn && !silent) btn.style.opacity = "0.5";

    try {
      let liveKg = null;

      // 1. Query Firebase RTDB Fast Node (~80ms)
      const node = await DeviceService.fetchSinglePlotFast(plotKey);
      if (node && node.lastWeightKg !== null && !isNaN(node.lastWeightKg) && node.lastWeightKg > 0) {
        liveKg = node.lastWeightKg;
        this.deviceCloudMap[plotKey] = { ...this.deviceCloudMap[plotKey], ...node };
        st.deviceCloud = { ...st.deviceCloud, ...node };
      }

      // 2. Direct LAN HTTP query if on same Wi-Fi
      const cloud = this.deviceCloudMap[plotKey] || st.deviceCloud;
      if ((liveKg === null || liveKg <= 0.02) && cloud?.localIp && window.location.protocol !== "https:") {
        try {
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 950);
          const r = await fetch(`http://${cloud.localIp}/cmd`, { signal: ctrl.signal });
          clearTimeout(tid);
          if (r.ok) {
            const data = await r.json();
            if (data && data.weightKg !== undefined && Number(data.weightKg) > 0) {
              liveKg = Number(data.weightKg);
            }
          }
        } catch (_) {}
      }

      // 3. Fallback to latest sheet reading
      if ((liveKg === null || liveKg <= 0.02) && st.analysis?.latest) {
        const sheetW = st.analysis.latest.uncalibratedWeightKg ?? st.analysis.latest.weightKg;
        if (sheetW > 0) liveKg = sheetW;
      }

      if (liveKg !== null && readingInput && liveKg > 0) {
        readingInput.value = liveKg.toFixed(3);
        if (!silent) this.showToast(`Fetched live scale reading: ${liveKg.toFixed(2)} kg`);
      }
    } catch (_) {
    } finally {
      if (btn && !silent) btn.style.opacity = "1";
    }
  }

  async applyKnownWeightCalibration() {
    const st = this.getSelectedStation();
    const plotKey = st.deviceControl?.plotKey || st.sheetSource?.tabName || "Plot1";
    const cloud = this.deviceCloudMap[plotKey] || st.deviceCloud;
    const readingInput = document.getElementById("cal-scale-reading-input");
    const knownInput = document.getElementById("cal-known-weight-input");
    const multInput = document.getElementById("cal-scale-multiplier");
    const offsetInput = document.getElementById("cal-scale-offset");
    const resBanner = document.getElementById("cal-hw-result-banner");

    const knownWeight = parseFloat(knownInput?.value);
    if (isNaN(knownWeight) || knownWeight <= 0.05) {
      this.showToast("Please enter your actual known test weight (e.g. 5.0 kg or 10.0 kg).");
      if (knownInput) knownInput.focus();
      return;
    }

    let currentRaw = parseFloat(readingInput?.value);

    // If empty or <= 0.02, attempt one fast live pull
    if (isNaN(currentRaw) || currentRaw <= 0.02) {
      await this.fetchLiveWeightForCalibration(true);
      currentRaw = parseFloat(readingInput?.value);
    }

    if (isNaN(currentRaw) || currentRaw <= 0.02) {
      this.showToast("Please enter the weight reading currently shown on your scale / 16x2 LCD.");
      if (readingInput) readingInput.focus();
      return;
    }

    // Mathematical calibration:
    // New multiplier = Known actual weight / Raw scale reading
    const newMultiplier = Number((knownWeight / currentRaw).toFixed(4));
    const newOffset = 0.0;

    // Hardware ESP32 calibration factor:
    // Scale Weight = Counts / Factor -> New Factor = Base Factor * (currentRaw / knownWeight)
    const hasHwCalSupport = (cloud?.fw && parseFloat(cloud.fw) >= 2.7);
    const baseHwFactor = (hasHwCalSupport && cloud?.calFactor && cloud.calFactor > 10) ? cloud.calFactor : 99833.0;
    const newHwCalFactor = Math.max(10, Math.round(baseHwFactor * (currentRaw / knownWeight)));

    // If ESP32 is on FW >= 2.7, hardware itself scales the reading so software multiplier stays 1.0;
    // if ESP32 is on FW <= 2.6, software multiplier scales the web dashboard reading immediately.
    const effectiveMultiplier = hasHwCalSupport ? 1.0 : newMultiplier;

    // Update inputs and station config
    if (multInput) multInput.value = effectiveMultiplier.toFixed(4);
    if (offsetInput) offsetInput.value = "0.000";

    st.calibration.scaleMultiplier = effectiveMultiplier;
    st.calibration.scaleOffset = newOffset;
    ConfigStore.save(this.config);

    const scriptUrl = st.deviceControl?.scriptUrl || this.config.defaultScriptUrl;
    SheetsService.pushSheetBagCalibration(scriptUrl, plotKey, st.calibration);

    // Provide immediate UI visual feedback
    if (resBanner) {
      resBanner.style.display = "block";
      resBanner.style.padding = "0.45rem 0.65rem";
      resBanner.style.borderRadius = "6px";
      resBanner.style.background = "rgba(52, 211, 153, 0.12)";
      resBanner.style.border = "1px solid rgba(52, 211, 153, 0.35)";
      resBanner.style.color = "#34d399";
      resBanner.innerHTML = `✓ <strong>Calibrated Successfully!</strong> Scale reading <code>${currentRaw.toFixed(2)} kg</code> corrected to <code>${knownWeight.toFixed(2)} kg</code>.<br><span style="font-size:0.68rem; color:#94a3b8;">New ESP32 Hardware Factor: <strong>${newHwCalFactor}</strong> · App Multiplier: <strong>${effectiveMultiplier.toFixed(4)}</strong></span>`;
    }

    this.showToast(`Calibrated ${st.shortName} with ${knownWeight.toFixed(2)} kg test weight!`);

    // Sync calibration factor to ESP32 Flash Preferences via Firebase RTDB & Direct LAN
    try {
      const pushRes = await DeviceService.pushConfig(scriptUrl, {
        plotKey,
        intervalMin: cloud?.intervalMin || st.deviceControl?.intervalMin || 1,
        powerMode: cloud?.powerMode || st.deviceControl?.powerMode || "always_on",
        lcdMode: cloud?.lcdMode || st.deviceControl?.lcdMode || "on",
        calFactor: newHwCalFactor,
        localIp: cloud?.localIp || ""
      });
      if (pushRes?.ok) {
        this.scheduleFastDeviceAckPoll(plotKey);
        if (resBanner) {
          resBanner.innerHTML += `<br><span style="font-size:0.68rem; color:#38bdf8;">✓ Synced factor <strong>${newHwCalFactor}</strong> to Firebase/ESP32 (Requires FW v2.7 on ESP32 to update physical LCD).</span>`;
        }
      }
    } catch (_) {}

    this.recomputeAllStations();
    this.renderAll();
  }

  applyCalibrationPreset(preset) {
    const presets = {
      bench: { fc: 0.65, dry: 0.00, bio: 0.00, runoff: 10, trig: 65, crit: 40, jump: 0.05 },
      nursery: { fc: 4.50, dry: 1.00, bio: 0.00, runoff: 15, trig: 70, crit: 50, jump: 0.10 },
      polybag: { fc: 13.50, dry: 3.50, bio: 0.00, runoff: 15, trig: 70, crit: 50, jump: 0.15 }
    };
    const p = presets[preset];
    if (!p) return;
    document.getElementById("cal-fc-kg").value = p.fc;
    document.getElementById("cal-dry-kg").value = p.dry;
    document.getElementById("cal-biomass-kg").value = p.bio;
    document.getElementById("cal-runoff-pct").value = p.runoff;
    document.getElementById("cal-trig-pct").value = p.trig;
    document.getElementById("cal-crit-pct").value = p.crit;
    document.getElementById("cal-jump-kg").value = p.jump;
    this.updateCalibrationModalHints();
    this.showToast("Preset loaded — click Save Calibration to apply.");
  }

  updateCalibrationModalHints() {
    const fc = parseFloat(document.getElementById("cal-fc-kg").value) || 0.65;
    const dry = parseFloat(document.getElementById("cal-dry-kg").value) || 0;
    const bio = parseFloat(document.getElementById("cal-biomass-kg").value) || 0;
    const trigPct = parseFloat(document.getElementById("cal-trig-pct").value) || 70;
    const critPct = parseFloat(document.getElementById("cal-crit-pct").value) || 50;

    const cap = Math.max(0.05, fc - dry);
    const trigKg = dry + cap * (trigPct / 100) + bio;
    const critKg = dry + cap * (critPct / 100) + bio;

    document.getElementById("cal-trig-hint").textContent =
      `Triggers irrigation at ${trigKg.toFixed(2)} kg scale weight (${(100 - trigPct).toFixed(0)}% dry-back).`;
    document.getElementById("cal-crit-hint").textContent =
      `Critical warning below ${critKg.toFixed(2)} kg scale weight.`;
  }

  async saveCalibrationForm() {
    const st = this.getSelectedStation();
    const fc = parseFloat(document.getElementById("cal-fc-kg").value);
    const dry = parseFloat(document.getElementById("cal-dry-kg").value);
    if (fc <= dry + 0.05) {
      this.showToast("Field Capacity weight must be at least 0.05 kg heavier than Dry Tare weight.");
      return;
    }

    // If user entered a Known Test Weight in the hardware box and clicked Save Calibration directly, apply it automatically
    const knownVal = parseFloat(document.getElementById("cal-known-weight-input")?.value);
    const readingVal = parseFloat(document.getElementById("cal-scale-reading-input")?.value);
    if (!isNaN(knownVal) && knownVal > 0.05 && !isNaN(readingVal) && readingVal > 0.01) {
      await this.applyKnownWeightCalibration();
    }

    const mult = parseFloat(document.getElementById("cal-scale-multiplier")?.value);
    const offset = parseFloat(document.getElementById("cal-scale-offset")?.value);

    st.calibration = {
      ...st.calibration,
      fieldCapacityKg: fc,
      dryWeightKg: dry,
      plantBiomassKg: parseFloat(document.getElementById("cal-biomass-kg").value) || 0,
      targetRunoffPct: parseFloat(document.getElementById("cal-runoff-pct").value) || 15,
      irrigateTriggerPct: parseFloat(document.getElementById("cal-trig-pct").value) || 70,
      criticalFloorPct: parseFloat(document.getElementById("cal-crit-pct").value) || 50,
      irrigationJumpKg: parseFloat(document.getElementById("cal-jump-kg").value) || 0.15,
      scaleMultiplier: (!isNaN(mult) && mult > 0) ? Number(mult.toFixed(4)) : 1.0,
      scaleOffset: !isNaN(offset) ? Number(offset.toFixed(3)) : 0.0
    };

    ConfigStore.save(this.config);

    const plotKey = st.deviceControl?.plotKey || st.sheetSource?.tabName || "Plot1";
    const scriptUrl = st.deviceControl?.scriptUrl || this.config.defaultScriptUrl;

    // 1. Sync calibration directly into Google Sheet 'BagCalibration' tab
    SheetsService.pushSheetBagCalibration(scriptUrl, plotKey, st.calibration);

    // 2. Also mirror to Firebase Realtime DB for instant cross-device broadcast
    fetch(`${DeviceService.FIREBASE_BASE_URL}/${encodeURIComponent(plotKey)}.json`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cloudCalibration: st.calibration })
    }).catch(() => {});

    this.closeModal("modal-calibrate");
    this.recomputeAllStations();
    this.renderAll();
    this.showToast(`Saved calibration for ${st.shortName}!`);
  }

  openStationsModal() {
    this.draftStations = structuredClone(this.config.stations);
    document.getElementById("poll-interval-select").value = String(this.config.pollIntervalSec ?? 60);
    document.getElementById("rainpoint-endpoint-input").value =
      this.config.rainpointEndpointUrl || DEFAULT_CONFIG.rainpointEndpointUrl;
    this.renderStationsEditor();
    this.openModal("modal-stations");
  }

  renderStationsEditor() {
    const container = document.getElementById("stations-editor-container");
    container.innerHTML = this.draftStations.map((st, idx) => {
      const curProbe = st.rainpointProbe || "p1_s1";
      const probeOpts = RainpointService.PROBE_OPTIONS.map(
        (opt) => `<option value="${opt.id}" ${opt.id === curProbe ? "selected" : ""}>${this.escapeHtml(opt.label)}</option>`
      ).join("");

      return `
      <div class="station-editor-row" data-idx="${idx}">
        <div class="station-editor-head">
          <label style="display:flex; align-items:center; gap:0.5rem; font-weight:700; cursor:pointer;">
            <input type="checkbox" class="st-enabled" ${st.enabled ? "checked" : ""}>
            <span style="color:${st.color};">●</span>
            <span>${this.escapeHtml(st.shortName)} — ${this.escapeHtml(st.name)}</span>
          </label>
          ${this.draftStations.length > 1 ? `<button type="button" class="btn btn-sm st-remove" style="color:#fca5a5;">Remove</button>` : ""}
        </div>

        <div class="form-grid">
          <div class="form-group">
            <label>Short Badge (e.g., PLOT 1)</label>
            <input type="text" class="st-short" value="${this.escapeAttr(st.shortName)}">
          </div>
          <div class="form-group">
            <label>Station Name</label>
            <input type="text" class="st-name" value="${this.escapeAttr(st.name)}">
          </div>
          <div class="form-group full">
            <label>Google Sheet URL, Published CSV URL, or Apps Script Web App URL</label>
            <input type="text" class="st-url" value="${this.escapeAttr(st.sheetSource?.url || "")}" placeholder="https://docs.google.com/spreadsheets/d/...">
          </div>
          <div class="form-group">
            <label>Sheet Tab GID (optional, e.g. 0)</label>
            <input type="text" class="st-gid" value="${this.escapeAttr(st.sheetSource?.gid ?? "")}" placeholder="Leave blank to use Tab Name">
          </div>
          <div class="form-group">
            <label>Tab Name (for Plot 2 / Plot 3)</label>
            <input type="text" class="st-tab" value="${this.escapeAttr(st.sheetSource?.tabName || "")}" placeholder="e.g. Plot1, Plot2, Plot3">
          </div>
          <div class="form-group full">
            <label>Linked RainPoint Probe (Solar Lighting Lux &amp; Temperature °C)</label>
            <select class="st-rp-probe">${probeOpts}</select>
          </div>
        </div>
      </div>
    `;
    }).join("");

    container.querySelectorAll(".st-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        this.syncDraftInputsFromDom();
        const idx = Number(e.target.closest(".station-editor-row").dataset.idx);
        this.draftStations.splice(idx, 1);
        this.renderStationsEditor();
      });
    });
  }

  syncDraftInputsFromDom() {
    const rows = document.querySelectorAll("#stations-editor-container .station-editor-row");
    rows.forEach((row) => {
      const idx = Number(row.dataset.idx);
      const st = this.draftStations[idx];
      if (!st) return;
      st.enabled = row.querySelector(".st-enabled").checked;
      st.shortName = row.querySelector(".st-short").value.trim() || `PLOT ${idx + 1}`;
      st.name = row.querySelector(".st-name").value.trim() || st.shortName;
      st.sheetSource.url = row.querySelector(".st-url").value.trim();
      st.sheetSource.gid = row.querySelector(".st-gid").value.trim();
      st.sheetSource.tabName = row.querySelector(".st-tab").value.trim();
      st.rainpointProbe = row.querySelector(".st-rp-probe")?.value || "none";
    });
  }

  addDraftStation() {
    this.syncDraftInputsFromDom();
    const num = this.draftStations.length + 1;
    const color = STATION_PALETTE[(num - 1) % STATION_PALETTE.length];
    this.draftStations.push({
      id: `scale-plot-${Date.now()}`,
      name: `Plot ${num} — Scale Station ${num}`,
      shortName: `PLOT ${num}`,
      crop: "Chili (Polybag Cocopeat)",
      enabled: true,
      color,
      rainpointProbe: "avg",
      deviceControl: {
        plotKey: `Plot${num}`,
        scriptUrl: this.config.defaultScriptUrl || DEFAULT_CONFIG.defaultScriptUrl,
        intervalMin: 15,
        powerMode: "deep_sleep",
        lcdMode: "off",
        batteryMah: 3000
      },
      sheetSource: {
        mode: "sheet_url",
        url: this.config.defaultSheetUrl,
        spreadsheetId: this.config.defaultSpreadsheetId,
        gid: "",
        tabName: `Plot${num}`
      },
      calibration: {
        fieldCapacityKg: 13.50,
        dryWeightKg: 3.50,
        plantBiomassKg: 0.00,
        irrigateTriggerPct: 70,
        criticalFloorPct: 50,
        targetRunoffPct: 15,
        irrigationJumpKg: 0.15
      }
    });
    this.renderStationsEditor();
  }

  openBatteryModal() {
    this.openModal("modal-battery");
    const battRangeGroup = document.getElementById("batt-chart-range-group");
    if (battRangeGroup) {
      battRangeGroup.querySelectorAll(".pill-btn").forEach((b) => {
        b.classList.toggle("active", Number(b.dataset.hours) === this.batteryHours);
      });
    }
    this.renderBatteryModal();
    // Re-render once modal layout reflow is complete to ensure canvas width is measured directly
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (!document.getElementById("modal-battery").classList.contains("hidden")) {
          this.renderBatteryChart();
        }
      }, 40);
    });
  }

  renderBatteryModal() {
    const st = this.getSelectedStation();
    if (!st) return;

    const dc = st.deviceControl || {};
    const cloud = dc.plotKey ? this.deviceCloudMap[dc.plotKey] : null;
    const rawRows = this.getStationRows(st.id);
    const latestRow = rawRows.slice(-1)[0] || null;
    const mins = cloud?.intervalMin || dc.intervalMin || 1;

    const sourceEl = document.getElementById("batt-kpi-source");
    const sourceSub = document.getElementById("batt-kpi-source-sub");
    const onlineEl = document.getElementById("batt-kpi-online");
    const onlineSub = document.getElementById("batt-kpi-online-sub");
    const voltEl = document.getElementById("batt-kpi-volt");
    const pctEl = document.getElementById("batt-kpi-pct");
    const daysEl = document.getElementById("batt-kpi-days");
    const rateEl = document.getElementById("batt-kpi-rate");
    const statusSub = document.getElementById("batt-kpi-status-sub");
    const modeSub = document.getElementById("batt-kpi-mode-sub");
    const rateSub = document.getElementById("batt-kpi-rate-sub");

    // 1. Scale Connectivity Check
    const onStatus = DeviceService.checkDeviceOnlineStatus(cloud, latestRow, mins);
    if (onlineEl) {
      onlineEl.textContent = onStatus.badge;
      onlineEl.style.color = onStatus.color;
    }
    if (onlineSub) {
      onlineSub.textContent = onStatus.label;
    }

    // 2. Power Source & Charging Detection
    const pwr = DeviceService.describePowerAndBattery(cloud, rawRows, this.rainpointSync?.live?.lux ?? null);
    if (sourceEl) {
      sourceEl.textContent = pwr.sourceLabel;
      sourceEl.style.color = pwr.color;
    }
    if (sourceSub) {
      sourceSub.textContent = pwr.sourceSub;
    }

    // 3. Voltage & Level
    if (voltEl) {
      voltEl.textContent = pwr.hasData ? `${pwr.volt} V` : "-- V";
    }
    if (pctEl) {
      pctEl.textContent = pwr.hasData ? `${pwr.pct}%` : "-- %";
      pctEl.style.color = pwr.color;
    }
    if (statusSub) {
      statusSub.textContent = pwr.hasData ? pwr.desc : "Awaiting ESP32 GPIO 35 signal";
    }

    // 4. Power Mode & Runtime
    const pMode = cloud?.powerMode || dc.powerMode || "always_on";
    const lMode = cloud?.lcdMode || dc.lcdMode || "on";
    const pMeta = DeviceService.POWER_MODES.find((x) => x.id === pMode) || DeviceService.POWER_MODES[0];
    const batMah = Math.max(300, Number(cloud?.batteryMah || dc.batteryMah) || 3000);
    const est = DeviceService.estimateBatteryProfile({
      intervalMin: mins,
      powerMode: pMode,
      lcdMode: lMode,
      batteryMah: batMah
    });

    const curPctRatio = (pwr.hasData && pwr.pct !== null && pwr.pct > 0) ? (pwr.pct / 100) : 1.0;
    const hasMeasuredDischarge = (!pwr.isCharging && pwr.slopePerDay !== undefined && pwr.slopePerDay < -5.0);
    const fullDays = hasMeasuredDischarge
      ? (100 / Math.abs(pwr.slopePerDay))
      : est.days;
    const remDays = Math.max(0.05, fullDays * curPctRatio);
    const remRuntimeStr = remDays < 1.0
      ? `~${Math.max(1, Math.round(remDays * 24))} hrs`
      : `~${remDays.toFixed(1)} days`;
    const fullRuntimeStr = fullDays < 1.0
      ? `~${Math.max(1, Math.round(fullDays * 24))} hrs`
      : `~${fullDays.toFixed(1)} days`;

    if (modeSub) {
      const modeName = pMeta.label.split(" (")[0];
      modeSub.textContent = pwr.isCharging
        ? `Charging · Full: ${fullRuntimeStr} (${modeName})`
        : `Mode: ${modeName} (Full: ${fullRuntimeStr})`;
    }
    if (daysEl) {
      if (pwr.isUsbDirect) {
        daysEl.textContent = "Unlimited";
        daysEl.style.color = "#38bdf8";
      } else if (pwr.isSolar) {
        daysEl.textContent = `${remRuntimeStr}`;
        daysEl.style.color = "#facc15";
      } else if (pwr.isCharging) {
        daysEl.textContent = `${remRuntimeStr}`;
        daysEl.style.color = "#2dd4bf";
      } else {
        daysEl.textContent = remRuntimeStr;
        daysEl.style.color = "#fde047";
      }
    }

    // 5. Charge / Discharge Slope Rate
    if (rateEl && rateSub) {
      if (pwr.isUsbDirect) {
        rateEl.textContent = "0 %/day";
        rateEl.style.color = "#38bdf8";
        rateSub.textContent = "Direct USB power supply";
      } else if (pwr.slopePerDay !== undefined && Math.abs(pwr.slopePerDay) > 0.05) {
        const perHr = pwr.slopePerDay / 24;
        if (pwr.slopePerDay > 0) {
          rateEl.textContent = `+${pwr.slopePerDay.toFixed(1)} %/day`;
          rateEl.style.color = pwr.isSolar ? "#facc15" : "#34d399";
          rateSub.textContent = `${pwr.isSolar ? "Solar" : "USB"} charging (+${perHr.toFixed(1)} %/hr)`;
        } else {
          rateEl.textContent = `${pwr.slopePerDay.toFixed(1)} %/day`;
          rateEl.style.color = "#fdba74";
          rateSub.textContent = `Discharging (${perHr.toFixed(1)} %/hr from logs)`;
        }
      } else {
        const estRatePerDay = -(100 / Math.max(0.2, est.days));
        rateEl.textContent = `${estRatePerDay.toFixed(1)} %/day`;
        rateEl.style.color = "#38bdf8";
        rateSub.textContent = `Est. rate for ${pMeta.label.split(" (")[0]}`;
      }
    }

    this.renderBatteryChart();
  }

  renderBatteryChart() {
    const canvas = document.getElementById("battery-history-chart");
    const emptyNotice = document.getElementById("batt-chart-empty");
    if (!canvas) return;

    if (this.batteryChart) {
      this.batteryChart.destroy();
      this.batteryChart = null;
    }

    const st = this.getSelectedStation();
    if (!st) return;

    const rawRows = this.getStationRows(st.id);
    const dc = st.deviceControl || {};
    const cloud = dc.plotKey ? this.deviceCloudMap[dc.plotKey] : null;

    const latestRowMs = rawRows.length > 0 ? rawRows[rawRows.length - 1].ts.getTime() : 0;
    const liveCloudMs = cloud && cloud.lastSeenDate ? cloud.lastSeenDate.getTime() : 0;
    const anchorMs = Math.max(Date.now(), latestRowMs, liveCloudMs);
    const cutoffMs = this.batteryHours > 0 && anchorMs > 0 ? anchorMs - this.batteryHours * 3600000 : 0;

    const ptsMap = new Map();
    rawRows.forEach((r) => {
      if (r.battPct === null || r.battPct === undefined || Number.isNaN(r.battPct)) return;
      // Filter out floating pin spikes (<2.2V or >4.45V) when battery switch was turned off on USB
      if (r.battVolt !== null && r.battVolt !== undefined && (r.battVolt < 2.2 || r.battVolt > 4.45)) return;
      const ms = r.ts.getTime();
      if (ms >= cutoffMs) {
        ptsMap.set(ms, { x: ms, yPct: r.battPct, yVolt: r.battVolt || null });
      }
    });

    if (cloud && cloud.battPct !== null && cloud.lastSeenDate) {
      const vOk = cloud.battVolt === null || cloud.battVolt === undefined || (cloud.battVolt >= 2.2 && cloud.battVolt <= 4.45);
      const liveMs = cloud.lastSeenDate.getTime();
      if (vOk && liveMs >= cutoffMs) {
        ptsMap.set(liveMs, { x: liveMs, yPct: cloud.battPct, yVolt: cloud.battVolt || null });
      }
    }

    const pts = Array.from(ptsMap.values()).sort((a, b) => a.x - b.x);

    if (pts.length === 0) {
      if (emptyNotice) {
        emptyNotice.classList.remove("hidden");
        emptyNotice.style.display = "flex";
      }
      return;
    }
    if (emptyNotice) {
      emptyNotice.classList.add("hidden");
      emptyNotice.style.display = "none";
    }

    const pctData = pts.map((p) => ({ x: p.x, y: p.yPct, volt: p.yVolt }));
    const voltData = pts.filter((p) => p.yVolt !== null).map((p) => ({ x: p.x, y: p.yVolt }));

    const datasets = [
      {
        label: "Battery Level (%)",
        data: pctData,
        borderColor: "#34d399",
        backgroundColor: "rgba(52, 211, 153, 0.12)",
        borderWidth: 2.2,
        tension: 0.2,
        fill: true,
        pointRadius: pctData.length > 50 ? 0 : 2.5,
        pointHoverRadius: 5,
        yAxisID: "yPct"
      }
    ];

    if (voltData.length > 0) {
      datasets.push({
        label: "Voltage (V)",
        data: voltData,
        borderColor: "#38bdf8",
        borderDash: [3, 2],
        borderWidth: 1.8,
        tension: 0.2,
        fill: false,
        pointRadius: voltData.length > 50 ? 0 : 2,
        pointHoverRadius: 4,
        yAxisID: "yVolt"
      });
    }

    const minX = pts[0].x;
    const maxX = pts[pts.length - 1].x;
    const spanHours = (maxX - minX) / 3600000;

    const formatTickMs = (ms) => {
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) return "";
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      if (spanHours > 48) {
        return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
      }
      return `${hh}:${mm}`;
    };

    this.batteryChart = new Chart(canvas, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(15, 23, 42, 0.94)",
            borderColor: "rgba(148, 163, 184, 0.3)",
            borderWidth: 1,
            titleFont: { family: "'JetBrains Mono'", size: 11 },
            bodyFont: { family: "'JetBrains Mono'", size: 11 },
            callbacks: {
              title: (items) => {
                if (!items.length) return "";
                const d = new Date(items[0].parsed.x);
                return d.toLocaleString("en-MY", {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit"
                });
              },
              label: (item) => {
                const axis = item.dataset.yAxisID;
                const val = item.parsed.y;
                if (axis === "yVolt") return ` ⚡ Voltage: ${val.toFixed(2)} V`;
                const rawVolt = item.raw?.volt;
                const vStr = rawVolt ? ` (${rawVolt.toFixed(2)}V)` : "";
                return ` 🔋 Battery: ${Math.round(val)}%${vStr}`;
              }
            }
          }
        },
        scales: {
          x: {
            type: "linear",
            bounds: "data",
            ticks: {
              color: "#64748b",
              maxTicksLimit: 7,
              font: { family: "'JetBrains Mono'", size: 10 },
              callback: (val) => formatTickMs(val)
            },
            grid: { color: "rgba(148, 163, 184, 0.06)" }
          },
          yPct: {
            position: "left",
            min: 0,
            max: 100,
            ticks: {
              color: "#34d399",
              font: { family: "'JetBrains Mono'", size: 10 },
              callback: (v) => `${Number(v).toFixed(0)}%`
            },
            grid: { color: "rgba(148, 163, 184, 0.08)" }
          },
          yVolt: {
            position: "right",
            suggestedMin: 3.2,
            suggestedMax: 4.3,
            display: voltData.length > 0,
            ticks: {
              color: "#38bdf8",
              font: { family: "'JetBrains Mono'", size: 10 },
              callback: (v) => `${Number(v).toFixed(2)}V`
            },
            grid: { drawOnChartArea: false }
          }
        }
      }
    });
  }

  openHardwareModal() {
    const st = this.getSelectedStation();
    const dc = st.deviceControl || {};
    const cloud = dc.plotKey ? this.deviceCloudMap[dc.plotKey] : null;

    this.hwDraft = {
      intervalMin: cloud?.intervalMin || dc.intervalMin || 1,
      nightEco: cloud?.nightEco !== undefined ? Boolean(cloud.nightEco) : (dc.nightEco !== undefined ? Boolean(dc.nightEco) : true),
      nightIntMin: cloud?.nightIntMin || dc.nightIntMin || 20,
      lcdMode: cloud?.lcdMode || dc.lcdMode || "on",
      powerMode: cloud?.powerMode || dc.powerMode || "always_on",
      batteryMah: dc.batteryMah || 3000,
      plotKey: dc.plotKey || st.sheetSource?.tabName || "Plot1",
      scriptUrl: dc.scriptUrl || this.config.defaultScriptUrl || DEFAULT_CONFIG.defaultScriptUrl
    };

    document.getElementById("hw-modal-title").textContent = `ESP32 Hardware & LCD — ${st.shortName}`;
    document.getElementById("hw-interval-input").value = String(this.hwDraft.intervalMin);
    const nightToggle = document.getElementById("hw-night-eco-toggle");
    const nightSelect = document.getElementById("hw-night-interval-select");
    if (nightToggle) nightToggle.checked = this.hwDraft.nightEco;
    if (nightSelect) {
      nightSelect.value = String(this.hwDraft.nightIntMin);
      nightSelect.disabled = !this.hwDraft.nightEco;
    }
    document.getElementById("hw-battery-mah").value = String(this.hwDraft.batteryMah);
    document.getElementById("hw-plot-key").value = this.hwDraft.plotKey;
    document.getElementById("hw-script-url").value = this.hwDraft.scriptUrl;

    this.renderHardwareModalBanner();
    this.renderHardwareModalSelections();
    this.openModal("modal-hardware");
    if (window.lucide) window.lucide.createIcons();
  }

  renderHardwareModalBanner(customOverride = null) {
    const banner = document.getElementById("hw-modal-status-banner");
    const titleEl = document.getElementById("hw-modal-status-title");
    const subEl = document.getElementById("hw-modal-status-sub");
    if (!banner || !titleEl || !subEl) return;

    if (customOverride) {
      banner.className = `hw-status-banner ${customOverride.tone || ""}`;
      titleEl.textContent = customOverride.title;
      subEl.textContent = customOverride.sub;
      return;
    }

    const st = this.getSelectedStation();
    const pk = document.getElementById("hw-plot-key")?.value?.trim() || st.deviceControl?.plotKey || "Plot1";
    const cloud = this.deviceCloudMap[pk];

    const wifiBarsEl = document.getElementById("hw-wifi-bars");
    const wifiHeadEl = document.getElementById("hw-wifi-headline");
    const wifiMetaEl = document.getElementById("hw-wifi-meta");
    const battHeadEl = document.getElementById("hw-battery-telemetry-headline");
    if (wifiBarsEl && wifiHeadEl && wifiMetaEl) {
      const wf = DeviceService.describeWifiSignal(cloud);
      wifiBarsEl.className = `wifi-signal-bars bars-${wf.bars}`;
      wifiBarsEl.style.setProperty("--wifi-color", wf.color);
      if (wf.hasRssi) {
        wifiHeadEl.style.color = wf.color;
        wifiHeadEl.textContent = `${wf.quality} · ${wf.pct}% (${wf.rssi} dBm)`;
        const ssidStr = wf.ssid ? `SSID: ${wf.ssid} · ` : "";
        const ipStr = wf.localIp ? `LAN IP: ${wf.localIp}` : "Cloud Relay Active";
        wifiMetaEl.textContent = `${ssidStr}${ipStr}`;
      } else {
        wifiHeadEl.style.color = "#94a3b8";
        wifiHeadEl.textContent = "Awaiting ESP32 Wi-Fi Signal...";
        wifiMetaEl.textContent = wf.localIp ? `LAN IP: ${wf.localIp}` : "IP: --";
      }

      const onlineBadgeEl = document.getElementById("hw-modal-online-badge");
      const rows = this.getStationRows(st.id);
      const latestRow = rows.slice(-1)[0] || null;
      const mins = cloud?.intervalMin || this.hwDraft?.intervalMin || 1;
      const onStatus = DeviceService.checkDeviceOnlineStatus(cloud, latestRow, mins);

      if (onlineBadgeEl) {
        onlineBadgeEl.textContent = onStatus.label;
        onlineBadgeEl.style.color = onStatus.color;
      }

      if (battHeadEl) {
        const pwr = DeviceService.describePowerAndBattery(cloud, rows, this.rainpointSync?.live?.lux ?? null);
        battHeadEl.style.color = pwr.color;
        battHeadEl.textContent = pwr.hasData
          ? `${pwr.pillLabel} (${pwr.volt}V)`
          : "🔋 Power: Awaiting (GPIO 35)";
        battHeadEl.title = pwr.sourceSub;
      }
    }

    if (cloud) {
      const rssiTxt = cloud.lastRssi ? ` · Wi-Fi ${cloud.lastRssi} dBm` : "";
      const fwTxt = cloud.fw ? ` · Firmware v${cloud.fw}` : "";
      const seenTxt = cloud.lastSeenAt ? `Last ESP32 check-in: ${cloud.lastSeenAt}${rssiTxt}${fwTxt}` : `Waiting for first ESP32 check-in${fwTxt}`;
      if (cloud.isAcked) {
        const pLabel = cloud.powerMode === "deep_sleep"
          ? "Ultra Deep Sleep"
          : (cloud.powerMode === "smart_saver" ? "Smart Saver <1s" : "Always Awake");
        banner.className = "hw-status-banner synced";
        titleEl.textContent = `🟢 Active on ESP32 (${cloud.intervalMin}m · ${pLabel} · LCD: ${cloud.lcdMode})`;
        subEl.textContent = seenTxt;
      } else {
        banner.className = "hw-status-banner queued";
        titleEl.textContent = `🟡 Queued in Cloud Bridge — Waiting for ESP32 Check-In`;
        subEl.textContent = `${seenTxt}. Applies in <1s if Awake/Smart Saver, or on next timer/BOOT wake if in Ultra Deep Sleep.`;
      }
    } else if (!this.deviceTabExists) {
      banner.className = "hw-status-banner";
      titleEl.textContent = "Ready to Link ESP32 Hardware Bridge (v2.0)";
      subEl.textContent = "Make sure Google Apps Script v2.0 + ESP32 v2.0 sketch are installed, then click 'Send Settings to ESP32'.";
    } else {
      banner.className = "hw-status-banner";
      titleEl.textContent = `No Cloud Config Row Yet for ${pk}`;
      subEl.textContent = "Choose your reading interval, LCD & sleep mode below and click 'Send Settings to ESP32'.";
    }
  }

  renderHardwareModalSelections() {
    if (!this.hwDraft) return;

    // 1. Highlight matching preset pill
    document.querySelectorAll("#hw-interval-presets .hw-interval-btn").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.min) === Number(this.hwDraft.intervalMin));
    });

    // 2. Render LCD Mode option cards
    const lcdContainer = document.getElementById("hw-lcd-options");
    lcdContainer.innerHTML = DeviceService.LCD_MODES.map((m) => {
      const active = this.hwDraft.lcdMode === m.id;
      return `
        <button type="button" class="hw-option-card ${active ? "active" : ""}" data-lcd-mode="${m.id}">
          <div class="hw-option-title">
            <span>${this.escapeHtml(m.label)}</span>
            <span style="color:${active ? "#2dd4bf" : "var(--text-muted)"};">${active ? "●" : "○"}</span>
          </div>
          <div class="hw-option-desc">${this.escapeHtml(m.desc)}</div>
        </button>
      `;
    }).join("");

    lcdContainer.querySelectorAll("[data-lcd-mode]").forEach((card) => {
      card.addEventListener("click", () => {
        this.hwDraft.lcdMode = card.dataset.lcdMode;
        if ((this.hwDraft.lcdMode === "on" || this.hwDraft.lcdMode === "text_only") && this.hwDraft.powerMode !== "always_on") {
          this.hwDraft.powerMode = "always_on";
        }
        this.renderHardwareModalSelections();
        this.submitHardwareForm(false);
      });
    });

    // 3. Render Power Mode option cards
    const powContainer = document.getElementById("hw-power-options");
    powContainer.innerHTML = DeviceService.POWER_MODES.map((m) => {
      const active = this.hwDraft.powerMode === m.id;
      return `
        <button type="button" class="hw-option-card ${active ? "active" : ""}" data-power-mode="${m.id}">
          <div class="hw-option-title">
            <span>${this.escapeHtml(m.label)}</span>
            <span style="color:${active ? "#2dd4bf" : "var(--text-muted)"};">${active ? "●" : "○"}</span>
          </div>
          <div class="hw-option-desc">${this.escapeHtml(m.desc)}</div>
        </button>
      `;
    }).join("");

    powContainer.querySelectorAll("[data-power-mode]").forEach((card) => {
      card.addEventListener("click", () => {
        this.hwDraft.powerMode = card.dataset.powerMode;
        if (this.hwDraft.powerMode === "always_on" && this.hwDraft.lcdMode === "off") {
          this.hwDraft.lcdMode = "on";
        } else if (this.hwDraft.powerMode !== "always_on") {
          this.hwDraft.lcdMode = "off";
        }
        this.renderHardwareModalSelections();
        this.submitHardwareForm(false);
      });
    });

    // 4. Update Live Battery Runtime Estimator
    const est = DeviceService.estimateBatteryProfile(this.hwDraft);
    const daysText = est.days >= 2
      ? `~${est.days.toFixed(1)} days`
      : `~${est.totalHours} hours (${est.days.toFixed(1)}d)`;
    document.getElementById("hw-est-days").textContent = daysText;
    document.getElementById("hw-est-ma").textContent = est.avgMa.toFixed(1);
  }

  async instantToggleLcdBacklight() {
    const st = this.getSelectedStation();
    const dc = st.deviceControl || {};
    const plotKey = dc.plotKey || st.sheetSource?.tabName || "Plot1";
    const cloud = this.deviceCloudMap[plotKey];

    const curLcd = cloud?.lcdMode || dc.lcdMode || "on";
    const nextLcd = curLcd === "on" ? "text_only" : "on";
    const intervalMin = cloud?.intervalMin || dc.intervalMin || 1;
    const powerMode = cloud?.powerMode || dc.powerMode || "smart_saver";
    const scriptUrl = dc.scriptUrl || this.config.defaultScriptUrl || DEFAULT_CONFIG.defaultScriptUrl;

    dc.lcdMode = nextLcd;
    dc.powerMode = powerMode;
    st.deviceControl = dc;
    if (cloud) {
      cloud.lcdMode = nextLcd;
      cloud.powerMode = powerMode;
      cloud.isAcked = false;
    }
    ConfigStore.save(this.config);
    this.renderHardwareLiveBar(st);

    const res = await DeviceService.pushConfig(scriptUrl, {
      plotKey,
      intervalMin,
      powerMode,
      lcdMode: nextLcd,
      tareCmd: false,
      localIp: cloud?.localIp || ""
    });

    if (res.ok) {
      this.showToast(`⚡ LCD Backlight -> ${nextLcd === "on" ? "ON" : "OFF"} (${res.via === "lan" ? "Instant LAN" : "<1s Cloud"})`);
      this.scheduleFastDeviceAckPoll(plotKey);
    } else {
      this.showToast(res.message || "Could not reach ESP32 bridge");
    }
  }

  scheduleFastDeviceAckPoll(plotKey) {
    [700, 1500, 2600].forEach((delayMs) => {
      setTimeout(async () => {
        const latest = await DeviceService.fetchSinglePlotFast(plotKey);
        if (!latest) return;
        this.deviceTabExists = true;
        this.deviceCloudMap[plotKey] = latest;
        const st = this.getSelectedStation();
        this.renderHardwareLiveBar(st);
        if (!document.getElementById("modal-hardware").classList.contains("hidden")) {
          this.renderHardwareModalBanner();
        }
      }, delayMs);
    });
  }

  async submitHardwareForm(tareCmd = false) {
    if (!this.hwDraft) return;
    const st = this.getSelectedStation();
    const applyBtn = document.getElementById("btn-hw-apply");

    const intervalMin = Math.max(1, Math.min(240, Number(document.getElementById("hw-interval-input").value) || 1));
    const nightEco = Boolean(document.getElementById("hw-night-eco-toggle")?.checked ?? true);
    const nightIntMin = Math.max(5, Math.min(240, Number(document.getElementById("hw-night-interval-select")?.value) || 20));
    const batteryMah = Math.max(300, Number(document.getElementById("hw-battery-mah").value) || 3000);
    const plotKey = document.getElementById("hw-plot-key").value.trim() || "Plot1";
    const scriptUrl = document.getElementById("hw-script-url").value.trim();
    const prevCloud = this.deviceCloudMap[plotKey];

    this.hwDraft.intervalMin = intervalMin;
    this.hwDraft.nightEco = nightEco;
    this.hwDraft.nightIntMin = nightIntMin;
    this.hwDraft.batteryMah = batteryMah;
    this.hwDraft.plotKey = plotKey;
    this.hwDraft.scriptUrl = scriptUrl;

    st.deviceControl = {
      plotKey,
      scriptUrl,
      intervalMin,
      nightEco,
      nightIntMin,
      powerMode: this.hwDraft.powerMode,
      lcdMode: this.hwDraft.lcdMode,
      batteryMah
    };
    ConfigStore.save(this.config);

    applyBtn.disabled = true;
    const origHtml = applyBtn.innerHTML;
    applyBtn.textContent = "Syncing <1s...";

    const res = await DeviceService.pushConfig(scriptUrl, {
      plotKey,
      intervalMin,
      nightEco,
      nightIntMin,
      powerMode: this.hwDraft.powerMode,
      lcdMode: this.hwDraft.lcdMode,
      tareCmd,
      localIp: prevCloud?.localIp || ""
    });

    applyBtn.disabled = false;
    applyBtn.innerHTML = origHtml;
    if (window.lucide) window.lucide.createIcons();

    if (res.ok) {
      const cfg = res.data?.config || {};
      const desiredTag = `${intervalMin}:${this.hwDraft.powerMode}:${this.hwDraft.lcdMode}`;
      this.deviceTabExists = true;
      this.deviceCloudMap[plotKey] = {
        plotKey,
        intervalMin,
        powerMode: this.hwDraft.powerMode,
        lcdMode: this.hwDraft.lcdMode,
        tareId: cfg.tareId || 0,
        updatedAt: cfg.updatedAt || "",
        lastSeenAt: prevCloud?.lastSeenAt || cfg.updatedAt || "",
        lastSeenDate: DeviceService.parseGmt8Timestamp(prevCloud?.lastSeenAt || cfg.updatedAt),
        lastAckTareId: prevCloud?.lastAckTareId || 0,
        lastRssi: prevCloud?.lastRssi || "",
        localIp: prevCloud?.localIp || "",
        appliedState: cfg.appliedState || prevCloud?.appliedState || "",
        desiredTag,
        isAcked: res.via === "lan" || Boolean(cfg.appliedState && cfg.appliedState === desiredTag)
      };

      this.renderHardwareLiveBar(st);
      this.renderHardwareModalBanner();
      this.scheduleFastDeviceAckPoll(plotKey);

      if (tareCmd) {
        this.showToast(`Remote Tare sent to ${plotKey}!`);
      } else if (res.via === "lan") {
        this.showToast(`⚡ Applied instantly via Local Wi-Fi (${prevCloud?.localIp})!`);
      } else if (this.hwDraft.powerMode === "always_on") {
        this.showToast(`⚡ Sent! ESP32 applies in ~1 second.`);
      } else {
        this.showToast(`Queued for ${plotKey} (applies on next wake or BOOT button press).`);
      }
    } else {
      this.renderHardwareModalBanner({
        tone: "queued",
        title: "⚠ Could Not Reach ESP32 Cloud Bridge",
        sub: res.message
      });
      this.showToast(res.message || "Sync failed");
    }
  }

  async saveStationsModal() {
    this.syncDraftInputsFromDom();
    this.config.stations = this.draftStations;
    this.config.pollIntervalSec = Number(document.getElementById("poll-interval-select").value) || 0;
    this.config.rainpointEndpointUrl = document.getElementById("rainpoint-endpoint-input").value.trim();

    if (!this.config.stations.some((s) => s.id === this.selectedStationId)) {
      this.selectedStationId = this.config.stations[0].id;
    }

    ConfigStore.save(this.config);
    this.closeModal("modal-stations");
    this.setupAutoPoll();
    await this.syncAllEnabledStations(true);
  }

  exportActiveCsv() {
    const st = this.getSelectedStation();
    const analysis = this.stationData[st.id]?.analysis;
    if (!analysis || !analysis.hasData) {
      this.showToast("No telemetry rows to export yet.");
      return;
    }
    const header = "Date,Time,Weight_kg,Moisture_Pct\n";
    const lines = analysis.enrichedRows.map((r) => `${r.dateStr},${r.timeStr},${r.weightKg.toFixed(3)},${r.moisturePct.toFixed(1)}`).join("\n");
    const blob = new Blob([header + lines], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${st.shortName.toLowerCase().replace(/\s+/g, "-")}-cocopeat-log.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  openModal(id) {
    document.getElementById(id).classList.remove("hidden");
  }

  closeModal(id) {
    document.getElementById(id).classList.add("hidden");
  }

  showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      t.style.opacity = "0";
    }, 3200);
  }

  escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  escapeAttr(str) {
    return this.escapeHtml(str).replace(/"/g, "&quot;");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.cocoScaleApp = new CocoScaleApp();
  window.cocoScaleApp.init();
});
