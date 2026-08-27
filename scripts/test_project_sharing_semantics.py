#!/usr/bin/env python3
"""Project invitations are explicit, owner-visible and revocable."""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
    os.environ['NIA_TODO_DATA_DIR'] = tmp
    sys.path.insert(0, str(ROOT / 'api'))
    from fastapi import HTTPException
    from starlette.requests import Request
    from db import get_db
    from migrate import run_migrations
    from routers.sharing import (
        ShareProjectRequest,
        list_project_members,
        remove_member,
        share_project,
        transition_member_status,
        transition_pending_invite,
    )

    run_migrations()
    with get_db() as db:
        owner_id = db.execute("INSERT INTO users (username) VALUES ('owner')").lastrowid
        target_id = db.execute("INSERT INTO users (username) VALUES ('target')").lastrowid
        email_target_id = db.execute(
            "INSERT INTO users (username, email, email_verified_at) VALUES ('email-target', 'email-target@example.invalid', datetime('now'))"
        ).lastrowid
        project_id = db.execute("INSERT INTO projects (name, user_id) VALUES ('Shared', ?)", (owner_id,)).lastrowid
        db.commit()

    request = Request({'type': 'http', 'method': 'POST', 'path': '/', 'headers': [], 'scheme': 'http', 'server': ('test', 80), 'client': ('127.0.0.1', 1), 'query_string': b''})
    try:
        asyncio.run(share_project(project_id, ShareProjectRequest(username='missing-user'), request, owner_id))
    except HTTPException as error:
        assert error.status_code == 404
    else:
        raise AssertionError('unknown username did not return 404')

    result = asyncio.run(share_project(project_id, ShareProjectRequest(username='target'), request, owner_id))
    assert result['member']['user_id'] == target_id
    assert result['member']['status'] == 'pending'
    owner_view = list_project_members(project_id, owner_id)
    assert any(member['user_id'] == target_id and member['status'] == 'pending' for member in owner_view['members'])

    try:
        asyncio.run(share_project(project_id, ShareProjectRequest(username='missing@example.invalid'), request, owner_id))
    except HTTPException as error:
        assert error.status_code == 404
    else:
        raise AssertionError('unknown email did not return 404')

    email_result = asyncio.run(
        share_project(project_id, ShareProjectRequest(username='email-target@example.invalid'), request, owner_id)
    )
    assert email_result['member']['user_id'] == email_target_id
    assert email_result['member']['status'] == 'pending'
    owner_view = list_project_members(project_id, owner_id)
    assert any(member['user_id'] == email_target_id and member['status'] == 'pending' for member in owner_view['members'])
    asyncio.run(remove_member(project_id, email_target_id, owner_id))
    owner_view = list_project_members(project_id, owner_id)
    assert all(member['user_id'] != email_target_id for member in owner_view['members'])

    with get_db() as db:
        invite = db.execute(
            "SELECT id FROM project_members WHERE project_id = ? AND user_id = ?",
            (project_id, target_id),
        ).fetchone()
        db.execute("UPDATE project_members SET status = 'removed' WHERE id = ?", (invite['id'],))
        db.commit()
        transitioned = transition_pending_invite(db, invite['id'], 'accepted', None)
        db.commit()
        assert transitioned is False
        assert db.execute("SELECT status FROM project_members WHERE id = ?", (invite['id'],)).fetchone()['status'] == 'removed'
        assert transition_member_status(db, invite['id'], 'accepted', 'left') is False
        assert transition_member_status(db, invite['id'], 'left', 'accepted') is False
        db.commit()
        assert db.execute("SELECT status FROM project_members WHERE id = ?", (invite['id'],)).fetchone()['status'] == 'removed'

    # Re-invite and verify normal owner withdrawal still works.
    result = asyncio.run(share_project(project_id, ShareProjectRequest(username='target'), request, owner_id))
    assert result['member']['status'] == 'pending'
    asyncio.run(remove_member(project_id, target_id, owner_id))
    owner_view = list_project_members(project_id, owner_id)
    assert all(member['user_id'] != target_id for member in owner_view['members'])

print('✅ Project invitations are explicit, visible, revocable and race-safe')
