"""Attachment policy and usage helpers."""

import json
import fcntl
import errno
import mimetypes
import os
import secrets
import shutil
import sqlite3
import stat
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from paths import ATTACHMENT_DIR

DEFAULT_ATTACHMENTS_ENABLED = True
DEFAULT_ALLOWED_ATTACHMENT_TYPES = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".pdf",
]
DEFAULT_ATTACHMENT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024
MAX_ATTACHMENT_QUOTA_BYTES = 1024 * 1024 * 1024 * 1024  # 1 TiB guardrail
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAGIC_REQUIRED_ATTACHMENT_TYPES = {
    "application/pdf",
    "application/zip",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
}
MAGIC_REQUIRED_ATTACHMENT_EXTENSIONS = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".zip": "application/zip",
}
BLOCKED_ATTACHMENT_CONTENT_TYPES = {
    "text/html",
    "image/svg+xml",
    "application/javascript",
    "text/javascript",
}
BLOCKED_ATTACHMENT_SIGNATURE_PREFIXES = (
    b"<!doctype html",
    b"<html",
    b"<script",
    b"<svg",
    b"<?xml",
)

ATTACHMENT_CONFIG_KEYS = (
    "attachments_enabled",
    "attachments_allowed_types",
    "attachments_default_quota_bytes",
)


def _attachment_storage_path(todo_id: int, stored_filename: str) -> Path:
    filename = str(stored_filename)
    if not filename or filename in {".", ".."} or Path(filename).name != filename:
        raise RuntimeError("Invalid stored attachment filename")
    return ATTACHMENT_DIR / str(int(todo_id)) / filename


class AttachmentUploadTempLease:
    """Cross-process lease protecting an upload temp file from reconciliation."""

    def __init__(self, tmp_path: Path):
        self.tmp_path = Path(tmp_path)
        self.lock_path = self.tmp_path.with_name(f"{self.tmp_path.name}.lock")
        self.handle = None

    def __enter__(self):
        while True:
            self.tmp_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                handle = self.lock_path.open("a+b")
            except FileNotFoundError:
                continue
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            if _locked_descriptor_matches_path(handle, self.lock_path):
                self.handle = handle
                return self
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def __exit__(self, exc_type, exc, traceback):
        if self.handle is not None:
            if _locked_descriptor_matches_path(self.handle, self.lock_path):
                self.lock_path.unlink(missing_ok=True)
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            self.handle.close()
            self.handle = None
        _remove_directory_if_empty(self.tmp_path.parent)
        return False


def _locked_descriptor_matches_path(handle, path: Path) -> bool:
    descriptor_stat = os.fstat(handle.fileno())
    try:
        path_stat = path.stat()
    except FileNotFoundError:
        return False
    return (descriptor_stat.st_dev, descriptor_stat.st_ino) == (path_stat.st_dev, path_stat.st_ino)


def _remove_directory_if_empty(path: Path):
    try:
        path.rmdir()
    except FileNotFoundError:
        return
    except OSError as error:
        if error.errno in {errno.ENOTEMPTY, errno.EEXIST}:
            return
        raise


def _cleanup_upload_temp_files(upload_temp_root: Path):
    try:
        entries = list(upload_temp_root.iterdir())
    except FileNotFoundError:
        return
    existing_entries = []
    for entry in entries:
        try:
            entry_mode = entry.lstat().st_mode
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(entry_mode):
            raise RuntimeError("Unexpected attachment upload temp entry")
        existing_entries.append(entry)
    temp_paths = [entry for entry in existing_entries if not entry.name.endswith(".lock")]
    for tmp_path in temp_paths:
        lock_path = tmp_path.with_name(f"{tmp_path.name}.lock")
        try:
            lock_handle = lock_path.open("a+b")
        except FileNotFoundError:
            continue
        with lock_handle:
            try:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            if not _locked_descriptor_matches_path(lock_handle, lock_path):
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
                continue
            tmp_path.unlink(missing_ok=True)
            lock_path.unlink(missing_ok=True)
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
    for lock_path in list(upload_temp_root.glob("*.lock")):
        try:
            lock_handle = lock_path.open("a+b")
        except FileNotFoundError:
            continue
        with lock_handle:
            try:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            if not _locked_descriptor_matches_path(lock_handle, lock_path):
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
                continue
            lock_path.unlink(missing_ok=True)
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
    _remove_directory_if_empty(upload_temp_root)


