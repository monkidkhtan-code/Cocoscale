/**
 * KH COCOSCALE — GRAVIMETRIC COCOPEAT MOISTURE & DRY-BACK ENGINE
 * Converts load-cell weight (kg) into Available Water %, Water Deficit (mL),
 * Recommended Drip Shot Dose (mL), Dry-Back %, Transpiration Rate (mL/hr),
 * and Auto-Detected Fertigation Cycles.
 */

class MoistureEngine {
  /**
   * Compute moisture % for a single raw weight reading given calibration
   */
  static computeReadingMetrics(uncalibratedRawWeightKg, cal) {
    // Apply in-app hardware scale calibration multiplier & offset (recalibrate without re-flashing)
    const mult = (Number(cal?.scaleMultiplier) > 0) ? Number(cal.scaleMultiplier) : 1.0;
    const off = Number(cal?.scaleOffset) || 0;
    const rawWeightKg = (uncalibratedRawWeightKg * mult) + off;

    const fc = Number(cal?.fieldCapacityKg) || 13.5;
    const dry = Number(cal?.dryWeightKg) || 3.5;
    const biomass = Number(cal?.plantBiomassKg) || 0;
    const capacityKg = Math.max(0.2, fc - dry);

    // Subtract estimated plant/fruit biomass growth to isolate substrate + water
    const effectiveWeightKg = rawWeightKg - biomass;
    const waterKg = effectiveWeightKg - dry;
    const rawPct = (waterKg / capacityKg) * 100;
    const clampedPct = Math.max(0, Math.min(115, rawPct));
    const displayPct = Math.max(0, Math.round(rawPct * 10) / 10);

    // Thresholds in effective & raw scale kg
    const triggerPct = Number(cal.irrigateTriggerPct) || 70;
    const criticalPct = Number(cal.criticalFloorPct) || 50;
    const triggerRawKg = dry + (capacityKg * (triggerPct / 100)) + biomass;
    const criticalRawKg = dry + (capacityKg * (criticalPct / 100)) + biomass;
    const fieldCapacityRawKg = fc + biomass;

    // Water deficit to restore 100% Field Capacity (1 kg water = 1000 mL)
    const deficitKg = Math.max(0, fieldCapacityRawKg - rawWeightKg);
    const deficitMl = Math.round(deficitKg * 1000);

    // Recommended drip shot including target EC-flush runoff %
    const runoffFrac = Math.min(0.5, Math.max(0, (Number(cal.targetRunoffPct) || 15) / 100));
    const recommendedShotMl = deficitMl > 0
      ? Math.round(deficitMl / (1 - runoffFrac))
      : 0;

    // Determine agronomic status
    let status = "OPTIMAL";
    let statusLabel = "Optimal Moisture";
    let statusTone = "good";
    let advisory = "Cocopeat moisture is in the healthy fertigation zone. Good root oxygen + water balance.";

    if (dry >= 1.0 && rawWeightKg < 0.25) {
      status = "UNLOADED";
      statusLabel = "Scale Unloaded · Tare";
      statusTone = "info";
      advisory = "Scale currently reads near 0 kg (no polybag on load cell, or prototype bench testing). Place your cocopeat polybag on the platform, or click 'Calibrate Bag & Thresholds' -> 'Bench Test Preset (0–0.65 kg)' to visualize small test weights.";
    } else if (rawPct > 103) {
      status = "DRAINING";
      statusLabel = "Saturated · Draining";
      statusTone = "info";
      advisory = "Weight is above 100% Field Capacity — excess nutrient solution is actively draining out as runoff.";
    } else if (rawPct < criticalPct) {
      status = "CRITICAL_STRESS";
      statusLabel = "Critical Dry-Back!";
      statusTone = "danger";
      advisory = `Moisture dropped below ${criticalPct}% floor (${criticalRawKg.toFixed(2)} kg). Irrigate immediately (~${recommendedShotMl} mL) to prevent salt EC spike & chili blossom-end rot.`;
    } else if (rawPct <= triggerPct) {
      status = "IRRIGATE_NOW";
      statusLabel = "Irrigate Trigger Reached";
      statusTone = "warn";
      advisory = `Target dry-back reached (${(100 - displayPct).toFixed(1)}% dry-back). Ready for next drip shot (~${recommendedShotMl} mL including ${cal.targetRunoffPct || 15}% runoff).`;
    } else if (rawPct <= triggerPct + 5) {
      status = "REFILL_SOON";
      statusLabel = "Approaching Trigger";
      statusTone = "watch";
      advisory = `Within ${((rawWeightKg - triggerRawKg) * 1000).toFixed(0)} mL of your irrigation trigger (${triggerRawKg.toFixed(2)} kg). Prepare next drip cycle soon.`;
    }

    return {
      rawWeightKg,
      effectiveWeightKg,
      waterKg: Math.max(0, waterKg),
      waterCapacityKg: capacityKg,
      rawPct,
      clampedPct,
      displayPct,
      dryBackFromFcPct: status === "UNLOADED"
        ? 0
        : Math.min(100, Math.max(0, Math.round((100 - rawPct) * 10) / 10)),
      triggerRawKg,
      criticalRawKg,
      fieldCapacityRawKg,
      deficitMl,
      recommendedShotMl,
      status,
      statusLabel,
      statusTone,
      advisory
    };
  }

