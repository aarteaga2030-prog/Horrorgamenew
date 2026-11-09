#!/usr/bin/env python3
"""Builds foundry/, the upload folder for IDEA Foundry, and blindsight-foundry.zip.

The folder holds only what runs: index.html (with game.js inlined as a module, so the
page also opens straight from the filesystem), style.css and the models. It then checks
the result against the Foundry build contract.

    python3 tools/build-foundry.py
"""
import pathlib, re, shutil, sys, zipfile

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "foundry"
shutil.rmtree(out, ignore_errors=True)
(out / "assets").mkdir(parents=True)

html = (root / "index.html").read_text()
js = (root / "game.js").read_text()
assert "</script" not in js
tag = '<script type="module" src="game.js"></script>'
assert tag in html
html = html.replace(tag, '<script type="module">\n' + js + "\n</script>")
(out / "index.html").write_text(html)
shutil.copy(root / "style.css", out / "style.css")
for name in ("survivor.glb", "monster.glb", "bridge1.glb", "bridge2.glb"):
    shutil.copy(root / "assets" / name, out / "assets" / name)

# ---- Contract checks
ALLOWED = {".html", ".css", ".js", ".json", ".txt", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".glb", ".gltf", ".woff2", ".ttf", ".ico"}
problems = []
files = [f for f in out.rglob("*") if f.is_file()]
for f in files:
    if f.suffix.lower() not in ALLOWED:
        problems.append(f"{f.relative_to(out)}: extension not allowed")
for f in (out / "index.html", out / "style.css"):
    text = f.read_text()
    for m in re.finditer(r"""(?:src|href)\s*=\s*["'](/[^"']*)|url\(\s*["']?(/[^)"']*)""", text):
        problems.append(f"{f.name}: path starts with a slash: {m.group(1) or m.group(2)}")
    for m in re.finditer(r"""(?:src|href)\s*=\s*["'](\.\./[^"']*)|url\(\s*["']?(\.\./[^)"']*)""", text):
        problems.append(f"{f.name}: path climbs above the folder: {m.group(1) or m.group(2)}")
head = html.split("<head>", 1)[1].lstrip()
if not head.startswith("<script>(function(){"):
    problems.append("index.html: the storage snippet is not the first thing in <head>")
for m in re.finditer(r"""(?:local|session)Storage\.(?:get|set|remove)Item\(\s*([^,)]+)""", js):
    if not m.group(1).strip().startswith("STORE +"):
        problems.append(f"storage key without the app prefix: {m.group(1).strip()}")
if problems:
    print("FAILED:\n  " + "\n  ".join(problems)); sys.exit(1)

zpath = root / "blindsight-foundry.zip"
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, f.relative_to(out))
total = sum(f.stat().st_size for f in files)
print(f"foundry/: {len(files)} files, {total / 1e6:.1f} MB; zip {zpath.stat().st_size / 1e6:.1f} MB; contract checks passed")