def cleanup_stale_attachment_quarantine(db):
    """Reconcile crash leftovers while excluding live writer transactions."""
    if db.in_transaction:
        raise RuntimeError("Attachment reconciliation requires its own transaction")
    db.execute("BEGIN IMMEDIATE")
    try:
        _cleanup_stale_attachment_quarantine_locked(db)
        db.commit()
    except Exception:
        db.rollback()
        raise


def _cleanup_stale_attachment_quarantine_locked(db):
    """Reconcile crash leftovers against committed todo state."""
    upload_temp_root = ATTACHMENT_DIR / ".upload-temp"
    _cleanup_upload_temp_files(upload_temp_root)
    quarantine_root = ATTACHMENT_DIR / ".cleanup-quarantine"
    if not quarantine_root.exists():
        return
    for batch_dir in quarantine_root.iterdir():
        if not batch_dir.is_dir():
            raise RuntimeError("Unexpected attachment quarantine entry")
        manifest_path = batch_dir / ".manifest.json"
        if manifest_path.exists():
            records = json.loads(manifest_path.read_text(encoding="utf-8"))
            if not isinstance(records, list):
                raise RuntimeError("Invalid attachment quarantine manifest")
            seen_attachment_ids = set()
            seen_targets = set()
            for record in records:
                if not isinstance(record, dict) or set(record) != {"attachment_id", "todo_id", "stored_filename"}:
                    raise RuntimeError("Invalid attachment quarantine file record")
                attachment_id = int(record["attachment_id"])
                todo_id = int(record["todo_id"])
                stored_filename = str(record["stored_filename"])
                target_identity = (todo_id, stored_filename)
                if attachment_id in seen_attachment_ids or target_identity in seen_targets:
                    raise RuntimeError("Duplicate attachment quarantine record")
                seen_attachment_ids.add(attachment_id)
                seen_targets.add(target_identity)
                staged_path = batch_dir / f"attachment-{attachment_id}"
                attachment_row = db.execute(
                    "SELECT todo_id, stored_filename FROM todo_attachments WHERE id = ?",
                    (attachment_id,),
                ).fetchone()
                live_path = _attachment_storage_path(todo_id, stored_filename)
                if not staged_path.exists():
                    if attachment_row is not None and not live_path.exists():
                        raise RuntimeError("Attachment quarantine file is missing")
                    if attachment_row is None and live_path.exists():
                        raise RuntimeError("Untracked live attachment conflicts with quarantine state")
                    continue
                if attachment_row is None:
                    staged_path.unlink()
                    continue
                if int(attachment_row["todo_id"]) != todo_id or attachment_row["stored_filename"] != stored_filename:
                    raise RuntimeError("Attachment quarantine metadata conflicts with the database")
                if live_path.exists():
                    raise RuntimeError("Attachment quarantine conflicts with a live attachment file")
                live_path.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staged_path, live_path)
            manifest_path.unlink()
            batch_dir.rmdir()
            continue
        for entry in batch_dir.iterdir():
            if not entry.is_dir():
                raise RuntimeError("Unexpected attachment quarantine todo entry")
            try:
                todo_id = int(entry.name)
            except ValueError as error:
                raise RuntimeError("Invalid attachment quarantine todo id") from error
            todo_exists = db.execute("SELECT 1 FROM todos WHERE id = ?", (todo_id,)).fetchone() is not None
            live_path = ATTACHMENT_DIR / str(todo_id)
            if todo_exists:
                if live_path.exists():
                    raise RuntimeError("Attachment quarantine conflicts with a live todo directory")
                os.replace(entry, live_path)
            elif entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
        batch_dir.rmdir()
    quarantine_root.rmdir()


