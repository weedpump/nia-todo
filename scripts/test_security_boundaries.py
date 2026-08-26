#!/usr/bin/env python3
"""Security boundary regression checks for CSP, first-run setup and native IPC."""
import json
import re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
handler=re.compile(r'\son(?:click|change|submit|input|keydown|keyup|blur|focus)=',re.I)
inline_script=re.compile(r'<script(?:\s+type="module")?\s*>',re.I)
for file in (ROOT/'web').rglob('*'):
    if not file.is_file() or file.suffix not in {'.html','.js'} or 'vendor/tauri-api' in file.as_posix():
        continue
    text=file.read_text(errors='ignore')
    assert not handler.search(text), str(file)
    if file.suffix=='.html': assert not inline_script.search(text), str(file)
    assert 'window.__TAURI__' not in text, str(file)
security=(ROOT/'api/middleware/security.py').read_text()
assert "script-src 'self' 'unsafe-inline'" not in security
config=json.loads((ROOT/'src-tauri/tauri.conf.json').read_text())
assert config['app']['withGlobalTauri'] is False
assert "script-src 'self' 'unsafe-inline'" not in config['app']['security']['csp']
setup=(ROOT/'api/routers/setup.py').read_text()
assert setup.count('Depends(require_setup_token)') == 2
assert 'consume_setup_token()' in setup
print('✅ Browser, setup and native trust boundaries are hardened')
