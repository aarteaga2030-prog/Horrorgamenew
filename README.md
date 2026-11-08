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

## Playing online with friends
The game is published to **GitHub Pages** by `.github/workflows/pages.yml` on every push to `main`: https://aarteaga2030-prog.github.io/Horrorgamenew/

**One-time setup:** in the repository's **Settings → Pages**, set **Source** to **GitHub Actions**. Then merge to `main` (or run the workflow by hand from the Actions tab).

**To play:**
1. One player opens the site and clicks **Host room**.
2. They click **Copy invite link** and send it to friends.
3. Opening the link joins the room automatically, with no code to type. The 5-character Room ID still works with **Join** too.
4. The host picks the monster (or **Random monster**), can fill empty seats with **Add bot survivor** / **Add bot monster**, and clicks **Start game**.

## How to play

| | Survivors | Monster |
|---|---|---|
| Goal | Repair all 3 generators (hold **E**) to open the exit gate, then escape. Or stay alive until the 5:00 timer runs out. | Catch every survivor (2 hits each). |
| Sees | A moonlit forest, plus a flashlight (**F**). | A dim green grid of light cast from its own eyes. Everything looks the same until sound lights it up. |
| Movement | **WASD** / arrows. **C** crouch (quiet), **Shift** sprint (loud, uses stamina). | **WASD** / arrows. **Shift** charge. |
| Abilities | Repairing hums, which also makes noise. | **LMB** or **Space** strike. **Q** / **RMB** sonar shriek (reveals everything nearby; survivors hear it). |

**Looking around:** click the game to lock the mouse cursor. If the browser won't allow pointer lock, or on a touch screen, drag across the screen to look instead. Touch is only for looking; movement and actions always come from the keyboard.

### Balance
Survivors can outplay a human monster:
- **Speed:** the monster walks slower than a survivor (3.9 vs 3.4 walk, but survivors sprint at 6.0 against its 5.6 charge). Its charge lasts 2.5 s against a survivor's 5 s sprint, and its stamina recovers more slowly.
- **Hearing range:** the monster only hears noise in range, the same rule as the bot. Sprinting carries ~24 m, walking ~12 m, crouching ~3.6 m. Noise beyond that never appears on its screen.
- **Strike:** reach 2.3 m and a 1.6 s cooldown. After a hit, the survivor gets a 3 s speed boost and 2.5 s of invulnerability.
- **Shriek:** reaches 24 m, on a 20 s cooldown.
- **Camouflage:** builds only after 1.2 s of stillness, never goes fully invisible (a faint shimmer remains), and a survivor's flashlight beam on it within 14 m breaks it.

### The map
A fenced, 120 m square of night forest:
- **Trees and obstacles:** pines and dead trees, rocks and fallen logs (all solid), plus bushes you can hide behind.
- **Buildings:** a two-room main cabin, a hunting cabin and a shed. Each holds one generator and has lit windows.
- **Camp:** the survivors start around a campfire. Dirt paths link it to the buildings and the exit gate, and a trail links the two cabins.
- **The creek:** it winds across the whole forest under low drifting mist.
  - **Wading:** slow (60% speed, 80% for the monster) and loud: splashing counts as noise even when crouched.
  - **Bridges:** broken plank bridges carry the paths over it. They're the quiet way across, though their boards creak a little.
  - **Bots** always use the bridges.
- **Exit:** the gate is in the south fence. Once all three generators run, it slides open and the road beyond it is the way out.

**Camouflage:**
- **Monster:** standing still makes it drop into a listening crouch and fade out completely for survivors, shadow included. The monster's HUD shows when it is hidden.
- **Survivors:** in monster vision, survivors are drawn exactly like everything else, in the same dim grid with no outline or highlight. A still, silent survivor is just more surface. They only stand out when sound passes over them: their own noise, the monster's footsteps, or its sonar shriek (a 30 m wave).

**Kills:** the monster rears up and slams its claws down, and the survivor falls backward. A survivor who is taken sees it in first person: they're turned to face the monster, then collapse to the floor. The match result waits until the final kill has played out.

Caught or escaped survivors become free-flying spectators and can press **V** to switch to monster vision.

### Playing against bots
**Play vs bot** starts an offline match straight away:
- **Play as survivor**: a bot monster hunts you, and it's blind too.
  - **Hearing:** it hears you within a radius set by your noise (sprinting ≈ 24 m, walking ≈ 12 m, crouching ≈ 3.6 m).
  - **Pace:** it prowls slowly between generators (favouring ones mid-repair) and stops every few seconds to listen, fading from sight while it does.
  - **Hunting:** it creeps toward what it heard, and only gallops in a short charge at a fresh, close sound.
  - **Lost trail:** where it last heard you it listens, shrieks, then sweeps the area. Once the gate opens it guards it.
- **Play as monster**: two bot survivors who play by stealth.
  - **What they know:** only what they could really see or hear. That's a moving monster within 14 m, a still one within 4 m, its charging footsteps within 22 m, and its shriek.
  - **Reacting:** when they notice you, they freeze silently, then creep away sideways in a crouch, which is too quiet for you to hear beyond ~3.6 m.
  - **Sprinting:** only in a short burst when you charge right at them or hit them, then they go quiet again.
  - **Caution:** they won't repair (the hum carries ~13 m) while you were recently nearby, move crouched for a while after a scare, pause to look around, and wait out a guarded gate.

**Custom offline lobby** lets you mix any number of bot survivors with a human or bot monster.

## How it works

