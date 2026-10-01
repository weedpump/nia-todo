#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / "web/admin.html").read_text(encoding="utf-8")
js = (ROOT / "web/static/js/pages/admin.js").read_text(encoding="utf-8")
css = (ROOT / "web/static/css/72-admin.css").read_text(encoding="utf-8")

assert 'id="instance-update-analytics-enabled"' in html
assert 'admin.instance.updateAnalytics' in html
assert 'class="admin-config-field admin-config-checkbox switch-right full admin-config-privacy-panel"' in html
assert 'href="https://homelabdiary.dev/en/privacy/"' in html
assert 'admin.instance.updateAnalyticsPrivacy' in html
assert '.admin-config-privacy-panel' in css
assert '.instance-config-overview-help' in css
assert "config.update_analytics_enabled !== false" in js
assert "let loadedInstanceUpdateAnalyticsEnabled = null" in js
assert "analyticsEnabled !== loadedInstanceUpdateAnalyticsEnabled" in js
assert "payload.update_analytics_enabled = analyticsEnabled" in js
login_flow = js.split("async function doAdminLogin", 1)[1].split("async function loadAdminData", 1)[0]
assert login_flow.index("await loadAdminData();") < login_flow.index("setAdminAuthenticated(true);")

locale_dir = ROOT / "web/static/i18n"
locales = sorted(locale_dir.glob("*.json"))
assert len(locales) == 12, len(locales)
for locale in locales:
    data = json.loads(locale.read_text(encoding="utf-8"))
    assert data.get("admin.instance.updateAnalytics"), locale.name
    assert data.get("admin.instance.updateAnalyticsHelp"), locale.name
    assert data.get("admin.instance.updateAnalyticsPrivacy"), locale.name

print("✅ Update analytics admin static contract passed")