  /**
   * Analyze full sorted time-series rows: [{ ts: Date, dateStr, timeStr, weightKg }]
   */
  static analyzeSeries(rows, station, staleMinutes = 35) {
    const cal = station.calibration;
    if (!rows || rows.length === 0) {
      return {
        hasData: false,
        latest: null,
        metrics: null,
        enrichedRows: [],
        irrigationEvents: [],
        dryBackToday: null,
        overnightDryBack: null,
        dryingRateMlPerHr: null,
        hoursToTrigger: null,
        isStale: true,
        ageMinutes: null
      };
    }

    const enrichedRows = rows.map((r) => {
      const m = this.computeReadingMetrics(r.weightKg, cal);
      return {
        ...r,
        weightKg: m.rawWeightKg,
        uncalibratedWeightKg: r.weightKg,
        moisturePct: m.displayPct,
        rawPct: m.rawPct
      };
    });

    const latest = enrichedRows[enrichedRows.length - 1];
    const metrics = latest ? this.computeReadingMetrics(latest.uncalibratedWeightKg, cal) : null;

    const ageMs = Date.now() - latest.ts.getTime();
    const ageMinutes = Math.max(0, Math.round(ageMs / 60000));
    const isStale = ageMinutes > staleMinutes;

    // 1. Auto-detect irrigation / liquid-in cycles (any upward weight increase > 5 mL / 0.005 kg)
    const minJump = 0.006; // > 5 mL
    const rateJumpThreshold = Math.max(0.05, Number(cal.irrigationJumpKg) || 0.05);
    const irrigationEvents = [];
    let activeEvent = null;

    for (let i = 1; i < enrichedRows.length; i++) {
      const prev = enrichedRows[i - 1];
      const curr = enrichedRows[i];
      const deltaKg = curr.weightKg - prev.weightKg;
      const gapMins = (curr.ts - prev.ts) / 60000;

      // Ignore massive multi-day gaps
      if (gapMins > 360) {
        if (activeEvent) {
          irrigationEvents.push(activeEvent);
          activeEvent = null;
        }
        continue;
      }

      if (deltaKg >= minJump) {
        if (activeEvent && (curr.ts - activeEvent.lastTs) / 60000 <= 25) {
          activeEvent.peakWeightKg = Math.max(activeEvent.peakWeightKg, curr.weightKg);
          activeEvent.lastTs = curr.ts;
          activeEvent.gainKg = activeEvent.peakWeightKg - activeEvent.preWeightKg;
          activeEvent.gainMl = Math.round(activeEvent.gainKg * 1000);
        } else {
          if (activeEvent) irrigationEvents.push(activeEvent);
          activeEvent = {
            startTs: prev.ts,
            peakTs: curr.ts,
            lastTs: curr.ts,
            preWeightKg: prev.weightKg,
            peakWeightKg: curr.weightKg,
            gainKg: deltaKg,
            gainMl: Math.round(deltaKg * 1000)
          };
        }
      } else if (activeEvent && deltaKg > 0.02 && (curr.ts - activeEvent.lastTs) / 60000 <= 20) {
        activeEvent.peakWeightKg = Math.max(activeEvent.peakWeightKg, curr.weightKg);
        activeEvent.peakTs = curr.ts;
        activeEvent.lastTs = curr.ts;
        activeEvent.gainKg = activeEvent.peakWeightKg - activeEvent.preWeightKg;
        activeEvent.gainMl = Math.round(activeEvent.gainKg * 1000);
      } else if (activeEvent && (curr.ts - activeEvent.lastTs) / 60000 > 20) {
        irrigationEvents.push(activeEvent);
        activeEvent = null;
      }
    }
    if (activeEvent) irrigationEvents.push(activeEvent);

    // 2. Today's Peak & Dry-Back since today's peak (using latest reading's calendar day)
    const refDayStr = this.toLocalDayKey(latest.ts);
    const todayRows = enrichedRows.filter((r) => this.toLocalDayKey(r.ts) === refDayStr);
    let dryBackToday = null;
    if (todayRows.length >= 2) {
      let peakRow = todayRows[0];
      for (const r of todayRows) {
        if (r.weightKg >= peakRow.weightKg) peakRow = r;
      }
      const dropKg = Math.max(0, peakRow.weightKg - latest.weightKg);
      const dropPct = Math.max(0, peakRow.moisturePct - latest.moisturePct);
      dryBackToday = {
        peakWeightKg: peakRow.weightKg,
        peakTs: peakRow.ts,
        minWeightKg: Math.min(...todayRows.map((r) => r.weightKg)),
        dropKg,
        dropMl: Math.round(dropKg * 1000),
        dropMoisturePct: Math.round(dropPct * 10) / 10,
        shotsToday: irrigationEvents.filter((ev) => this.toLocalDayKey(ev.peakTs) === refDayStr).length
      };
    }

    // 3. Overnight Dry-Back (Yesterday 18:00-23:59 -> Today 05:30-09:00 before first morning irrigation)
    let overnightDryBack = null;
    const prevDate = new Date(latest.ts);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDayStr = this.toLocalDayKey(prevDate);
    const prevEveningRows = enrichedRows.filter((r) => {
      return this.toLocalDayKey(r.ts) === prevDayStr && r.ts.getHours() >= 17;
    });
    const morningRows = todayRows.filter((r) => r.ts.getHours() >= 5 && r.ts.getHours() <= 9);
    if (prevEveningRows.length > 0 && morningRows.length > 0) {
      const eveningRef = prevEveningRows[0]; // Early evening post-last-drip reading
      // Find lowest morning reading before first jump
      let morningMin = morningRows[0];
      for (const r of morningRows) {
        if (r.weightKg < morningMin.weightKg) morningMin = r;
      }
      const lossKg = Math.max(0, eveningRef.weightKg - morningMin.weightKg);
      const lossPct = Math.max(0, eveningRef.moisturePct - morningMin.moisturePct);
      overnightDryBack = {
        eveningWeightKg: eveningRef.weightKg,
        morningWeightKg: morningMin.weightKg,
        lossKg,
        lossMl: Math.round(lossKg * 1000),
        lossPct: Math.round(lossPct * 10) / 10
      };
    }

    // 4. Recent Transpiration / Drying Rate (mL/hr) over last 30m - 180m monotonic/net drying window
    let dryingRateMlPerHr = null;
    let hoursToTrigger = null;
    const threeHoursAgo = latest.ts.getTime() - 3 * 3600 * 1000;
    const recentWindow = enrichedRows.filter((r) => r.ts.getTime() >= threeHoursAgo);
    if (recentWindow.length >= 2) {
      // Start after the latest irrigation jump inside the 3h window
      let startIdx = 0;
      for (let i = 1; i < recentWindow.length; i++) {
        if (recentWindow[i].weightKg - recentWindow[i - 1].weightKg >= rateJumpThreshold) {
          startIdx = i;
        }
      }
      const drySegment = recentWindow.slice(startIdx);
      if (drySegment.length >= 2) {
        const first = drySegment[0];
        const last = drySegment[drySegment.length - 1];
        const dtHours = (last.ts - first.ts) / 3600000;
        if (dtHours >= 0.2) {
          const lossKg = first.weightKg - last.weightKg;
          if (lossKg > 0) {
            dryingRateMlPerHr = Math.round((lossKg * 1000) / dtHours);
            const kgAboveTrigger = latest.weightKg - metrics.triggerRawKg;
            if (kgAboveTrigger > 0 && dryingRateMlPerHr > 10) {
              hoursToTrigger = (kgAboveTrigger * 1000) / dryingRateMlPerHr;
            } else if (kgAboveTrigger <= 0) {
              hoursToTrigger = 0;
            }
          } else {
            dryingRateMlPerHr = 0;
          }
        }
      }
    }

    return {
      hasData: true,
      latest,
      metrics,
      enrichedRows,
      irrigationEvents: irrigationEvents.slice().reverse(), // newest first
      dryBackToday,
      overnightDryBack,
      dryingRateMlPerHr,
      hoursToTrigger,
      isStale,
      ageMinutes
    };
  }

  static toLocalDayKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
}

window.MoistureEngine = MoistureEngine;
