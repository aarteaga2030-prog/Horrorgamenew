#!/usr/bin/env python3
"""Builds foundry/, the upload folder for IDEA Foundry, and blindsight-foundry.zip.

The folder holds only what runs: index.html (with game.js inlined as a module, so the
page also opens straight from the filesystem), style.css and the models as base64 .js
files (the platform cannot serve .glb). It then checks
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
# Foundry cannot serve .glb, so each model ships as base64 inside plain .js files (at most
# 3 MB each), loaded by script tags ahead of the game. game.js reads window.BLINDSIGHT_MODELS.
import base64, json
CHUNK = 3_000_000
tags = ['<script>window.BLINDSIGHT_MODELS = {};</script>']
for name in ("survivor.glb", "monster.glb", "bridge1.glb", "bridge2.glb"):
    b64 = base64.b64encode((root / "assets" / name).read_bytes()).decode()
    key = "assets/" + name
    for i in range(0, len(b64), CHUNK):
        fn = f"assets/{name[:-4]}-{i // CHUNK + 1}.js"
        (out / fn).write_text(f"(window.BLINDSIGHT_MODELS[{json.dumps(key)}] = window.BLINDSIGHT_MODELS[{json.dumps(key)}] || []).push({json.dumps(b64[i:i + CHUNK])});\n")
        tags.append(f'<script src="{fn}"></script>')
marker = '<script type="module">'
html = html.replace(marker, "\n  ".join(tags) + "\n  " + marker, 1)
(out / "index.html").write_text(html)

# ---- Contract checks
ALLOWED = {".html", ".css", ".js", ".json", ".txt", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".mp3", ".wav", ".ogg", ".woff2", ".ttf", ".ico"}  # what the platform actually serves
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