class AttachmentUploadStaging:
    """Durably stage one upload until its metadata transaction commits."""

    def __init__(self, tmp_path: Path, attachment):
        self.tmp_path = Path(tmp_path)
        self.record = {
            "attachment_id": int(attachment["id"]),
            "todo_id": int(attachment["todo_id"]),
            "stored_filename": str(attachment["stored_filename"]),
        }
        self.quarantine_root = ATTACHMENT_DIR / ".cleanup-quarantine"
        self.batch_dir = self.quarantine_root / secrets.token_hex(16)
        self.manifest_path = self.batch_dir / ".manifest.json"
        self.staged_path = self.batch_dir / f"attachment-{self.record['attachment_id']}"
        self.preserve_for_recovery = False

    def stage(self):
        if not self.tmp_path.is_file():
            raise RuntimeError("Attachment upload temporary file is missing")
        target_path = _attachment_storage_path(self.record["todo_id"], self.record["stored_filename"])
        if target_path.exists():
            raise RuntimeError("Attachment upload target already exists")
        try:
            self.batch_dir.mkdir(parents=True, exist_ok=False)
            self.manifest_path.write_text(json.dumps([self.record]), encoding="utf-8")
            os.replace(self.tmp_path, self.staged_path)
        except Exception:
            self.rollback()
            raise

    def rollback(self):
        if self.staged_path.exists():
            self.staged_path.unlink()
        if self.manifest_path.exists():
            self.manifest_path.unlink()
        if self.batch_dir.exists():
            self.batch_dir.rmdir()
        if self.quarantine_root.exists() and not any(self.quarantine_root.iterdir()):
            self.quarantine_root.rmdir()

    def publish(self):
        target_path = _attachment_storage_path(self.record["todo_id"], self.record["stored_filename"])
        if target_path.exists():
            raise RuntimeError("Attachment upload target already exists")
        target_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(self.staged_path, target_path)
        self.manifest_path.unlink()
        self.batch_dir.rmdir()
        if self.quarantine_root.exists() and not any(self.quarantine_root.iterdir()):
            self.quarantine_root.rmdir()


class AttachmentFileCleanupBatch:
    """Stage individual attachment files reversibly until DB commit."""

    def __init__(self, attachments):
        self.records = [
            {
                "attachment_id": int(attachment["id"]),
                "todo_id": int(attachment["todo_id"]),
                "stored_filename": str(attachment["stored_filename"]),
            }
            for attachment in attachments
        ]
        self.quarantine_root = ATTACHMENT_DIR / ".cleanup-quarantine"
        self.batch_dir = self.quarantine_root / secrets.token_hex(16)
        self.manifest_path = self.batch_dir / ".manifest.json"
        self.staged: list[tuple[Path, Path]] = []
        self.preserve_for_recovery = False

    def __enter__(self):
        try:
            if not self.records:
                return self
            self.batch_dir.mkdir(parents=True, exist_ok=True)
            self.manifest_path.write_text(json.dumps(self.records), encoding="utf-8")
            for record in self.records:
                source = _attachment_storage_path(record["todo_id"], record["stored_filename"])
                if not source.is_file():
                    raise RuntimeError("Expected attachment file is missing")
                destination = self.batch_dir / f"attachment-{record['attachment_id']}"
                os.replace(source, destination)
                self.staged.append((source, destination))
        except Exception:
            self.restore()
            raise
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is not None:
            if not self.preserve_for_recovery:
                self.restore()
            return False
        self.finalize()
        return False

    def restore(self):
        restore_error = None
        for source, destination in reversed(self.staged):
            if not destination.exists():
                continue
            try:
                if source.exists():
                    raise RuntimeError("Cannot restore attachment over an existing file")
                source.parent.mkdir(parents=True, exist_ok=True)
                os.replace(destination, source)
            except Exception as error:
                restore_error = restore_error or error
        if restore_error is None:
            if self.manifest_path.exists():
                self.manifest_path.unlink()
            if self.batch_dir.exists():
                self.batch_dir.rmdir()
            if self.quarantine_root.exists() and not any(self.quarantine_root.iterdir()):
                self.quarantine_root.rmdir()
        if restore_error is not None:
            raise restore_error

    def finalize(self):
        for _, destination in self.staged:
            if destination.exists():
                destination.unlink()
        if self.manifest_path.exists():
            self.manifest_path.unlink()
        if self.batch_dir.exists():
            self.batch_dir.rmdir()
        if self.quarantine_root.exists() and not any(self.quarantine_root.iterdir()):
            self.quarantine_root.rmdir()


