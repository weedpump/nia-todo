"""nia-todo: FastAPI backend - slim entry point"""

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import asyncio

from db import init_db
from migrate import run_migrations
from middleware.security import SecurityHeadersMiddleware, RateLimitMiddleware, CSRFProtectionMiddleware
from services.push import check_and_send_reminders, cleanup_subscriptions
from routers.websocket import websocket_endpoint

# Migrationen beim Import ausführen
run_migrations()

app = FastAPI(title="nia-todo", version="0.4.0", docs_url=None, redoc_url=None, openapi_url=None)

# ─── Middleware ──────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://todo.kneidl-home.de", "https://todo-dev.kneidl-home.de"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Session-Token", "X-Admin-Token", "X-Requested-With"],
)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(CSRFProtectionMiddleware)
app.add_middleware(RateLimitMiddleware)

# ─── Router ──────────────────────────────────────────────────────────────────

from routers import auth, todos, projects, sections, reminders, dashboard, push, admin, me, setup, sharing, password_setup, workspaces

app.include_router(auth.router)
app.include_router(todos.router)
app.include_router(workspaces.router)
app.include_router(projects.router)
app.include_router(sections.router)
app.include_router(reminders.router)
app.include_router(dashboard.router)
app.include_router(push.router)
app.include_router(admin.router)
app.include_router(setup.router)
app.include_router(me.router)
app.include_router(sharing.router)
app.include_router(password_setup.router)

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
    async def delayed_start():
        await asyncio.sleep(2)
        asyncio.create_task(reminder_background_task())
        asyncio.create_task(subscription_cleanup_task())
    asyncio.create_task(delayed_start())

# ─── Static Frontend ─────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).parent / "data"
AVATAR_DIR = DATA_DIR / "avatars"
AVATAR_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/avatars", StaticFiles(directory=str(AVATAR_DIR)), name="avatars")

WEB_DIR = Path(__file__).parent / "../web"
if WEB_DIR.exists():
    DOWNLOADS_DIR = WEB_DIR / "downloads"
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/static", StaticFiles(directory=str(WEB_DIR / "static")), name="static")
    app.mount("/downloads", StaticFiles(directory=str(DOWNLOADS_DIR)), name="downloads")

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
        return FileResponse(str(WEB_DIR / "sw.js"))

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
