# BLINDSIGHT

An asymmetric, peer-to-peer survival horror game for the browser. One player is a **blind monster**; everyone else is a **survivor** trying to escape.

- **Three.js** (r160) renders the game. The two characters are glTF models (see *Assets*); the environment textures and all sounds are generated at runtime.
- **PeerJS** handles networking: one player hosts a room and the others join with a 5-character Room ID.
- There is no build step. Open it with any static file server.

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

> The page has to be served over `http(s)://`. Opening `index.html` as a `file://` URL won't work, because ES modules and WebRTC don't run there.

## How to play

| | Survivors | Monster |
|---|---|---|
| Goal | Repair all 3 generators (hold **E**) to open the exit gate, then escape. Or stay alive until the 5:00 timer runs out. | Catch every survivor (2 hits each). |
| Sees | A moonlit forest, plus a flashlight (**F**). | A dark green wireframe grid. The world is almost invisible until sound lights it up. |
| Movement | **WASD** / arrows. **C** crouch (quiet), **Shift** sprint (loud, uses stamina). | **WASD** / arrows. **Shift** charge. |
| Abilities | Repairing hums, which also makes noise. | **LMB** or **Space** strike. **Q** / **RMB** sonar shriek (reveals everything nearby; survivors hear it). |

**Looking around:** click the game to lock the mouse cursor. If the browser won't allow pointer lock, or on a touch screen, drag across the screen to look instead. Touch is only for looking; movement and actions always come from the keyboard.

### The map
A fenced, 120 m square of night forest:
- **Trees and obstacles:** pines and dead trees, rocks and fallen logs (all solid), plus bushes you can hide behind.
- **Buildings:** a two-room main cabin, a hunting cabin and a shed. Each holds one generator and has lit windows.
- **Camp:** the survivors start around a campfire. Dirt paths link it to the buildings and the exit gate.
- **Exit:** the gate is in the south fence. Once all three generators run, it slides open and the road beyond it is the way out.

**Camouflage:**
- **Monster:** standing still makes it drop into a listening crouch and fade almost completely for survivors. Only a few dithered specks remain, and it casts no shadow. The monster's HUD shows when it is hidden.
- **Survivors:** in monster vision they only stand out while making noise. Still survivors fade back into the environment grid within about 1.5 s, so they look like any other tree or wall when a ripple passes over them.

**Kills:** the monster rears up and slams its claws down, and the survivor falls backward. A survivor who is taken sees it in first person: they're turned to face the monster, then collapse to the floor. The match result waits until the final kill has played out.

Caught or escaped survivors become free-flying spectators and can press **V** to switch to monster vision.

### Playing against bots
**Play vs bot** starts an offline match straight away:
- **Play as survivor**: a bot monster hunts you. It's blind too. It hears you within a radius set by your noise (sprinting ≈ 24 m, walking ≈ 12 m, crouching ≈ 3.6 m), investigates what it heard, and shrieks to reveal you when it loses the trail.
- **Play as monster**: two bot survivors split up to repair generators and run for the exit once the gate opens. When they notice you, they freeze silently, then crouch-sneak away. They only sprint if you're right on top of them or they've been hit. A moving monster is noticed from 14 m away, a still (camouflaged) one only within 4.5 m.

**Custom offline lobby** lets you mix any number of bot survivors with a human or bot monster.

## How it works

### Networking: a host-authoritative star (`game.js` → *NETWORKING*)
- The host registers the peer ID `blindsight-room-<CODE>`, and clients `peer.connect()` to it.
- **Role flags** are set when a player joins: the room creator gets `isMonster: true` and everyone who joins gets `isMonster: false`. The host can reassign roles in the lobby.
- Each client sends `state` (position, yaw, noise level, crouch, repairing) at 20 Hz. The host merges these into a `snap` and broadcasts it at 20 Hz. Remote players are smoothed with exponential interpolation.
- The host decides all game outcomes: hits and HP, generator progress, gate state, escapes, the timer and the win conditions. Clients send intents (`attack`, `repair`, `sonar`, `escape`), and the host replies with `event` messages.

