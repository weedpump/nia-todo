"""nia-todo: FastAPI backend - slim entry point"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.responses import Response
from pathlib import Path
import asyncio
import html
import re

from db import init_db
from migrate import run_migrations
from middleware.security import SecurityHeadersMiddleware, RateLimitMiddleware, CSRFProtectionMiddleware
from middleware.dynamic_cors import DynamicCORSMiddleware
from services.push import check_and_send_reminders, cleanup_subscriptions
from routers.websocket import websocket_endpoint

# Migrationen beim Import ausführen
run_migrations()

app = FastAPI(title="nia-todo", version="0.4.0", docs_url=None, redoc_url=None, openapi_url=None)

# ─── Middleware ──────────────────────────────────────────────────────────────

app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(CSRFProtectionMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(DynamicCORSMiddleware)

# ─── Router ──────────────────────────────────────────────────────────────────

from routers import auth, todos, projects, sections, reminders, dashboard, push, admin, me, setup, sharing, password_setup, workspaces, instance, two_factor

app.include_router(auth.router)
app.include_router(instance.router)
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
app.include_router(two_factor.router)

# ─── WebSocket ───────────────────────────────────────────────────────────────

app.add_api_websocket_route("/ws", websocket_endpoint)

# ─── Public API Documentation ────────────────────────────────────────────────

DOCS_DIR = Path(__file__).parent.parent / "docs"


def _slugify_heading(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9äöüÄÖÜß -]", "", value).strip().lower()
    slug = slug.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    return re.sub(r"\s+", "-", slug) or "section"


def _render_inline_markdown(value: str) -> str:
    escaped = html.escape(value)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    return escaped


def _markdown_to_html(markdown: str) -> tuple[str, str]:
    lines = markdown.splitlines()
    body: list[str] = []
    toc: list[tuple[int, str, str]] = []
    in_code = False
    in_list = False
    code_lines: list[str] = []

    def close_list():
        nonlocal in_list
        if in_list:
            body.append("</ul>")
            in_list = False

    for line in lines:
        stripped = line.rstrip()
        if stripped.startswith("```"):
            if in_code:
                body.append(f"<pre><code>{html.escape(chr(10).join(code_lines))}</code></pre>")
                code_lines = []
                in_code = False
            else:
                close_list()
                in_code = True
            continue
        if in_code:
            code_lines.append(stripped)
            continue
        if not stripped:
            close_list()
            continue
        heading = re.match(r"^(#{1,4})\s+(.+)$", stripped)
        if heading:
            close_list()
            level = len(heading.group(1))
            text = heading.group(2).strip()
            slug = _slugify_heading(text)
            toc.append((level, slug, text))
            body.append(f'<h{level} id="{slug}">{_render_inline_markdown(text)}</h{level}>')
            continue
        if stripped.startswith("- "):
            if not in_list:
                body.append("<ul>")
                in_list = True
            body.append(f"<li>{_render_inline_markdown(stripped[2:].strip())}</li>")
            continue
        close_list()
        body.append(f"<p>{_render_inline_markdown(stripped)}</p>")

    if in_code:
        body.append(f"<pre><code>{html.escape(chr(10).join(code_lines))}</code></pre>")
    close_list()
    toc_html = "".join(
        f'<a class="toc-level-{level}" href="#{slug}">{html.escape(text)}</a>'
        for level, slug, text in toc
        if level <= 3
    )
    return "\n".join(body), toc_html


def _api_docs_html() -> str:
    docs_path = DOCS_DIR / "api.md"
    markdown = docs_path.read_text(encoding="utf-8") if docs_path.exists() else "# API\n\nKeine API-Doku gefunden."
    content, toc = _markdown_to_html(markdown)
    return f"""<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>nia-todo API</title>
  <style>
    :root {{ color-scheme: light dark; --bg:#0f172a; --panel:#111827; --text:#e5e7eb; --muted:#9ca3af; --border:#293245; --accent:#8b5cf6; --code:#020617; --input:#0b1220; --mark:#facc15; }}
    @media (prefers-color-scheme: light) {{ :root:not([data-theme]) {{ --bg:#f7f7fb; --panel:#ffffff; --text:#111827; --muted:#6b7280; --border:#e5e7eb; --accent:#7c3aed; --code:#f3f4f6; --input:#ffffff; --mark:#fde68a; }} }}
    :root[data-theme="light"] {{ color-scheme: light; --bg:#f7f7fb; --panel:#ffffff; --text:#111827; --muted:#6b7280; --border:#e5e7eb; --accent:#7c3aed; --code:#f3f4f6; --input:#ffffff; --mark:#fde68a; }}
    :root[data-theme="dark"] {{ color-scheme: dark; --bg:#0f172a; --panel:#111827; --text:#e5e7eb; --muted:#9ca3af; --border:#293245; --accent:#8b5cf6; --code:#020617; --input:#0b1220; --mark:#facc15; }}
    * {{ box-sizing: border-box; }}
    body {{ margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); line-height:1.6; }}
    header {{ padding:32px clamp(20px, 4vw, 56px); border-bottom:1px solid var(--border); background:linear-gradient(135deg, rgba(139,92,246,.22), transparent 55%); }}
    .hero {{ display:flex; align-items:flex-start; justify-content:space-between; gap:20px; }}
    header h1 {{ margin:0 0 8px; font-size:clamp(32px, 5vw, 54px); line-height:1.05; }}
    header p {{ margin:0; color:var(--muted); max-width:820px; }}
    .toolbar {{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; }}
    .theme-toggle {{ display:inline-flex; padding:4px; border:1px solid var(--border); border-radius:999px; background:var(--panel); }}
    .theme-toggle button {{ border:0; border-radius:999px; padding:7px 10px; background:transparent; color:var(--muted); cursor:pointer; font-weight:700; }}
    .theme-toggle button.active {{ background:rgba(139,92,246,.18); color:var(--accent); }}
    .search-row {{ max-width:1400px; margin:0 auto; padding:18px clamp(16px, 3vw, 40px) 0; }}
    .search-box {{ display:flex; gap:10px; align-items:center; padding:12px 14px; border:1px solid var(--border); border-radius:16px; background:var(--panel); }}
    .search-box input {{ width:100%; border:0; outline:0; background:transparent; color:var(--text); font:inherit; }}
    .search-box button {{ border:0; background:transparent; color:var(--muted); cursor:pointer; font-size:18px; }}
    #search-status {{ margin:8px 4px 0; color:var(--muted); font-size:13px; }}
    .layout {{ display:grid; grid-template-columns:280px minmax(0, 1fr); gap:28px; max-width:1400px; margin:0 auto; padding:20px clamp(16px, 3vw, 40px) 56px; }}
    nav {{ position:sticky; top:20px; align-self:start; max-height:calc(100vh - 40px); overflow:auto; padding:16px; border:1px solid var(--border); border-radius:18px; background:color-mix(in srgb, var(--panel) 92%, transparent); }}
    nav strong {{ display:block; margin-bottom:10px; }}
    nav a {{ display:block; padding:6px 8px; color:var(--muted); text-decoration:none; border-radius:10px; font-size:14px; }}
    nav a:hover {{ color:var(--text); background:rgba(139,92,246,.12); }}
    nav .toc-level-1 {{ color:var(--text); font-weight:700; }}
    nav .toc-level-3 {{ padding-left:22px; font-size:13px; }}
    main {{ min-width:0; padding:26px; border:1px solid var(--border); border-radius:22px; background:var(--panel); box-shadow:0 20px 70px rgba(0,0,0,.18); }}
    h1, h2, h3, h4 {{ line-height:1.25; scroll-margin-top:24px; }}
    h1 {{ margin-top:0; }}
    h2 {{ margin-top:44px; padding-top:24px; border-top:1px solid var(--border); }}
    a {{ color:var(--accent); }}
    code {{ padding:.12em .35em; border-radius:7px; background:var(--code); font-size:.92em; }}
    pre {{ overflow:auto; padding:16px; border-radius:16px; background:var(--code); border:1px solid var(--border); }}
    pre code {{ padding:0; background:transparent; }}
    li {{ margin:6px 0; }}
    mark {{ background:var(--mark); color:#111827; border-radius:4px; padding:0 .12em; }}
    .hidden-by-search {{ display:none !important; }}
    @media (max-width: 900px) {{ .hero {{ display:block; }} .toolbar {{ margin-top:18px; }} .layout {{ display:block; }} nav {{ position:static; max-height:none; margin-bottom:18px; }} main {{ padding:18px; }} }}
  </style>
</head>
<body>
  <header>
    <div class="hero">
      <div>
        <h1>nia-todo API</h1>
        <p>Öffentliche API-Dokumentation dieser Instanz. Authentifizierung läuft über JWT oder API-Key, je nach Endpoint.</p>
      </div>
      <div class="toolbar" aria-label="Darstellung">
        <div class="theme-toggle">
          <button type="button" data-theme-choice="light">Hell</button>
          <button type="button" data-theme-choice="dark">Dunkel</button>
          <button type="button" data-theme-choice="system">System</button>
        </div>
      </div>
    </div>
  </header>
  <div class="search-row">
    <label class="search-box">
      <span aria-hidden="true">⌕</span>
      <input id="api-search" type="search" placeholder="API-Doku durchsuchen… z.B. API-Key, Passkey, /api/me" autocomplete="off">
      <button type="button" id="api-search-clear" title="Suche löschen" aria-label="Suche löschen">×</button>
    </label>
    <div id="search-status"></div>
  </div>
  <div class="layout">
    <nav><strong>Inhalt</strong>{toc}</nav>
    <main id="api-content">{content}</main>
  </div>
  <script>
    (() => {{
      const root = document.documentElement;
      const buttons = Array.from(document.querySelectorAll('[data-theme-choice]'));
      const storedTheme = localStorage.getItem('nia-api-doc-theme') || 'system';
      function applyTheme(theme) {{
        if (theme === 'system') root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', theme);
        localStorage.setItem('nia-api-doc-theme', theme);
        buttons.forEach((button) => button.classList.toggle('active', button.dataset.themeChoice === theme));
      }}
      buttons.forEach((button) => button.addEventListener('click', () => applyTheme(button.dataset.themeChoice || 'system')));
      applyTheme(storedTheme);

      const search = document.getElementById('api-search');
      const clear = document.getElementById('api-search-clear');
      const status = document.getElementById('search-status');
      const main = document.getElementById('api-content');
      const blocks = Array.from(main.children).map((el) => ({{ el, html: el.innerHTML, text: el.textContent.toLowerCase() }}));
      const tocLinks = Array.from(document.querySelectorAll('nav a'));
      const escapeRegExp = (value) => Array.from(value).map((ch) => '^$*+?.()|{{}}[]\\\\'.includes(ch) ? '\\\\' + ch : ch).join('');
      function runSearch() {{
        const query = search.value.trim().toLowerCase();
        let matches = 0;
        blocks.forEach((block) => {{
          block.el.innerHTML = block.html;
          const hit = !query || block.text.includes(query);
          block.el.classList.toggle('hidden-by-search', !hit);
          if (hit && query) {{
            matches += 1;
            const rx = new RegExp(`(${{escapeRegExp(query)}})`, 'ig');
            if (!['PRE', 'CODE'].includes(block.el.tagName)) block.el.innerHTML = block.html.replace(rx, '<mark>$1</mark>');
          }}
        }});
        tocLinks.forEach((link) => {{
          const href = link.getAttribute('href') || '';
          const target = href.startsWith('#') ? document.getElementById(decodeURIComponent(href.slice(1))) : null;
          link.classList.toggle('hidden-by-search', Boolean(query) && target?.classList.contains('hidden-by-search'));
        }});
        status.textContent = query ? `${{matches}} Treffer für „${{search.value.trim()}}“` : '';
      }}
      search.addEventListener('input', runSearch);
      clear.addEventListener('click', () => {{ search.value = ''; search.focus(); runSearch(); }});
    }})();
  </script>
</body>
</html>"""


@app.get("/api", response_class=HTMLResponse)
@app.get("/api/", response_class=HTMLResponse)
def public_api_docs():
    return HTMLResponse(
        _api_docs_html(),
        headers={
            "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )

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