class AttachmentCleanupBatch:
    """Stage attachment directories reversibly until the DB transaction commits."""

    def __init__(self, todo_ids, *, required_todo_ids=()):
        self.todo_ids = list(dict.fromkeys(int(todo_id) for todo_id in todo_ids))
        self.required_todo_ids = {int(todo_id) for todo_id in required_todo_ids}
        self.quarantine_root = ATTACHMENT_DIR / ".cleanup-quarantine"
        self.batch_dir = self.quarantine_root / secrets.token_hex(16)
        self.staged: list[tuple[Path, Path]] = []
        self.preserve_for_recovery = False

    def __enter__(self):
        try:
            for todo_id in self.todo_ids:
                source = ATTACHMENT_DIR / str(todo_id)
                if not source.exists():
                    if todo_id in self.required_todo_ids:
                        raise RuntimeError("Expected todo attachment directory is missing")
                    continue
                self.batch_dir.mkdir(parents=True, exist_ok=True)
                destination = self.batch_dir / str(todo_id)
                os.replace(source, destination)
                self.staged.append((source, destination))
        except Exception:
            self.restore()
            raise
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is not None:
            if not self.preserve_for_recovery:
                self.restore()
            return False
        self.finalize()
        return False

    def restore(self):
        restore_error = None
        for source, destination in reversed(self.staged):
            if not destination.exists():
                continue
            try:
                source.parent.mkdir(parents=True, exist_ok=True)
                os.replace(destination, source)
            except Exception as error:
                restore_error = restore_error or error
        self._remove_empty_quarantine_dirs()
        if restore_error:
            raise restore_error

    def finalize(self):
        if self.batch_dir.exists():
            shutil.rmtree(self.batch_dir)
        self._remove_empty_quarantine_dirs()

    def _remove_empty_quarantine_dirs(self):
        for directory in (self.batch_dir, self.quarantine_root):
            try:
                directory.rmdir()
            except FileNotFoundError:
                pass
            except OSError:
                pass


def commit_with_attachment_recovery(db, staging):
    """Preserve staged files when the durable outcome of commit is ambiguous."""
    try:
        db.commit()
    except Exception:
        staging.preserve_for_recovery = True
        try:
            db.rollback()
        except Exception:
            pass
        raise


