#!/usr/bin/env python3
"""First user cannot be created before the admin credential exists."""
import os
import sys
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory() as tmp:
    os.environ['NIA_TODO_DATA_DIR'] = tmp
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
    from db import get_db
    from fastapi import HTTPException
    from migrate import run_migrations
    from routers.setup import FirstUserRequest, setup_first_user
    from services.setup_token import ensure_setup_token, validate_setup_token

    run_migrations()
    token = ensure_setup_token(setup_complete=False)
    request = FirstUserRequest(username='firstuser', email='first@example.invalid', password='Password1!', display_name='First User')
    try:
        setup_first_user(request, None, None, None)
    except HTTPException as error:
        assert error.status_code == 409
    else:
        raise AssertionError('first user was created before the admin password')
    with get_db() as db:
        assert db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0
    assert validate_setup_token(token)

print('✅ First-run setup sequence is enforced')
