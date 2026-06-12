"""Generic OIDC login endpoints."""

from __future__ import annotations

import html
import json
from urllib.parse import quote, urlencode, urlsplit, parse_qs

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel

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
    list_admin_oidc_identities,
    unlink_admin_oidc_identity,
    validate_id_token,
    create_native_handoff,
    consume_native_handoff,
)
from middleware.security import set_csrf_cookie
from services.oidc_config import get_oidc_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/oidc")


NATIVE_OIDC_MARKER = "/__native_oidc"
NATIVE_OIDC_SCHEME = "nia-todo"


class NativeOidcExchangeRequest(BaseModel):
    code: str


def _native_marker(kind: str, redirect_after: str = "/") -> str:
    safe_redirect = quote(redirect_after if redirect_after.startswith("/") else "/", safe="")
    return f"{NATIVE_OIDC_MARKER}/{quote(kind, safe='')}?redirect_after={safe_redirect}"


def _native_marker_info(value: str | None) -> dict | None:
    raw = str(value or "")
    parsed = urlsplit(raw)
    if parsed.scheme or parsed.netloc or not parsed.path.startswith(f"{NATIVE_OIDC_MARKER}/"):
        return None
    kind = parsed.path.removeprefix(f"{NATIVE_OIDC_MARKER}/") or "user"
    query = parse_qs(parsed.query)
    redirect_after = query.get("redirect_after", ["/"])[0] or "/"
    if not redirect_after.startswith("/") or redirect_after.startswith("//") or "\\" in redirect_after:
        redirect_after = "/"
    return {"kind": kind, "redirect_after": redirect_after}


def _native_redirect_html(code: str, kind: str, redirect_after: str = "/") -> HTMLResponse:
    params = urlencode({"code": code, "kind": kind, "redirect_after": redirect_after or "/"})
    callback_url = f"{NATIVE_OIDC_SCHEME}://oidc/callback?{params}"
    safe_callback = _json_for_script(callback_url)
    response = HTMLResponse(f"""<!doctype html><html><head><meta charset='utf-8'><title>Returning to nia-todo…</title></head>
<body><p id='message'>Returning to nia-todo…</p><script>location.replace({safe_callback});</script>
<p><a href={html.escape(json.dumps(callback_url))}>Open nia-todo</a></p></body></html>""")
    response.headers["Cache-Control"] = "no-store"
    return response


def _native_completion_or_html(kind: str, payload: dict, redirect_to: str = "/") -> HTMLResponse:
    native = _native_marker_info(redirect_to)
    if native:
        code = create_native_handoff(kind=kind, payload=payload, redirect_after=native["redirect_after"])
        return _native_redirect_html(code, kind, native["redirect_after"])
    return _completion_html(kind, payload, redirect_to)


def _json_for_script(value) -> str:
    return (
        json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        .replace("</", "<\\/")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


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
        if ({_json_for_script(kind)} === 'error') {{
          sessionStorage.setItem('nia_oidc_error', JSON.stringify({{ error_key: payload.error_key || 'auth.oidc.errorMessage', error: payload.error || '', kind: payload.kind || 'user' }}));
          location.replace({safe_redirect});
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


def _error_html(message: str, *, redirect_to: str = "/", kind: str = "user") -> HTMLResponse:
    return _native_completion_or_html("error", {"error_key": "auth.oidc.errorMessage", "error": message, "kind": kind}, redirect_to)


def _no_store(response: Response) -> Response:
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


def _oidc_redirect(url: str) -> RedirectResponse:
    return _no_store(RedirectResponse(url, status_code=302))


@router.get("/status")
def oidc_status():
    config = get_oidc_config()
    return _no_store(Response(
        content=json.dumps({
            "enabled": bool(config.get("enabled")),
            "provider_name": config.get("provider_name") or "OIDC",
        }),
        media_type="application/json",
    ))


@router.get("/login")
def oidc_login(redirect_after: str = "/", native: bool = False):
    target = _native_marker("user", redirect_after) if native else redirect_after
    return _oidc_redirect(create_authorization_url(purpose="user_login", redirect_after=target))


@router.get("/admin/login")
def oidc_admin_login():
    return _oidc_redirect(create_authorization_url(purpose="admin_login", redirect_after="/admin"))


@router.get("/admin/links")
def oidc_admin_links(_: bool = Depends(require_admin)):
    return _no_store(Response(
        content=json.dumps({"identities": list_admin_oidc_identities()}),
        media_type="application/json",
    ))


@router.post("/admin/link/start")
def oidc_admin_link_start(_: bool = Depends(require_admin)):
    return _no_store(Response(
        content=json.dumps({"authorization_url": create_authorization_url(purpose="admin_link", redirect_after="/admin")}),
        media_type="application/json",
    ))


@router.post("/native/exchange")
def oidc_native_exchange(payload: NativeOidcExchangeRequest):
    handoff = consume_native_handoff(payload.code)
    data = handoff.get("payload") or {}
    exchange_response = Response(
        content=json.dumps({
            "kind": handoff.get("kind"),
            "payload": data,
            "redirect_after": handoff.get("redirect_after") or "/",
        }),
        media_type="application/json",
    )
    if data.get("csrf_token"):
        set_csrf_cookie(exchange_response, data["csrf_token"])
    return _no_store(exchange_response)


@router.delete("/admin/links/{identity_id}")
def oidc_admin_unlink(identity_id: int, _: bool = Depends(require_admin)):
    return unlink_admin_oidc_identity(identity_id)


@router.get("/callback")
def oidc_callback(code: str = "", state: str = "", error: str = "", error_description: str = "", request: Request = None, response: Response = None):
    state_row = None
    try:
        state_row = consume_state(state) if state else None
        redirect_to = state_row.get("redirect_after") if state_row else "/"
        error_kind = "admin" if state_row and state_row.get("purpose") in {"admin_login", "admin_link"} else "user"
        if error:
            return _error_html(error_description or error, redirect_to=redirect_to or "/", kind=error_kind)
        if not code or not state_row:
            return _error_html("OIDC callback missing code or state", redirect_to=redirect_to or "/", kind=error_kind)
        config = get_oidc_config(include_secret=True)
        metadata = discover_provider(config)
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
        return _native_completion_or_html("user", payload, state_row.get("redirect_after") or "/")
    except HTTPException as exc:
        logger.warning("OIDC callback failed: %s", exc.detail)
        redirect_to = state_row.get("redirect_after") if state_row else "/"
        error_kind = "admin" if state_row and state_row.get("purpose") in {"admin_login", "admin_link"} else "user"
        return _error_html(str(exc.detail), redirect_to=redirect_to or "/", kind=error_kind)
    except Exception as exc:
        logger.exception("OIDC callback crashed")
        redirect_to = state_row.get("redirect_after") if state_row else "/"
        error_kind = "admin" if state_row and state_row.get("purpose") in {"admin_login", "admin_link"} else "user"
        return _error_html(f"OIDC callback failed: {exc}", redirect_to=redirect_to or "/", kind=error_kind)