def _parse_bool(value: Any, default: bool = DEFAULT_ATTACHMENTS_ENABLED) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def normalize_allowed_attachment_types(value: Any) -> list[str]:
    if value is None:
        return list(DEFAULT_ALLOWED_ATTACHMENT_TYPES)
    if isinstance(value, str):
        raw_items = value.replace(",", "\n").splitlines()
    elif isinstance(value, list):
        raw_items = [str(item) for item in value]
    else:
        raise HTTPException(400, "Allowed attachment types must be a list or line-based string")
    items: list[str] = []
    seen = set()
    for raw in raw_items:
        item = str(raw or "").strip().lower()
        if not item:
            continue
        if not item.startswith(".") and "/" not in item and not item.endswith("/*"):
            item = f".{item}"
        if item.startswith("."):
            if len(item) < 2 or any(ch in item for ch in "/\\\0\r\n ,"):
                raise HTTPException(400, f"Invalid attachment extension: {item}")
        elif item.endswith("/*"):
            prefix = item[:-2]
            if not prefix or "/" in prefix or any(ch in prefix for ch in "\\\0\r\n "):
                raise HTTPException(400, f"Invalid attachment type wildcard: {item}")
        elif "/" in item:
            major, minor = item.split("/", 1)
            if not major or not minor or any(ch in item for ch in "\\\0\r\n "):
                raise HTTPException(400, f"Invalid attachment MIME type: {item}")
        else:
            raise HTTPException(400, f"Invalid attachment type entry: {item}")
        if item not in seen:
            items.append(item)
            seen.add(item)
    if not items:
        raise HTTPException(400, "At least one allowed attachment type is required")
    return items


def normalize_quota_bytes(value: Any, *, allow_null: bool = False) -> int | None:
    if value is None or value == "":
        if allow_null:
            return None
        return DEFAULT_ATTACHMENT_QUOTA_BYTES
    try:
        quota = int(value)
    except (TypeError, ValueError):
        raise HTTPException(400, "Attachment quota must be a whole number of bytes")
    if quota < 0:
        raise HTTPException(400, "Attachment quota must not be negative")
    if quota > MAX_ATTACHMENT_QUOTA_BYTES:
        raise HTTPException(400, "Attachment quota is too large")
    return quota


def get_attachment_config(db) -> dict[str, Any]:
    values = {
        "enabled": DEFAULT_ATTACHMENTS_ENABLED,
        "allowed_types": list(DEFAULT_ALLOWED_ATTACHMENT_TYPES),
        "default_quota_bytes": DEFAULT_ATTACHMENT_QUOTA_BYTES,
    }
    try:
        rows = db.execute(
            "SELECT key, value FROM app_config WHERE key IN ('attachments_enabled', 'attachments_allowed_types', 'attachments_default_quota_bytes')"
        ).fetchall()
    except Exception:
        return values
    for row in rows:
        key = row["key"]
        raw = row["value"]
        try:
            if key == "attachments_enabled":
                values["enabled"] = _parse_bool(raw)
            elif key == "attachments_allowed_types":
                values["allowed_types"] = normalize_allowed_attachment_types(json.loads(raw or "[]"))
            elif key == "attachments_default_quota_bytes":
                values["default_quota_bytes"] = normalize_quota_bytes(raw)
        except Exception:
            continue
    return values


def update_attachment_config(db, data: dict[str, Any]) -> dict[str, Any]:
    current = get_attachment_config(db)
    enabled = _parse_bool(data.get("enabled", current["enabled"]))
    allowed_types = normalize_allowed_attachment_types(data.get("allowed_types", current["allowed_types"]))
    default_quota = normalize_quota_bytes(data.get("default_quota_bytes", current["default_quota_bytes"]))
    rows = {
        "attachments_enabled": "1" if enabled else "0",
        "attachments_allowed_types": json.dumps(allowed_types, separators=(",", ":")),
        "attachments_default_quota_bytes": str(default_quota),
    }
    for key, value in rows.items():
        db.execute(
            """INSERT INTO app_config (key, value, updated_at)
               VALUES (?, ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')""",
            (key, value),
        )
    return {"enabled": enabled, "allowed_types": allowed_types, "default_quota_bytes": default_quota}


def attachment_usage_bytes(db, user_id: int) -> int:
    try:
        row = db.execute("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM todo_attachments WHERE user_id = ?", (user_id,)).fetchone()
    except Exception:
        return 0
    return int(row["total"] if row else 0)


def user_attachment_quota_bytes(db, user_id: int) -> int:
    try:
        row = db.execute("SELECT attachment_quota_bytes FROM users WHERE id = ?", (user_id,)).fetchone()
    except sqlite3.OperationalError:
        row = None
    if row and row["attachment_quota_bytes"] is not None:
        return int(row["attachment_quota_bytes"])
    return int(get_attachment_config(db)["default_quota_bytes"])


