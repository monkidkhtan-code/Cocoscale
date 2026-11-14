# KH CocoScale — Cocopeat Moisture Weight Monitor

Standalone gravimetric (load-cell weight) cocopeat moisture, dry-back, and fertigation dose dashboard built for **KH Agrifarm** chili polybag plots.

## Why Gravimetric Weight Over Capacitive Probes
Capacitive soil probes drift heavily in cocopeat due to air pockets, localized root channeling, and fertilizer EC salt shifts. Measuring polybag weight directly (`1.000 kg Δ = 1,000 mL water`) gives exact:
- **Available Water (%)** & **Liters in Bag**
- **Water Deficit (`mL`)** & **Recommended Drip Dose (`mL`)** (with configurable EC-flush runoff %)
- **Today's Peak Dry-Back & Overnight Dry-Back (%)**
- **Transpiration Rate (`mL/hr`)** & estimated countdown to next drip shot
- **Auto-Detected Fertigation Pulses** from upward weight jumps

## Quick Start
1. Set `C:\Users\monki\.gemini\antigravity\scratch\cocopeat-weight-monitor` as your active workspace.
2. Serve locally with Python (`python -m http.server 8080`) and open `http://localhost:8080`, or deploy directly to Netlify (`netlify.toml` included).
3. In your Google Sheet (`Date, Time, Weight_kg`), click **Share → Anyone with the link (Viewer)** (or **File → Share → Publish to web**), then click **Sync Sheet** in the dashboard.

## Scaling to Plot 2 & Plot 3
- **Plot 2** and **Plot 3** are pre-configured in standby mode.
- Click **Scale Stations** in the top bar to enable Plot 2 / Plot 3 (pointing to a new tab `Plot2` / `Plot3` or `gid` in the same Google Sheet, or a separate Sheet/Apps Script URL), or click **Add Another Scale Station** to add unlimited stations.
