#!/usr/bin/env python3
"""Regression tests for one-time first-run setup tokens."""
import os
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory() as tmp:
    os.environ['NIA_TODO_DATA_DIR'] = tmp
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
    from services.setup_token import ensure_setup_token, validate_setup_token, consume_setup_token

    token = ensure_setup_token(setup_complete=False)
    assert token and len(token) >= 32
    token_path = Path(tmp) / 'setup-token'
    assert token_path.stat().st_mode & 0o777 == 0o600
    assert validate_setup_token(token)
    assert not validate_setup_token('wrong-token')
    assert ensure_setup_token(setup_complete=False) == token
    consume_setup_token()
    assert not validate_setup_token(token)
    assert ensure_setup_token(setup_complete=True) is None

print('✅ One-time setup token lifecycle passed')
