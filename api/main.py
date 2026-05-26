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
from errors import APIError, api_error_handler

# Run migrations on import
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

# ─── Exception Handlers ──────────────────────────────────────────────────────

app.add_exception_handler(APIError, api_error_handler)

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
    escaped = re.sub(r"\[([^\]]+)\]\((https?://[^\s)]+)\)", r'<a href="\2" rel="noopener noreferrer">\1</a>', escaped)
    return escaped


def _markdown_to_html(markdown: str, toc_filter=None) -> tuple[str, str]:
    lines = markdown.splitlines()
    body: list[str] = []
    toc: list[tuple[int, str, str]] = []
    in_code = False
    in_list = False
    code_lines: list[str] = []
    used_slugs: dict[str, int] = {}

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
            base_slug = _slugify_heading(text)
            count = used_slugs.get(base_slug, 0)
            used_slugs[base_slug] = count + 1
            slug = base_slug if count == 0 else f"{base_slug}-{count + 1}"
            if toc_filter is None or toc_filter(level, text):
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


def _document_html(title: str, subtitle: str, markdown: str, search_placeholder: str, toc_filter=None) -> str:
    content, toc = _markdown_to_html(markdown, toc_filter=toc_filter)
    safe_title = html.escape(title)
    safe_subtitle = html.escape(subtitle)
    safe_placeholder = html.escape(search_placeholder)
    return rf"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{safe_title}</title>
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
    .admin-theme-toggle {{ display:flex; gap:6px; }}
    .admin-theme-toggle button {{ width:32px; height:32px; border:1px solid var(--border); border-radius:8px; background:var(--panel); color:var(--muted); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:background .15s, border-color .15s, color .15s, transform .1s; }}
    .admin-theme-toggle button:hover {{ background:var(--code); color:var(--text); }}
    .admin-theme-toggle button.active {{ background:var(--accent); border-color:var(--accent); color:white; transform:scale(1.05); }}
    .ui-icon {{ width:18px; height:18px; }}
    .search-row {{ max-width:1400px; margin:0 auto; padding:18px clamp(16px, 3vw, 40px) 0; }}
    .search-box {{ display:flex; gap:10px; align-items:center; padding:12px 14px; border:1px solid var(--border); border-radius:16px; background:var(--panel); }}
    .search-box input {{ width:100%; border:0; outline:0; background:transparent; color:var(--text); font:inherit; }}
    .search-box button {{ border:0; background:transparent; color:var(--muted); cursor:pointer; font-size:18px; }}
    #search-status {{ margin:8px 4px 0; color:var(--muted); font-size:13px; }}
    .layout {{ display:grid; grid-template-columns:280px minmax(0, 1fr); gap:28px; max-width:1400px; margin:0 auto; padding:20px clamp(16px, 3vw, 40px) 56px; }}
    nav {{ position:sticky; top:20px; align-self:start; max-height:calc(100vh - 40px); overflow:auto; padding:16px; border:1px solid var(--border); border-radius:18px; background:color-mix(in srgb, var(--panel) 92%, transparent); }}
    .toc-toggle {{ display:none; width:100%; border:0; background:transparent; color:var(--text); font:inherit; font-weight:700; padding:0; text-align:left; cursor:pointer; align-items:center; justify-content:space-between; gap:10px; }}
    .toc-toggle .toc-chevron {{ color:var(--muted); transition:transform .15s ease; }}
    nav strong {{ display:block; margin-bottom:10px; }}
    .toc-links {{ display:block; }}
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
    @media (max-width: 900px) {{ .hero {{ display:block; }} .toolbar {{ margin-top:18px; }} .layout {{ display:block; }} nav {{ position:static; max-height:none; margin-bottom:18px; }} nav strong {{ display:none; }} .toc-toggle {{ display:flex; }} .toc-links {{ display:none; margin-top:10px; }} nav.toc-open .toc-links {{ display:block; }} nav.toc-open .toc-chevron {{ transform:rotate(180deg); }} main {{ padding:18px; }} }}
  </style>
