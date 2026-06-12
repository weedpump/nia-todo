"""Generic OIDC login endpoints."""

from __future__ import annotations

import html
import json
from urllib.parse import quote

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse

from routers.admin import require_admin
from services.oidc import (
    complete_admin_oidc_login,
    complete_user_oidc_login,
    consume_state,
    create_authorization_url,
    discover_provider,
    exchange_code,
    enrich_claims_from_userinfo,
    link_admin_oidc_identity,
    validate_id_token,
)
from middleware.security import set_csrf_cookie
from services.oidc_config import get_oidc_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/oidc")


def _json_for_script(value) -> str:
    return json.dumps(value, separators=(",", ":")).replace("</", "<\\/")


def _completion_html(kind: str, payload: dict, redirect_to: str = "/") -> HTMLResponse:
    safe_payload = _json_for_script(payload)
    safe_redirect = _json_for_script(redirect_to or "/")
    title = "OIDC sign-in complete"
    if kind == "error":
        title = "OIDC sign-in failed"
    script = f"""
      (function() {{
        const payload = {safe_payload};
        if ({_json_for_script(kind)} === 'user') {{
          localStorage.setItem('jwt_token', payload.access_token);
          if (payload.csrf_token) localStorage.setItem('csrf_token', payload.csrf_token);
          if (payload.user) {{
            localStorage.setItem('cached_user', JSON.stringify(payload.user));
            localStorage.setItem('last_user_id', String(payload.user.id));
          }}
          location.replace({safe_redirect});
          return;
        }}
        if ({_json_for_script(kind)} === 'admin') {{
          localStorage.setItem('admin_jwt_token', payload.access_token);
          if (payload.csrf_token) localStorage.setItem('csrf_token', payload.csrf_token);
          location.replace('/admin');
          return;
        }}
        if ({_json_for_script(kind)} === 'admin_link') {{
          sessionStorage.setItem('nia_admin_oidc_link_result', JSON.stringify(payload));
          location.replace('/admin');
          return;
        }}
        document.getElementById('message').textContent = payload.error || 'OIDC failed';
      }})();
    """
    response = HTMLResponse(f"""<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title></head>
<body><p id='message'>Completing OIDC sign-in…</p><script>{script}</script></body></html>""")
    response.headers["Cache-Control"] = "no-store"
    if payload.get("csrf_token"):
        set_csrf_cookie(response, payload["csrf_token"])
    return response


def _error_html(message: str) -> HTMLResponse:
    return _completion_html("error", {"error": message})


@router.get("/status")
def oidc_status():
    config = get_oidc_config()
    return {
        "enabled": bool(config.get("enabled")),
        "provider_name": config.get("provider_name") or "OIDC",
        "logout_url": config.get("logout_url") or "",
    }


@router.get("/login")
def oidc_login(redirect_after: str = "/"):
    return RedirectResponse(create_authorization_url(purpose="user_login", redirect_after=redirect_after), status_code=302)


@router.get("/admin/login")
def oidc_admin_login():
    return RedirectResponse(create_authorization_url(purpose="admin_login", redirect_after="/admin"), status_code=302)


@router.post("/admin/link/start")
def oidc_admin_link_start(_: bool = Depends(require_admin)):
    return {"authorization_url": create_authorization_url(purpose="admin_link", redirect_after="/admin")}


@router.get("/callback")
def oidc_callback(code: str = "", state: str = "", error: str = "", error_description: str = "", request: Request = None, response: Response = None):
    if error:
        return _error_html(error_description or error)
    if not code or not state:
        return _error_html("OIDC callback missing code or state")
    try:
        config = get_oidc_config(include_secret=True)
        metadata = discover_provider(config)
        state_row = consume_state(state)
        tokens = exchange_code(code, state_row, metadata, config)
        claims = validate_id_token(tokens["id_token"], metadata, config, state_row["nonce"])
        claims = enrich_claims_from_userinfo(claims, tokens, metadata)
        purpose = state_row["purpose"]
        if purpose == "admin_login":
            payload = complete_admin_oidc_login(claims, response)
            logger.info("OIDC admin login completed: issuer=%s subject=%s", claims.get("iss"), claims.get("sub"))
            return _completion_html("admin", payload, "/admin")
        if purpose == "admin_link":
            payload = link_admin_oidc_identity(claims)
            logger.info("OIDC admin link completed: issuer=%s subject=%s", claims.get("iss"), claims.get("sub"))
            return _completion_html("admin_link", payload, "/admin")
        payload = complete_user_oidc_login(claims, request, response)
        logger.info("OIDC user login completed: issuer=%s subject=%s", claims.get("iss"), claims.get("sub"))
        return _completion_html("user", payload, state_row.get("redirect_after") or "/")
    except HTTPException as exc:
        logger.warning("OIDC callback failed: %s", exc.detail)
        return _error_html(str(exc.detail))
    except Exception as exc:
        logger.exception("OIDC callback crashed")
        return _error_html(f"OIDC callback failed: {exc}")
