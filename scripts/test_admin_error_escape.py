#!/usr/bin/env python3
"""Regression check for escaping admin error messages rendered via innerHTML."""

from pathlib import Path

content = (Path(__file__).resolve().parents[1] / "web" / "admin.html").read_text()
unsafe = '`<tr><td colspan="12" class="empty-state">Error: ${e.message}</td></tr>`'
safe = '`<tr><td colspan="12" class="empty-state">Error: ${escapeHtml(e.message)}</td></tr>`'

assert unsafe not in content
assert safe in content
print("✅ Admin user-list error message is escaped")
