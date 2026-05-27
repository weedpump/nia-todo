#!/usr/bin/env python3
from pathlib import Path
import importlib.util

ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "api" / "main.py"

source = MAIN.read_text(encoding="utf-8")
start = source.index("def _slugify_heading")
end = source.index("def _document_html", start)
namespace = {"html": __import__("html"), "re": __import__("re")}
exec(source[start:end], namespace)

markdown = """# Test

- Parent
  - Child A
  - Child B
- Sibling

```text
- not a list
  - still code
```
"""

content, _toc = namespace["_markdown_to_html"](markdown)
assert "<li>Parent\n<ul>" in content, content
assert "<li>Child A\n</li>" in content, content
assert "<li>Child B\n</li>" in content, content
assert "</ul>\n</li>\n<li>Sibling" in content, content
assert "<pre><code>- not a list\n  - still code</code></pre>" in content, content
assert '<p>  - Child A</p>' not in content, content
print("✅ Changelog nested list rendering test passed")
