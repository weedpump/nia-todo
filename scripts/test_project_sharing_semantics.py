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
    from services.entity_access import register_personal_entity
    from routers.sharing import (
        AcceptInviteRequest,
        RestoreMemberRequest,
        ShareProjectRequest,
        leave_project,
        list_project_members,
        remove_member,
        respond_to_invite,
        restore_member,
        share_project,
        transition_member_status,
        transition_pending_invite,
        undo_leave_project,
    )
    import services.websocket as websocket_service

    run_migrations()
    with get_db() as db:
        owner_id = db.execute("INSERT INTO users (username) VALUES ('owner')").lastrowid
        target_id = db.execute("INSERT INTO users (username) VALUES ('target')").lastrowid
        email_target_id = db.execute(
            "INSERT INTO users (username, email, email_verified_at) VALUES ('email-target', 'email-target@example.invalid', datetime('now'))"
        ).lastrowid
        gain_target_id = db.execute("INSERT INTO users (username) VALUES ('gain-target')").lastrowid
        decline_target_id = db.execute("INSERT INTO users (username) VALUES ('decline-target')").lastrowid
        project_id = db.execute("INSERT INTO projects (name, user_id) VALUES ('Shared', ?)", (owner_id,)).lastrowid
        register_personal_entity(db, "project", project_id, owner_id)
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

    decline_messages = {}
    decline_original_broadcast = websocket_service.manager.broadcast_to_user

    async def capture_decline(user_id, message):
        decline_messages.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_decline
    try:
        decline_invite = asyncio.run(
            share_project(project_id, ShareProjectRequest(username='decline-target'), request, owner_id)
        )
        creation_syncs = [
            message for message in decline_messages.get(decline_target_id, [])
            if message.get('type') == 'sync_response'
        ]
        assert creation_syncs, decline_messages
        assert decline_invite['member']['id'] in {
            invite['id'] for invite in creation_syncs[-1]['project_invites']
        }
        owner_creation_syncs = [
            message for message in decline_messages.get(owner_id, [])
            if message.get('type') == 'sync_response'
        ]
        assert owner_creation_syncs, decline_messages
        owner_synced_project = next(
            project for project in owner_creation_syncs[-1]['projects'] if project['id'] == project_id
        )
        assert decline_invite['member']['id'] in {
            member['id'] for member in owner_synced_project['members']
        }
        asyncio.run(respond_to_invite(
            project_id, decline_invite['member']['id'], AcceptInviteRequest(accept=False), decline_target_id
        ))
    finally:
        websocket_service.manager.broadcast_to_user = decline_original_broadcast
    decline_syncs = [
        message for message in decline_messages.get(decline_target_id, [])
        if message.get('type') == 'sync_response'
    ]
    assert len(decline_syncs) >= 2, decline_messages
    assert decline_syncs[-1]['project_invites'] == []
    assert any(
        message.get('type') == 'sync_response'
        for message in decline_messages.get(owner_id, [])
    ), decline_messages

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

    # A departing member must receive a recipient-specific removal snapshot.
    result = asyncio.run(share_project(project_id, ShareProjectRequest(username='target'), request, owner_id))
    with get_db() as db:
        db.execute("UPDATE project_members SET status = 'accepted' WHERE id = ?", (result['member']['id'],))
        db.commit()
    websocket_messages = {}
    original_broadcast_to_user = websocket_service.manager.broadcast_to_user

    async def capture_broadcast(user_id, message):
        websocket_messages.setdefault(user_id, []).append(message)
        return True

    gain_invite = asyncio.run(share_project(project_id, ShareProjectRequest(username='gain-target'), request, owner_id))
    websocket_service.manager.broadcast_to_user = capture_broadcast
    try:
        asyncio.run(respond_to_invite(
            project_id, gain_invite['member']['id'], AcceptInviteRequest(accept=True), gain_target_id
        ))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    gain_syncs = [
        message for message in websocket_messages.get(gain_target_id, [])
        if message.get('type') == 'sync_response'
    ]
    assert gain_syncs, websocket_messages
    assert project_id in {project['id'] for project in gain_syncs[-1]['projects']}
    websocket_messages.clear()

    websocket_service.manager.broadcast_to_user = capture_broadcast
    try:
        asyncio.run(leave_project(project_id, target_id))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    target_syncs = [
        message for message in websocket_messages.get(target_id, [])
        if message.get('type') == 'sync_response'
    ]
    assert target_syncs, websocket_messages
    assert project_id not in {project['id'] for project in target_syncs[-1]['projects']}

    websocket_messages.clear()
    websocket_service.manager.broadcast_to_user = capture_broadcast
    try:
        asyncio.run(undo_leave_project(project_id, target_id))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    target_syncs = [
        message for message in websocket_messages.get(target_id, [])
        if message.get('type') == 'sync_response'
    ]
    assert target_syncs, websocket_messages
    assert project_id in {project['id'] for project in target_syncs[-1]['projects']}

    # Owner removal uses the same pre-revocation recipient set.
    websocket_messages.clear()
    websocket_service.manager.broadcast_to_user = capture_broadcast
    try:
        asyncio.run(remove_member(project_id, target_id, owner_id))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    target_syncs = [
        message for message in websocket_messages.get(target_id, [])
        if message.get('type') == 'sync_response'
    ]
    assert target_syncs, websocket_messages
    assert project_id not in {project['id'] for project in target_syncs[-1]['projects']}

    websocket_messages.clear()
    websocket_service.manager.broadcast_to_user = capture_broadcast
    try:
        asyncio.run(restore_member(
            project_id, target_id, RestoreMemberRequest(status='accepted'), owner_id
        ))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    target_syncs = [
        message for message in websocket_messages.get(target_id, [])
        if message.get('type') == 'sync_response'
    ]
    assert target_syncs, websocket_messages
    assert project_id in {project['id'] for project in target_syncs[-1]['projects']}

print('✅ Project invitations are explicit, visible, revocable and race-safe')