</head>
<body>
  <header>
    <div class="hero">
      <div>
        <h1>{safe_title}</h1>
        <p>{safe_subtitle}</p>
      </div>
      <div class="toolbar" aria-label="Display options">
        <div class="admin-theme-toggle">
          <button type="button" data-theme="light" onclick="setTheme('light')" title="Light" aria-label="Light theme"><span data-icon="sun"></span></button>
          <button type="button" data-theme="dark" onclick="setTheme('dark')" title="Dark" aria-label="Dark theme"><span data-icon="moon"></span></button>
          <button type="button" data-theme="system" onclick="setTheme('system')" title="System" aria-label="System theme"><span data-icon="monitor"></span></button>
        </div>
      </div>
    </div>
  </header>
  <div class="search-row">
    <label class="search-box">
      <span aria-hidden="true">⌕</span>
      <input id="api-search" type="search" placeholder="{safe_placeholder}" autocomplete="off">
      <button type="button" id="api-search-clear" title="Clear search" aria-label="Clear search">×</button>
    </label>
    <div id="search-status"></div>
  </div>
  <div class="layout">
    <nav class="toc-panel"><strong>Contents</strong><button type="button" class="toc-toggle" aria-expanded="false" aria-controls="toc-links"><span>Contents</span><span class="toc-chevron" aria-hidden="true">⌄</span></button><div class="toc-links" id="toc-links">{toc}</div></nav>
    <main id="api-content">{content}</main>
  </div>
  <script>
    (() => {{
      const ICONS = {{
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
        moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
        monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
      }};
      document.querySelectorAll('[data-icon]').forEach((el) => {{
        const name = el.getAttribute('data-icon');
        if (!ICONS[name]) return;
        el.innerHTML = `<svg class="ui-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{ICONS[name]}}</svg>`;
      }});
      const root = document.documentElement;
      const buttons = Array.from(document.querySelectorAll('[data-theme]'));
      window.setTheme = (mode) => {{
        try {{ localStorage.setItem('nia-docs-theme', mode); }} catch {{}}
        root.removeAttribute('data-theme');
        if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
        buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.theme === mode));
      }};
      let saved = 'system';
      try {{ saved = localStorage.getItem('nia-docs-theme') || 'system'; }} catch {{}}
      window.setTheme(saved);

      const tocPanel = document.querySelector('nav.toc-panel');
      const tocToggle = document.querySelector('.toc-toggle');
      tocToggle?.addEventListener('click', () => {{
        const open = !tocPanel?.classList.contains('toc-open');
        tocPanel?.classList.toggle('toc-open', open);
        tocToggle.setAttribute('aria-expanded', String(open));
      }});

      const search = document.getElementById('api-search');
      const clear = document.getElementById('api-search-clear');
      const status = document.getElementById('search-status');
      const blocks = Array.from(document.querySelectorAll('main > *')).map((el) => ({{ el, html: el.innerHTML, text: el.textContent || '' }}));
      const tocLinks = Array.from(document.querySelectorAll('nav a'));
      function escapeRegExp(value) {{ return value.replace(/[.*+?^${{}}()|[\]\\]/g, '\\$&'); }}
      function highlightTextNodes(element, rawQuery) {{
        const rx = new RegExp(escapeRegExp(rawQuery), 'gi');
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {{
          acceptNode(node) {{
            if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(rawQuery.toLowerCase())) return NodeFilter.FILTER_REJECT;
            if (node.parentElement?.closest('script, style, code, pre, mark')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }}
        }});
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach((node) => {{
          const fragment = document.createDocumentFragment();
          let lastIndex = 0;
          const text = node.nodeValue;
          text.replace(rx, (match, offset) => {{
            if (offset > lastIndex) fragment.appendChild(document.createTextNode(text.slice(lastIndex, offset)));
            const mark = document.createElement('mark');
            mark.textContent = match;
            fragment.appendChild(mark);
            lastIndex = offset + match.length;
            return match;
          }});
          if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
          node.parentNode?.replaceChild(fragment, node);
        }});
      }}
      function runSearch() {{
        const rawQuery = search.value.trim();
        const query = rawQuery.toLowerCase();
        const visible = new Set();
        let matches = 0;
        blocks.forEach((block, index) => {{
          block.el.classList.remove('hidden-by-search');
          block.el.innerHTML = block.html;
          if (!query) {{
            visible.add(index);
            return;
          }}
          const hit = block.text.toLowerCase().includes(query);
          if (!hit) return;
          matches++;
          visible.add(index);
          for (let cursor = index - 1; cursor >= 0; cursor--) {{
            const tag = blocks[cursor].el.tagName;
            if (/^H[1-4]$/.test(tag)) visible.add(cursor);
            if (tag === 'H2') break;
          }}
        }});
        blocks.forEach((block, index) => {{
          const show = !query || visible.has(index);
          block.el.classList.toggle('hidden-by-search', !show);
          if (show && query && block.text.toLowerCase().includes(query)) {{
            highlightTextNodes(block.el, rawQuery);
          }}
        }});
        tocLinks.forEach((link) => {{
          const href = link.getAttribute('href') || '';
          const target = href.startsWith('#') ? document.getElementById(decodeURIComponent(href.slice(1))) : null;
          link.classList.toggle('hidden-by-search', Boolean(query) && target?.classList.contains('hidden-by-search'));
        }});
        status.textContent = query ? `${{matches}} results for “${{search.value.trim()}}”` : '';
      }}
      search.addEventListener('input', runSearch);
      clear.addEventListener('click', () => {{ search.value = ''; search.focus(); runSearch(); }});
    }})();
  </script>
</body>
</html>"""


def _api_docs_html() -> str:
    docs_path = DOCS_DIR / "api.md"
    markdown = docs_path.read_text(encoding="utf-8") if docs_path.exists() else "# API\n\nNo API documentation found."
    return _document_html(
        "nia-todo API",
        "Public API documentation for this instance. Authentication uses JWT or API key depending on the endpoint.",
        markdown,
        "Search API docs… e.g. API key, passkey, /api/me",
    )


def _changelog_html() -> str:
    changelog_path = Path(__file__).parent.parent / "CHANGELOG.md"
    markdown = changelog_path.read_text(encoding="utf-8") if changelog_path.exists() else "# Changelog\n\nNo changelog found."
    return _document_html(
        "nia-todo Changelog",
        "Public version history with the main changes, fixes, and security improvements.",
        markdown,
        "Search changelog… e.g. workspaces, Android, security",
        toc_filter=lambda level, text: level == 2 and re.match(r"^\[?\d+\.\d+\.\d+\]?(?:\s|-|$)", text),
    )

def _no_store_html(content: str) -> HTMLResponse:
    return HTMLResponse(
        content,
        headers={
            "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/api", response_class=HTMLResponse)
@app.get("/api/", response_class=HTMLResponse)
def public_api_docs():
    return _no_store_html(_api_docs_html())


@app.get("/changelog", response_class=HTMLResponse)
@app.get("/changelog/", response_class=HTMLResponse)
def public_changelog():
    return _no_store_html(_changelog_html())

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

from paths import AVATAR_DIR

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
