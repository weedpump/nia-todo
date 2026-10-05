"""nia-todo: FastAPI backend - slim entry point"""

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
import asyncio
import re

from db import get_db, init_db
from migrate import run_migrations
from rate_limit import rate_limiter
from middleware.security import CSRFProtectionMiddleware, RateLimitMiddleware, RequestBodyLimitMiddleware, SecurityHeadersMiddleware
from middleware.dynamic_cors import DynamicCORSMiddleware
from services.push import check_and_send_reminders, cleanup_subscriptions
from services.server_updates import update_check_background_task
from routers.websocket import websocket_endpoint
from errors import APIError, api_error_handler

# Run migrations on import
run_migrations()

app = FastAPI(title="nia-todo", version="0.4.0", docs_url=None, redoc_url=None, openapi_url=None)

# ─── Middleware ──────────────────────────────────────────────────────────────

app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(CSRFProtectionMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(DynamicCORSMiddleware)
app.add_middleware(RequestBodyLimitMiddleware)


def add_app_shell_cache_headers(response, path: str):
    if (
        path == "/"
        or path in {"/index.html", "/manifest.json", "/setup", "/admin", "/set-password", "/favicon.ico"}
        or path.startswith("/static/")
    ):
        response.headers["Cache-Control"] = "no-cache, max-age=0, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.middleware("http")
async def app_shell_cache_control_middleware(request, call_next):
    response = await call_next(request)
    return add_app_shell_cache_headers(response, request.url.path)

# ─── Router ──────────────────────────────────────────────────────────────────

from routers import auth, todos, projects, sections, reminders, places, dashboard, push, admin, me, setup, sharing, password_setup, workspaces, instance, two_factor, braindump_v2, oidc, server_updates

app.include_router(auth.router)
app.include_router(oidc.router)
app.include_router(instance.router)
app.include_router(todos.router)
app.include_router(workspaces.router)
app.include_router(projects.router)
app.include_router(sections.router)
app.include_router(reminders.router)
app.include_router(places.router)
app.include_router(dashboard.router)
app.include_router(push.router)
app.include_router(admin.router)
app.include_router(setup.router)
app.include_router(me.router)
app.include_router(sharing.router)
app.include_router(password_setup.router)
app.include_router(two_factor.router)
app.include_router(braindump_v2.router)
app.include_router(server_updates.router)

# ─── Exception Handlers ──────────────────────────────────────────────────────

app.add_exception_handler(APIError, api_error_handler)

# ─── WebSocket ───────────────────────────────────────────────────────────────

app.add_api_websocket_route("/ws", websocket_endpoint)

# ─── Background Tasks ────────────────────────────────────────────────────────

async def reminder_background_task():
    print("[PUSH] Background reminder task started")
    while True:
        try:
            await check_and_send_reminders()
        except Exception as e:
            print(f"[PUSH] Background task error: {e}")
        await asyncio.sleep(30)

async def rate_limit_cleanup_task():
    while True:
        await asyncio.sleep(300)
        rate_limiter.prune_expired()


async def subscription_cleanup_task():
    while True:
        await asyncio.sleep(14 * 24 * 60 * 60)
        try:
            await cleanup_subscriptions()
        except Exception as e:
            print(f"[PUSH] Subscription cleanup error: {e}")

@app.on_event("startup")
async def on_startup():
    init_db()
    from services.setup_token import ensure_setup_token, SETUP_TOKEN_PATH
    with get_db() as db:
        config = db.execute("SELECT setup_complete FROM admin_config WHERE id = 1").fetchone()
        setup_complete = bool(config["setup_complete"]) if config else False
    setup_token = ensure_setup_token(setup_complete=setup_complete)
    if setup_token:
        print("[SETUP] First-run setup is protected by a one-time token.", flush=True)
        print(f"[SETUP] Token: {setup_token}", flush=True)
        print(f"[SETUP] Token file: {SETUP_TOKEN_PATH}", flush=True)
    async def delayed_start():
        await asyncio.sleep(2)
        asyncio.create_task(reminder_background_task())
        asyncio.create_task(subscription_cleanup_task())
        asyncio.create_task(rate_limit_cleanup_task())
    asyncio.create_task(update_check_background_task())
    asyncio.create_task(delayed_start())

# ─── Static Frontend ─────────────────────────────────────────────────────────

from paths import AVATAR_DIR
from routers.auth import require_auth

AVATAR_DIR.mkdir(parents=True, exist_ok=True)
@app.get("/api/avatars/{filename}")
def avatar_file(filename: str, _: int = Depends(require_auth)):
    if not re.fullmatch(r"user-[0-9]+\.webp", filename):
        raise HTTPException(404, "Avatar not found")
    path = AVATAR_DIR / filename
    if not path.is_file():
        raise HTTPException(404, "Avatar not found")
    return FileResponse(path, media_type="image/webp")


WEB_DIR = Path(__file__).parent / "../web"
if WEB_DIR.exists():
    DOWNLOADS_DIR = WEB_DIR / "downloads"
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/static", StaticFiles(directory=str(WEB_DIR / "static")), name="static")

    @app.get("/downloads/app-downloads.json")
    @app.head("/downloads/app-downloads.json")
    def app_downloads_manifest():
        manifest_path = DOWNLOADS_DIR / "app-downloads.json"
        if not manifest_path.exists():
            return JSONResponse(
                {"version": "", "apps": []},
                headers={
                    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0",
                },
            )
        return FileResponse(
            str(manifest_path),
            media_type="application/json",
            headers={
                "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
                "Pragma": "no-cache",
                "Expires": "0",
            },
        )

    app.mount("/downloads", StaticFiles(directory=str(DOWNLOADS_DIR)), name="downloads")

    @app.get("/.well-known/assetlinks.json")
    @app.head("/.well-known/assetlinks.json")
    def android_asset_links():
        from services.webauthn import ANDROID_PACKAGE_NAME, ANDROID_RELEASE_CERT_SHA256

        return JSONResponse(
            [
                {
                    "relation": [
                        "delegate_permission/common.handle_all_urls",
                        "delegate_permission/common.get_login_creds",
                    ],
                    "target": {
                        "namespace": "android_app",
                        "package_name": ANDROID_PACKAGE_NAME,
                        "sha256_cert_fingerprints": [ANDROID_RELEASE_CERT_SHA256],
                    },
                }
            ],
            headers={"Cache-Control": "no-store, no-cache, max-age=0, must-revalidate"},
        )

    @app.get("/")
    def index():
        return FileResponse(str(WEB_DIR / "index.html"))

    @app.get("/setup")
    def setup_page():
        return FileResponse(str(WEB_DIR / "setup.html"))

    @app.get("/admin")
    def admin_page():
        return FileResponse(str(WEB_DIR / "admin.html"))

    @app.get("/set-password")
    def set_password_page():
        return FileResponse(str(WEB_DIR / "set-password.html"))

    @app.get("/sw.js")
    @app.head("/sw.js")
    def sw_js():
        return FileResponse(
            str(WEB_DIR / "sw.js"),
            media_type="application/javascript",
            headers={
                "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
                "Pragma": "no-cache",
                "Expires": "0",
            },
        )

    @app.get("/favicon.ico")
    @app.head("/favicon.ico")
    def favicon():
        if (WEB_DIR / "favicon.ico").exists():
            return FileResponse(str(WEB_DIR / "favicon.ico"))
        return FileResponse(str(WEB_DIR / "static" / "icons" / "icon-192.png"))

    @app.get("/{path:path}")
    def spa(path: str):
        from pathlib import PurePath
        filename = PurePath(path).name
        if not filename:
            return FileResponse(str(WEB_DIR / "index.html"))
        f = (WEB_DIR / filename).resolve()
        try:
            f.relative_to(WEB_DIR.resolve())
        except ValueError:
            return FileResponse(str(WEB_DIR / "index.html"))
        if f.exists() and f.is_file():
            return FileResponse(str(f))
        return FileResponse(str(WEB_DIR / "index.html"))
