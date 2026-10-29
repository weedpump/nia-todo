#!/usr/bin/env python3
"""Shopping lists form one household-aware vertical slice."""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as tmp:
    os.environ["NIA_TODO_DATA_DIR"] = tmp
    sys.path.insert(0, str(ROOT / "api"))

    from db import get_db
    from migrate import run_migrations
    from routers.admin import delete_user
    from routers.households import dissolve_household_endpoint
    import routers.shopping as shopping_router
    from routers.shopping import (
        ShoppingItemCreate,
        ShoppingItemUpdate,
        ShoppingListCreate,
        ShoppingListHouseholdTransfer,
        ShoppingListShareCreate,
        ShoppingListUpdate,
        ShoppingPreferencesUpdate,
        ShoppingSectionCreate,
        ShoppingSectionUpdate,
        ShoppingStoreCreate,
        ShoppingStoreUpdate,
        create_shopping_item,
        create_shopping_list,
        create_shopping_section,
        create_shopping_store,
        delete_shopping_store,
        delete_shopping_list,
        delete_shopping_item,
        delete_completed_shopping_items,
        delete_shopping_section,
        get_shopping_list,
        list_shopping_stores,
        list_shopping_lists,
        list_shopping_list_members,
        leave_shopping_list,
        revoke_shopping_list_member,
        share_shopping_list,
        transfer_shopping_list_to_household,
        update_shopping_item,
        update_shopping_list,
        update_shopping_preferences,
        update_shopping_section,
        update_shopping_store,
    )
    from services.entity_access import (
        create_household,

        invite_household_member,
        respond_to_household_invite,
    )
    from routers.websocket import get_sync_payload

    run_migrations()

    with get_db() as db:
        owner_id = db.execute("INSERT INTO users (username) VALUES ('owner')").lastrowid
        member_id = db.execute("INSERT INTO users (username) VALUES ('member')").lastrowid
        shared_id = db.execute("INSERT INTO users (username) VALUES ('shared')").lastrowid
        outsider_id = db.execute("INSERT INTO users (username) VALUES ('outsider')").lastrowid
        household_id = create_household(db, "Home", owner_id)
        invite_id = invite_household_member(db, household_id, owner_id, member_id)
        respond_to_household_invite(db, invite_id, member_id, accept=True)
        db.commit()

    personal = asyncio.run(
        create_shopping_list(
            ShoppingListCreate(
                name="Weekly shopping",
                color="#6366f1",
                icon="shopping-cart",
                client_mutation_id="personal-list-1",
            ),
            owner_id,
        )
    )
    personal_id = personal["id"]
    assert personal["ownership_type"] == "user", personal
    assert personal["is_owner"] is True, personal
    assert personal["household_name"] is None, personal
    renamed_personal = asyncio.run(
        update_shopping_list(
            personal_id,
            ShoppingListUpdate(name="Weekly groceries", color="#10b981", icon="package", sort_order=4),
            owner_id,
        )
    )
    assert renamed_personal["name"] == "Weekly groceries", renamed_personal
    assert renamed_personal["color"] == "#10b981", renamed_personal
    assert renamed_personal["icon"] == "package", renamed_personal
    assert renamed_personal["sort_order"] == 4, renamed_personal

    no_icon = asyncio.run(
        create_shopping_list(
            ShoppingListCreate(name="No icon", icon=None, client_mutation_id="no-icon-list"),
            owner_id,
        )
    )
    assert no_icon["icon"] is None, no_icon
    with_icon = asyncio.run(update_shopping_list(no_icon["id"], ShoppingListUpdate(icon="package"), owner_id))
    assert with_icon["icon"] == "package", with_icon
    cleared_icon = asyncio.run(update_shopping_list(no_icon["id"], ShoppingListUpdate(icon=None), owner_id))
    assert cleared_icon["icon"] is None, cleared_icon
    assert get_shopping_list(no_icon["id"], owner_id)["icon"] is None

    disposable = asyncio.run(create_shopping_list(ShoppingListCreate(name="Disposable"), owner_id))
    disposable_section = asyncio.run(
        create_shopping_section(disposable["id"], ShoppingSectionCreate(name="Disposable section"), owner_id)
    )
    disposable_item = asyncio.run(
        create_shopping_item(
            disposable["id"],
            ShoppingItemCreate(name="Disposable item", section_id=disposable_section["id"]),
            owner_id,
        )
    )
    asyncio.run(delete_shopping_list(disposable["id"], owner_id))
    assert disposable["id"] not in {row["id"] for row in list_shopping_lists(owner_id)["shopping_lists"]}
    with get_db() as db:
        assert not db.execute(
            "SELECT 1 FROM entity_access WHERE entity_type = 'shopping_list' AND entity_id = ?",
            (disposable["id"],),
        ).fetchone()
        assert not db.execute("SELECT 1 FROM shopping_sections WHERE id = ?", (disposable_section["id"],)).fetchone()
        assert not db.execute("SELECT 1 FROM shopping_items WHERE id = ?", (disposable_item["id"],)).fetchone()

    duplicate = asyncio.run(
        create_shopping_list(
            ShoppingListCreate(
                name="Ignored duplicate title",
                client_mutation_id="personal-list-1",
            ),
            owner_id,
        )
    )
    assert duplicate["id"] == personal_id, duplicate

    shared_member = asyncio.run(
        share_shopping_list(personal_id, ShoppingListShareCreate(identifier="shared"), owner_id)
    )
    assert shared_member["id"] == shared_id, shared_member
    assert [row["id"] for row in list_shopping_list_members(personal_id, owner_id)["members"]] == [shared_id]

    shared_lists = list_shopping_lists(shared_id)["shopping_lists"]
    assert [row["id"] for row in shared_lists] == [personal_id]
    assert shared_lists[0]["owner_username"] == "owner", shared_lists[0]
    assert shared_lists[0]["is_shared"] is True, shared_lists[0]
    assert shared_lists[0]["can_edit"] is True, shared_lists[0]
    assert shared_lists[0]["can_manage"] is False, shared_lists[0]
    try:
        asyncio.run(update_shopping_list(personal_id, ShoppingListUpdate(name="Recipient rename"), shared_id))
    except HTTPException as error:
        assert error.status_code in {403, 404}, error
    else:
        raise AssertionError("Direct recipient changed shopping-list metadata")
    with get_db() as db:
        persisted = db.execute("SELECT name FROM shopping_lists WHERE id = ?", (personal_id,)).fetchone()
        assert persisted["name"] == "Weekly groceries", persisted
    try:
        asyncio.run(delete_shopping_list(personal_id, shared_id))
    except HTTPException as error:
        assert error.status_code in {403, 404}, error
    else:
        raise AssertionError("Direct recipient deleted shopping list")
    with get_db() as db:
        assert db.execute("SELECT 1 FROM shopping_lists WHERE id = ?", (personal_id,)).fetchone()
    assert list_shopping_lists(outsider_id)["shopping_lists"] == []
    asyncio.run(revoke_shopping_list_member(personal_id, shared_id, owner_id))
    assert list_shopping_list_members(personal_id, owner_id)["members"] == []
    assert list_shopping_lists(shared_id)["shopping_lists"] == []
    asyncio.run(share_shopping_list(personal_id, ShoppingListShareCreate(identifier="shared"), owner_id))

    leave_list = asyncio.run(create_shopping_list(ShoppingListCreate(name="Leave me"), owner_id))
    asyncio.run(share_shopping_list(leave_list["id"], ShoppingListShareCreate(identifier="shared"), owner_id))
    left = asyncio.run(leave_shopping_list(leave_list["id"], shared_id))
    assert left == {"id": leave_list["id"], "left": True}, left
    assert [row["id"] for row in list_shopping_lists(shared_id)["shopping_lists"]] == [personal_id]
    assert list_shopping_list_members(leave_list["id"], owner_id)["members"] == []
    try:
        asyncio.run(leave_shopping_list(leave_list["id"], owner_id))
    except HTTPException as error:
        assert error.status_code == 400, error
    else:
        raise AssertionError("Personal shopping-list owner left their own list")

    transfer_list = asyncio.run(create_shopping_list(ShoppingListCreate(name="Transfer me"), owner_id))
    asyncio.run(share_shopping_list(transfer_list["id"], ShoppingListShareCreate(identifier="shared"), owner_id))
    try:
        asyncio.run(
            transfer_shopping_list_to_household(
                transfer_list["id"], ShoppingListHouseholdTransfer(household_id=household_id), shared_id
            )
        )
    except HTTPException as error:
        assert error.status_code in {403, 404}, error
    else:
        raise AssertionError("Direct recipient transferred a personal shopping list")
    transfer_syncs = []
    original_sync = shopping_router.broadcast_sync_to_users

    async def capture_transfer_sync(user_ids):
        transfer_syncs.append(set(user_ids))

    shopping_router.broadcast_sync_to_users = capture_transfer_sync
    try:
        transferred = asyncio.run(
            transfer_shopping_list_to_household(
                transfer_list["id"],
                ShoppingListHouseholdTransfer(household_id=household_id),
                owner_id,
            )
        )
    finally:
        shopping_router.broadcast_sync_to_users = original_sync
    assert transferred["ownership_type"] == "household", transferred
    assert transferred["owner_household_id"] == household_id, transferred
    assert transferred["can_manage"] is True, transferred
    household_member_view = get_shopping_list(transfer_list["id"], member_id)
    assert household_member_view["can_edit"] is True, household_member_view
    assert household_member_view["can_manage"] is False, household_member_view
    try:
        asyncio.run(update_shopping_list(transfer_list["id"], ShoppingListUpdate(name="Member rename"), member_id))
    except HTTPException as error:
        assert error.status_code in {403, 404}, error
    else:
        raise AssertionError("Household member changed shopping-list metadata")
    with get_db() as db:
        persisted = db.execute("SELECT name FROM shopping_lists WHERE id = ?", (transfer_list["id"],)).fetchone()
        assert persisted["name"] == "Transfer me", persisted
    try:
        asyncio.run(delete_shopping_list(transfer_list["id"], member_id))
    except HTTPException as error:
        assert error.status_code in {403, 404}, error
    else:
        raise AssertionError("Household member deleted shopping list")
    with get_db() as db:
        assert db.execute("SELECT 1 FROM shopping_lists WHERE id = ?", (transfer_list["id"],)).fetchone()
    assert [row["id"] for row in list_shopping_lists(shared_id)["shopping_lists"]] == [personal_id]
    assert transfer_syncs == [{owner_id, member_id, shared_id}], transfer_syncs
    with get_db() as db:
        access = db.execute(
            "SELECT id FROM entity_access WHERE entity_type = 'shopping_list' AND entity_id = ?",
            (transfer_list["id"],),
        ).fetchone()
        assert access
        assert not db.execute(
            "SELECT 1 FROM entity_access_grants WHERE entity_access_id = ?",
            (access["id"],),
        ).fetchone()

    list_broadcasts = []
    original_broadcast_change = shopping_router.broadcast_change

    async def capture_list_broadcast(event_type, payload, user_id, **kwargs):
        list_broadcasts.append((event_type, payload, user_id, kwargs))

    shopping_router.broadcast_change = capture_list_broadcast
    try:
        asyncio.run(update_shopping_list(personal_id, ShoppingListUpdate(name="Shared weekly"), owner_id))
    finally:
        shopping_router.broadcast_change = original_broadcast_change
    shared_list_broadcast = next(
        payload for event_type, payload, recipient_id, _ in list_broadcasts
        if event_type == "shopping_list_update" and recipient_id == shared_id
    )
    assert shared_list_broadcast["can_manage"] is False, shared_list_broadcast
    assert shared_list_broadcast["is_owner"] is False, shared_list_broadcast

    owner_store = asyncio.run(create_shopping_store(ShoppingStoreCreate(name="Owner store"), owner_id))
    other_owner_store = asyncio.run(create_shopping_store(ShoppingStoreCreate(name="Other owner store"), owner_id))
    item_broadcasts = []
    original_broadcast_change = shopping_router.broadcast_change

    async def capture_item_broadcast(event_type, payload, user_id, **kwargs):
        item_broadcasts.append((event_type, payload, user_id, kwargs))

    shopping_router.broadcast_change = capture_item_broadcast
    try:
        shared_item = asyncio.run(
            create_shopping_item(
                personal_id,
                ShoppingItemCreate(name="Shared item", store_ids=[owner_store["id"]]),
                owner_id,
            )
        )
    finally:
        shopping_router.broadcast_change = original_broadcast_change
    shared_broadcast = next(
        payload for event_type, payload, recipient_id, _ in item_broadcasts
        if event_type == "shopping_item_create" and recipient_id == shared_id
    )
    assert shared_broadcast["store_ids"] == [owner_store["id"]], shared_broadcast
    assert shared_broadcast["stores"] == [], shared_broadcast
    assert "Owner store" not in repr(shared_broadcast), shared_broadcast
    shared_item_view = next(item for item in get_shopping_list(personal_id, shared_id)["items"] if item["id"] == shared_item["id"])
    assert shared_item_view["store_ids"] == [owner_store["id"]], shared_item_view
    assert shared_item_view["stores"] == [], shared_item_view
    assert "Owner store" not in repr(shared_item_view), shared_item_view
    shared_list_view = get_shopping_list(personal_id, shared_id)
    assert shared_list_view["can_edit"] is True, shared_list_view
    assert shared_list_view["can_manage"] is False, shared_list_view
    personal_section = asyncio.run(
        create_shopping_section(personal_id, ShoppingSectionCreate(name="Personal section"), owner_id)
    )
    shared_item_edit = asyncio.run(
        update_shopping_item(
            shared_item["id"],
            ShoppingItemUpdate(
                name="Shared item edited",
                quantity_value=3,
                quantity_unit="pcs",
                section_id=personal_section["id"],
            ),
            shared_id,
        )
    )
    assert shared_item_edit["name"] == "Shared item edited", shared_item_edit
    assert shared_item_edit["quantity_value"] == 3, shared_item_edit
    assert shared_item_edit["quantity_unit"] == "pcs", shared_item_edit
    assert shared_item_edit["section_id"] == personal_section["id"], shared_item_edit
    assert shared_item_edit["store_ids"] == [owner_store["id"]], shared_item_edit
    retained_hidden_store = asyncio.run(
        update_shopping_item(
            shared_item["id"],
            ShoppingItemUpdate(store_ids=[owner_store["id"]]),
            shared_id,
        )
    )
    assert retained_hidden_store["store_ids"] == [owner_store["id"]], retained_hidden_store
    try:
        asyncio.run(
            update_shopping_item(
                shared_item["id"],
                ShoppingItemUpdate(store_ids=[owner_store["id"], other_owner_store["id"]]),
                shared_id,
            )
        )
    except HTTPException as error:
        assert error.status_code == 400, error
    else:
        raise AssertionError("Direct recipient added a new inaccessible store")

    household = asyncio.run(
        create_shopping_list(
            ShoppingListCreate(
                name="Household shopping",
                household_id=household_id,
                client_mutation_id="household-list-1",
            ),
            member_id,
        )
    )
    household_id_value = household["id"]
    assert household["ownership_type"] == "household", household
    assert household["owner_household_id"] == household_id, household
    assert household["is_owner"] is False, household
    assert household["can_edit"] is True, household
    assert household["can_manage"] is False, household
    try:
        asyncio.run(leave_shopping_list(household_id_value, member_id))
    except HTTPException as error:
        assert error.status_code == 409, error
    else:
        raise AssertionError("Household shopping list was left through direct-recipient semantics")

    member_lists = list_shopping_lists(member_id)["shopping_lists"]
    assert {row["id"] for row in member_lists} == {transfer_list["id"], household_id_value}, member_lists
    owner_lists = list_shopping_lists(owner_id)["shopping_lists"]
    assert {personal_id, transfer_list["id"], household_id_value}.issubset({row["id"] for row in owner_lists}), owner_lists
    owner_household_list = next(row for row in owner_lists if row["id"] == household_id_value)
    assert owner_household_list["can_edit"] is True, owner_household_list
    assert owner_household_list["can_manage"] is True, owner_household_list

    try:
        asyncio.run(
            create_shopping_section(
                household_id_value,
                ShoppingSectionCreate(name="Forbidden member section"),
                member_id,
            )
        )
    except HTTPException as error:
        assert error.status_code == 404, error
    else:
        raise AssertionError("Household member managed list sections")

    produce = asyncio.run(
        create_shopping_section(
            household_id_value,
            ShoppingSectionCreate(name="Produce", sort_order=10, client_mutation_id="section-1"),
            owner_id,
        )
    )
    section_id = produce["id"]
    try:
        asyncio.run(update_shopping_section(section_id, ShoppingSectionUpdate(name="Forbidden rename"), member_id))
    except HTTPException as error:
        assert error.status_code == 404, error
    else:
        raise AssertionError("Household member updated list sections")
    renamed_section = asyncio.run(
        update_shopping_section(section_id, ShoppingSectionUpdate(name="Fresh produce"), owner_id)
    )
    assert renamed_section["name"] == "Fresh produce", renamed_section

    rewe = asyncio.run(
        create_shopping_store(
            ShoppingStoreCreate(name="REWE", household_id=household_id, client_mutation_id="store-rewe"),
            member_id,
        )
    )
    lidl = asyncio.run(
        create_shopping_store(
            ShoppingStoreCreate(name="Lidl", client_mutation_id="store-lidl"),
            member_id,
        )
    )
    assert {store["id"] for store in list_shopping_stores(member_id)["shopping_stores"]} == {rewe["id"], lidl["id"]}
    assert list_shopping_stores(outsider_id)["shopping_stores"] == []
    renamed_lidl = asyncio.run(
        update_shopping_store(
            lidl["id"],
            ShoppingStoreUpdate(name="Lidl City", sort_order=20),
            member_id,
        )
    )
    assert renamed_lidl["name"] == "Lidl City", renamed_lidl
    assert renamed_lidl["sort_order"] == 20, renamed_lidl

    milk = asyncio.run(
        create_shopping_item(
            household_id_value,
            ShoppingItemCreate(
                name="Milk",
                section_id=section_id,
                quantity_value=2,
                quantity_unit="l",
                store_ids=[rewe["id"], lidl["id"]],
                client_mutation_id="item-1",
            ),
            member_id,
        )
    )
    milk_retry = asyncio.run(
        create_shopping_item(
            household_id_value,
            ShoppingItemCreate(
                name="Ignored retry body",
                section_id=999999,
                store_ids=[999999],
                client_mutation_id="item-1",
            ),
            member_id,
        )
    )
    assert milk_retry["id"] == milk["id"], milk_retry

    unrestricted = asyncio.run(
        create_shopping_item(
            household_id_value,
            ShoppingItemCreate(
                name="Bread",
                quantity_value=1,
                quantity_unit="loaf",
                store_ids=[],
                client_mutation_id="item-2",
            ),
            owner_id,
        )
    )
    assert milk["store_ids"] == [rewe["id"], lidl["id"]], milk
    assert [(store["id"], store["name"]) for store in milk["stores"]] == [(rewe["id"], "REWE"), (lidl["id"], "Lidl City")], milk
    assert unrestricted["store_ids"] == [], unrestricted
    assert unrestricted["stores"] == [], unrestricted

    owner_item_view = next(
        item for item in get_shopping_list(household_id_value, owner_id)["items"]
        if item["id"] == milk["id"]
    )
    assert owner_item_view["store_ids"] == [rewe["id"], lidl["id"]], owner_item_view
    assert [store["id"] for store in owner_item_view["stores"]] == [rewe["id"]], owner_item_view
    assert "Lidl City" not in repr(owner_item_view), owner_item_view

    completed = asyncio.run(
        update_shopping_item(
            milk["id"],
            ShoppingItemUpdate(completed=True),
            member_id,
        )
    )
    assert completed["completed"] is True, completed
    assert completed["completed_by_user_id"] == member_id, completed
    assert completed["completed_at"], completed
    try:
        asyncio.run(update_shopping_item(milk["id"], ShoppingItemUpdate(sort_order=99), member_id))
    except HTTPException as error:
        assert error.status_code == 404, error
    else:
        raise AssertionError("Household member reordered a shopping item")

    owner_preferences = asyncio.run(
        update_shopping_preferences(
            household_id_value,
            ShoppingPreferencesUpdate(
                selected_store_id=rewe["id"],
                hide_empty_sections=True,
            ),
            owner_id,
        )
    )
    assert owner_preferences == {
        "shopping_list_id": household_id_value,
        "user_id": owner_id,
        "selected_store_id": rewe["id"],
        "hide_empty_sections": True,
    }, owner_preferences

    member_view = get_shopping_list(household_id_value, member_id)
    assert member_view["preferences"]["selected_store_id"] is None, member_view
    assert member_view["preferences"]["hide_empty_sections"] is False, member_view
    assert "hide_completed" not in member_view["preferences"], member_view
    assert [section["id"] for section in member_view["sections"]] == [section_id], member_view
    assert {item["id"] for item in member_view["items"]} == {milk["id"], unrestricted["id"]}, member_view

    with get_db() as db:
        owner_sync = get_sync_payload(db, owner_id)
    owner_sync_list = next(row for row in owner_sync["shopping_lists"] if row["id"] == household_id_value)
    assert owner_sync_list["preferences"]["selected_store_id"] == rewe["id"], owner_sync_list
    assert {item["id"] for item in owner_sync_list["items"]} == {milk["id"], unrestricted["id"]}, owner_sync_list
    assert {store["id"] for store in owner_sync["shopping_stores"]} == {
        owner_store["id"], other_owner_store["id"], rewe["id"]
    }, owner_sync
    assert "Lidl City" not in repr(owner_sync_list), owner_sync_list

    with get_db() as db:
        member_sync = get_sync_payload(db, member_id)
    member_sync_list = next(row for row in member_sync["shopping_lists"] if row["id"] == household_id_value)
    assert member_sync_list["preferences"]["selected_store_id"] is None, member_sync_list
    assert {store["id"] for store in member_sync["shopping_stores"]} == {rewe["id"], lidl["id"]}, member_sync

    asyncio.run(delete_shopping_store(lidl["id"], member_id))
    inactive_lidl = next(store for store in list_shopping_stores(member_id)["shopping_stores"] if store["id"] == lidl["id"])
    assert inactive_lidl["active"] is False, inactive_lidl
    after_store_delete = get_shopping_list(household_id_value, member_id)
    milk_after_store_delete = next(item for item in after_store_delete["items"] if item["id"] == milk["id"])
    assert [store["id"] for store in milk_after_store_delete["stores"]] == [rewe["id"], lidl["id"]], milk_after_store_delete

    try:
        asyncio.run(delete_shopping_section(section_id, member_id))
    except HTTPException as error:
        assert error.status_code == 404, error
    else:
        raise AssertionError("Household member deleted a shopping section")
    asyncio.run(delete_shopping_section(section_id, owner_id))
    after_section_delete = get_shopping_list(household_id_value, owner_id)
    moved_milk = next(item for item in after_section_delete["items"] if item["id"] == milk["id"])
    assert moved_milk["section_id"] is None, moved_milk

    try:
        asyncio.run(delete_completed_shopping_items(household_id_value, member_id))
    except HTTPException as error:
        assert error.status_code == 404, error
    else:
        raise AssertionError("Household member bulk-deleted completed items")
    deleted_completed = asyncio.run(delete_completed_shopping_items(household_id_value, owner_id))
    assert deleted_completed["deleted_ids"] == [milk["id"]], deleted_completed
    after_completed_delete = get_shopping_list(household_id_value, member_id)
    assert [item["id"] for item in after_completed_delete["items"]] == [unrestricted["id"]], after_completed_delete
    asyncio.run(delete_shopping_item(unrestricted["id"], owner_id))
    assert get_shopping_list(household_id_value, owner_id)["items"] == []

    with get_db() as db:
        lifecycle_user_id = db.execute("INSERT INTO users (username) VALUES ('lifecycle-user')").lastrowid
        db.commit()
    asyncio.run(
        share_shopping_list(
            personal_id,
            ShoppingListShareCreate(identifier="lifecycle-user"),
            owner_id,
        )
    )
    lifecycle_store = asyncio.run(
        create_shopping_store(ShoppingStoreCreate(name="Lifecycle store"), lifecycle_user_id)
    )
    lifecycle_item = asyncio.run(
        create_shopping_item(
            personal_id,
            ShoppingItemCreate(name="Survives user deletion", store_ids=[lifecycle_store["id"]]),
            lifecycle_user_id,
        )
    )
    asyncio.run(delete_user(lifecycle_user_id, True))
    lifecycle_item_after_user_delete = next(
        item for item in get_shopping_list(personal_id, owner_id)["items"]
        if item["id"] == lifecycle_item["id"]
    )
    assert lifecycle_item_after_user_delete["store_ids"] == [], lifecycle_item_after_user_delete

    dissolution_item = asyncio.run(
        create_shopping_item(
            household_id_value,
            ShoppingItemCreate(name="Survives household dissolution", store_ids=[rewe["id"]]),
            owner_id,
        )
    )
    asyncio.run(dissolve_household_endpoint(household_id, owner_id))
    dissolution_item_after = next(
        item for item in get_shopping_list(household_id_value, owner_id)["items"]
        if item["id"] == dissolution_item["id"]
    )
    assert dissolution_item_after["store_ids"] == [], dissolution_item_after
    assert dissolution_item_after["stores"] == [], dissolution_item_after

    with get_db() as db:
        columns = {row["name"] for row in db.execute("PRAGMA table_info(shopping_lists)").fetchall()}
        assert "archived_at" not in columns, columns
        preference_columns = {row["name"] for row in db.execute("PRAGMA table_info(shopping_list_preferences)").fetchall()}
        assert "hide_completed" not in preference_columns, preference_columns
        assert not db.execute(
            "SELECT 1 FROM entity_access_grants ea_g "
            "JOIN entity_access ea ON ea.id = ea_g.entity_access_id "
            "WHERE ea.entity_type = 'shopping_list' AND ea.entity_id = ?",
            (household_id_value,),
        ).fetchone()

print("✅ Shopping lists support stable stores, structured quantities, preferences, and household access")
