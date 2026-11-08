#!/usr/bin/env bash
# Rebuilds the game-ready models in assets/ from the originals in assets/source/.
# They keep their geometry, rig and animations; only textures are resized to
# 1024 px and re-encoded as WebP so the game (and the artifact build) loads fast.
# Needs: npm i -g @gltf-transform/cli
set -euo pipefail
cd "$(dirname "$0")/.."
build() { # build <source> <output>
  local tmp; tmp="$(mktemp --suffix=.glb)"
  gltf-transform resize "assets/source/$1" "$tmp" --width 1024 --height 1024
  gltf-transform webp "$tmp" "assets/$2"
  rm -f "$tmp"
}
build zoonomaly-monster-2.glb monster.glb
build bridge-tile-1.glb bridge1.glb
build bridge-tile-2.glb bridge2.glb