### Networking: a host-authoritative star (`game.js` → *NETWORKING*)
- The host registers the peer ID `blindsight-room-<CODE>`, and clients `peer.connect()` to it.
- **Role flags** are set when a player joins: the room creator gets `isMonster: true` and everyone who joins gets `isMonster: false`. The host can reassign roles in the lobby.
- Each client sends `state` (position, yaw, noise level, crouch, repairing) at 20 Hz. The host merges these into a `snap` and broadcasts it at 20 Hz. Remote players are smoothed with exponential interpolation.
- The host decides all game outcomes: hits and HP, generator progress, gate state, escapes, the timer and the win conditions. Clients send intents (`attack`, `repair`, `sonar`, `escape`), and the host replies with `event` messages.

### Monster vision (`game.js` → *MONSTER VISION*)
- Every mesh keeps two materials, its normal `MeshStandardMaterial` and a sonar `ShaderMaterial`. `setViewMode()` swaps them for the whole scene.
- **The grid is cast from the monster's eyes.** Lines are laid out by viewing angle (yaw and pitch from the camera, every 1.6°), not on each surface. They run unbroken across ground, trees and bodies, with no perspective foreshortening to show the shape or slope of anything.
- **Depth is deliberately poor.** There's no shading, no distance falloff and no outlines. A grid-lit shell around the world, seen only in monster vision, continues the same grid past the treetops, so nothing shows as a silhouette against the sky.
- **Sound is what reveals things.** The shader sums up to 48 **ripples**. Each ripple is an expanding spherical shell, `(origin, startTime, maxRadius, strength, speed)`, kept in a ring buffer of shared uniforms, and it brightens whatever surface it crosses.
- **Players get no special treatment.** Survivors (and the monster, for spectators) use the same material as the world.
- The monster's client creates ripples from each survivor's synced **noise** level. Crouching gives small, rare ripples (~4 m), walking gives medium ones, and sprinting gives large, frequent ones (~13 m). Repairs, hits, generators and the gate opening send out big pulses.
- The monster view is finished with UnrealBloom and a custom CRT pass (scanlines, barrel distortion, chromatic split and vignette). Survivors get a grain/vignette pass with a damage effect and a fear effect when the monster is near.

### Signaling server
By default, PeerJS uses its free public cloud server. To use your own [PeerServer](https://github.com/peers/peerjs-server), add query parameters:

```
?peerHost=my.server.com&peerPort=9000&peerPath=/&peerSecure=1
```

Connections use Google's public STUN servers to find each player's address, plus the free Open Relay TURN service (`ICE_SERVERS` in `game.js`) to relay traffic for players behind strict NATs, such as many mobile networks. For a busy deployment, swap in your own TURN server there.

## Assets
| File | What it is |
|---|---|
| `assets/survivor.glb` | [Survivor [Toon-Style]](https://sketchfab.com/3d-models/survivor-toon-style-5aa13349079141d0927b8ea96e1349c4) by lalit (CC BY 4.0). Skinned, with one "Walk + Idle" clip that the game splits into a walk loop and an idle loop. |
| `assets/monster.glb` | [Zoonomaly Monster 2 Rig](https://sketchfab.com/NO.DONT.EAT.ME.CASEOH) by NO DONT EAT ME CASEOH (CC BY 4.0): rigged (31 bones) with idle, walk, fast-walk, three attacks, hit and jumpscare clips. Textures resized to 1024 px WebP; geometry, rig and animation untouched. |
| `assets/bridge1.glb`, `assets/bridge2.glb` | Forest wooden path-bridge tiles (broken 1 and 2) by [Frice](https://sketchfab.com/Frice) (**CC BY-NC 4.0: non-commercial use only**). Textures resized to 1024 px WebP. |
| `assets/source/` | The original uploads: the monster, the bridge tiles, and the old wendigo (no longer used). `tools/optimize-models.sh` rebuilds `assets/` from them. |

Notes:
- **Survivor file:** as uploaded, it is truncated (its ambient-occlusion texture runs past the end of the file), so the reference to that texture was removed.
- **Survivor material:** it uses the spec-gloss material extension, which three.js no longer reads, so the game re-applies its diffuse texture in code.
- **The monster player's own body:** when you play the monster you see your creature in first person, in the same sonar style. Look down to see it; its arms swing as you walk, a claw rakes up across the screen when you strike, and it convulses when you shriek.
- **Monster animation:** the model's own clips, driven by a controller in `game.js`.
  - **Locomotion:** idle, walk and fast walk blend by speed. Playback is stride-matched to how fast it's actually moving, so its feet don't skate.
  - **One-shots:**
    - Attacks pick one of the three attack clips at random.
    - Kills play the **Jumpscare**: it leaps in, drives the victim down, and crouches over them face to face.
    - The sonar shriek plays the start of **Hit** as a convulsion.
    - A generator roaring to life or the gate opening nearby makes it flinch (a short Hit).
  - **Dynamic layer**, on top of the clips:
    - It banks into turns and pitches with acceleration.
    - It moves with stop-motion stutters: random micro-freezes, then a lurch to catch up.
    - Its idle speed drifts, so the loop never repeats exactly.
    - Its head turns in world space to track a survivor watching it from within 16 m.
    - Random spasms jerk its head, neck, forearms and hands, and its fingers tremble.
  - **Kill choreography:** the monster and victim turn to face each other, and the victim is drawn into reach. The victim's kill cam rides the model's own jumpscare **camera bone**, staring into its face (kept at least 1.1 m away), and the match result waits for it to finish.
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
- `tools/`: `build-play.py` (artifact build) and `optimize-models.sh` (texture compression for the models).