def attachment_usage_payload(db, user_id: int) -> dict[str, int | bool | list[str]]:
    config = get_attachment_config(db)
    used = attachment_usage_bytes(db, user_id)
    quota = user_attachment_quota_bytes(db, user_id)
    return {
        "enabled": bool(config["enabled"]),
        "used_bytes": used,
        "quota_bytes": quota,
        "remaining_bytes": max(quota - used, 0),
        "allowed_types": list(config["allowed_types"]),
        "max_upload_bytes": MAX_ATTACHMENT_BYTES,
    }


def sniff_attachment_content_type(sample: bytes) -> str | None:
    data = bytes(sample or b"")[:512]
    stripped = data.lstrip().lower()
    if any(stripped.startswith(prefix) for prefix in BLOCKED_ATTACHMENT_SIGNATURE_PREFIXES):
        return "text/html"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"%PDF"):
        return "application/pdf"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"PK\x03\x04") or data.startswith(b"PK\x05\x06") or data.startswith(b"PK\x07\x08"):
        return "application/zip"
    return None


def _attachment_type_candidates(filename: str, content_type: str, detected_content_type: str | None = None) -> set[str]:
    name = str(filename or "").lower()
    guessed_type = (mimetypes.guess_type(name)[0] or "").lower()
    candidates = {str(content_type or "").split(";", 1)[0].strip().lower(), guessed_type, str(detected_content_type or "").lower()}
    candidates.discard("")
    return candidates


def _matches_allowed_type(filename: str, content_type: str, allowed_types: list[str], detected_content_type: str | None = None) -> bool:
    name = str(filename or "").lower()
    candidate_types = _attachment_type_candidates(filename, content_type, detected_content_type)
    if candidate_types & BLOCKED_ATTACHMENT_CONTENT_TYPES:
        return False
    if detected_content_type is None and candidate_types & MAGIC_REQUIRED_ATTACHMENT_TYPES:
        return False
    matching_magic_extensions = [ext for ext in MAGIC_REQUIRED_ATTACHMENT_EXTENSIONS if name.endswith(ext)]
    if matching_magic_extensions and detected_content_type is None:
        return False
    if matching_magic_extensions and detected_content_type is not None:
        expected_types = {MAGIC_REQUIRED_ATTACHMENT_EXTENSIONS[ext] for ext in matching_magic_extensions}
        if detected_content_type not in expected_types:
            return False
    for entry in allowed_types:
        if entry.startswith(".") and name.endswith(entry):
            return True
        if entry.endswith("/*"):
            prefix = entry[:-1]
            if any(candidate.startswith(prefix) for candidate in candidate_types):
                return True
        elif entry in candidate_types:
            return True
    return False


def enforce_attachment_upload_policy(db, *, user_id: int, filename: str, content_type: str, size_bytes: int, detected_content_type: str | None = None) -> dict[str, Any]:
    config = get_attachment_config(db)
    if not config["enabled"]:
        raise HTTPException(403, "Attachments are disabled by the administrator")
    if int(size_bytes or 0) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(413, "Attachment is too large")
    allowed_types = list(config["allowed_types"])
    if not _matches_allowed_type(filename, content_type, allowed_types, detected_content_type):
        raise HTTPException(415, "This attachment file type is not allowed")
    used = attachment_usage_bytes(db, user_id)
    quota = user_attachment_quota_bytes(db, user_id)
    if used + int(size_bytes or 0) > quota:
        raise HTTPException(413, "Attachment quota exceeded")
    effective_content_type = detected_content_type or str(content_type or "application/octet-stream").split(";", 1)[0].strip().lower() or "application/octet-stream"
    return {"used_bytes": used, "quota_bytes": quota, "allowed_types": allowed_types, "content_type": effective_content_type}