### Monster vision (`game.js` → *MONSTER VISION*)
- Every mesh keeps two materials, its normal `MeshStandardMaterial` and a sonar `ShaderMaterial`. `setViewMode()` swaps them for the whole scene.
- The sonar shader draws a world-space grid (via `fwidth` anti-aliasing) and sums up to 48 **ripples**. Each ripple is an expanding spherical shell, `(origin, startTime, maxRadius, strength, speed)`, kept in a ring buffer of shared uniforms.
- The environment's base brightness is tiny (`0.05`), so static geometry is barely visible. Players have a base brightness of zero: they only appear when a ripple passes over them.
- The monster's client creates ripples from each survivor's synced **noise** level. Crouching gives small, rare ripples (~4 m), walking gives medium ones, and sprinting gives large, frequent ones (~13 m). Repairs, hits, generators and the gate opening send out big pulses.
- Post-processing for the monster view uses UnrealBloom plus a custom CRT pass (scanlines, barrel distortion, chromatic split and vignette). Survivors get a grain/vignette pass with a damage effect and a fear effect when the monster is near.

### Signaling server
By default, PeerJS uses its free public cloud server. To use your own [PeerServer](https://github.com/peers/peerjs-server), add query parameters:

```
?peerHost=my.server.com&peerPort=9000&peerPath=/&peerSecure=1
```

Peer-to-peer connections need STUN to get through NAT. Some strict networks also need a TURN server, which you'd have to add to `peerOptions()`.

## Assets
| File | What it is |
|---|---|
| `assets/survivor.glb` | [Survivor [Toon-Style]](https://sketchfab.com/3d-models/survivor-toon-style-5aa13349079141d0927b8ea96e1349c4) by lalit (CC BY 4.0). Skinned, with one "Walk + Idle" clip that the game splits into a walk loop and an idle loop. |
| `assets/monster.glb` | Rigged, game-ready version of [Wendigo](https://sketchfab.com/3d-models/wendigo-inspired-by-until-dawn-d46093a707a24444af1ed7d10aa7198f) by marc3_C (CC BY 4.0), built by `tools/optimize-monster.mjs`: 23 MB → 2.9 MB, scaled to 7 ft (2.13 m), with a 23-bone skeleton and skin weights, and textures at 1024 px WebP. |
| `assets/source/wendigo-original.glb` | The original wendigo upload, kept as the source for the optimizer. |

Notes:
- **Survivor file:** as uploaded, it is truncated (its ambient-occlusion texture runs past the end of the file), so the reference to that texture was removed.
- **Survivor material:** it uses the spec-gloss material extension, which three.js no longer reads, so the game re-applies its diffuse texture in code.
- **Monster rig:** the source wendigo had no skeleton, so the optimizer auto-rigs it.
  - It measures joint positions by slicing the T-posed mesh: the legs separate below the crotch, the arms are thinnest at the elbow and wrist, and the claws fan out past the hand.
  - It builds a 23-bone humanoid skeleton: hips, spine, chest, neck, head, and clavicles, upper arms, forearms, hands, claws, thighs, shins, feet and toes on each side.
  - It skins every vertex to up to four bones, with smooth blends across each joint.
- **Monster animation:** `game.js` builds the clips at runtime from pose functions: idle, walk, run, stalk (the still/listening crouch), left and right claw swipes, kill and shriek.
  - Locomotion blends by speed and stillness.
  - Swipes, the kill and the shriek play on top, triggered by attack, kill and sonar events, so everyone sees the same animation.
- **Survivor animation:** the walk/idle clips are blended by speed. Crouch, sprint lean, repairing, hit flinch and the death fall are layered on top as procedural bone rotations.

## Playtest build (Claude artifact)
`play.html` is an embeddable copy of the page used to publish a playtest build as a Claude artifact. Regenerate it after editing `index.html`:

```bash
python3 tools/build-play.py   # writes play.html and build/assets/*.glb.json
```

The artifact host serves only web file types, so the build wraps each `.glb` as base64 inside a `.json` file, and `game.js` decodes it when `window.BLINDSIGHT_EMBED` is set. Embedded pages can't use WebRTC, so the artifact build plays against bots only and hides online rooms.

## Files
- `index.html`: the page layout, CDN imports (import map for Three.js, a script tag for PeerJS), the menu and the HUD.
- `style.css`: the UI styling.
- `game.js`: everything else, including the map, rendering, shaders, model loading, networking, gameplay, audio and bot AI.
- `play.html`: the generated artifact build (see above).
- `tools/`: `build-play.py` (artifact build) and `optimize-monster.mjs` (model pipeline).
