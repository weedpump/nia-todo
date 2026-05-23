"""nia-todo: Audit log helper"""

def log_audit(db, event_type: str, user_id: int = None, ip_address: str = None, details: str = None):
    """Log security-relevant events to audit_log table."""
    try:
        db.execute(
            """INSERT INTO audit_log (event_type, user_id, ip_address, details, created_at)
               VALUES (?, ?, ?, ?, datetime('now'))""",
            (event_type, user_id, ip_address, details)
        )
    except Exception:
        pass
