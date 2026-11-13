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

## Game modes
Pick the mode in the menu (the host picks for an online room).

| Mode | Survivors win by | Monster wins by |
|---|---|---|
| **Escape** | Restoring 4 of the 5 generators (each one's circuits are wired in a pipe puzzle), opening the gate and getting out, or lasting 5:30 until dawn | Taking everyone |
| **Ritual** | Finding 5 relics (random spots each match), then banishing it at the stone circle (a long, loud channel) | Taking everyone, or dawn arriving at 6:00 with the ritual unfinished |
| **Last Light** | Staying alive for 3:20. Every 40 s the moon exposes everyone who isn't hidden | Taking everyone |

With three or more survivors each generator needs 3 circuits instead of 2, and the altar takes longer, so team size stays fair.

### Generators: wiring the circuits
- **The panel:** press **E** at a generator to open its panel: a grid of coloured valves (5×5 for the first circuit, 6×6 after). Drag from a valve to draw a pipe to the valve of the same colour. Pipes can't cross; dragging over another pipe cuts it, and dragging back along your own pipe pulls it back. Every puzzle is generated fresh and always has a solution.
- **Circuits:** each solved panel restores one circuit (2 per generator, 3 with three or more survivors). The LEDs on the generator light green one by one, and when the last circuit kicks in the generator roars to life, puffs exhaust and lights the pole lamps along its power line toward the gate.
- **The risk:** you can't move or look around while the panel is open, the generator hums the whole time, and every restored circuit clangs loud enough for the monster to hear. **E**, **Esc** or any movement key steps away (you lose the panel you were on). Getting hit closes it.
- **Sabotage:** the monster can strike a half-wired generator to rip a circuit back out (once every 18 s per generator), in a shower of sparks.
- **The gate** opens once 4 of the 5 generators run. The fifth is spare.

### Sound and masking
The forest is never quiet:
- **Random sounds:** about every 2.5–7.5 s a sound plays somewhere on the map: a snapping branch, a creaking trunk, an owl, a crow, a rustle in the brush, a splash in the creek, or (rarely) the chapel bell. Survivors hear it from its direction. The monster sees it as a ripple like any other, and the bot monster sometimes goes to check the loud ones.
- **Wind gusts:** every 20–45 s the wind rises for 5–10 s. The wind sound swells and the grass bends.
- **Nothing is masked:** every sound, from a survivor, the forest or a thrown stone, sends a ring that travels all the way to the edges of the map, fading as it spreads. Crouching is quieter (a faint ring) but never hidden. The survivor HUD's noise bar shows how loud you are.

### Hiding places
Twenty-two spots, each looked out of differently (your own hiding place is invisible to you and your flashlight goes off, so you watch through its gaps):
- **Metal lockers:** main cabin, hunting cabin, chapel ×2, sawmill.
- **Wardrobes:** main cabin (west room), shed, the barn's tack cabinet.
- **Tents:** three at the camp, lying low and looking out through the tied-back flaps.
- **Outhouses:** by the camp and by the tower.
- **Crypts** in the graveyard and in the ruins, seen through an iron grille.
- **The wrecked truck's cab**, seen through the windshield.
- **Hollow logs:** near the stone circle and in the east woods. You lie low and look out of the end.
- **Crates:** north, east, west and south-west woods.

### First person
Both roles see their own hands:
- **Survivors:** the flashlight is in the right hand, and the hands bob with your stride, pump when you sprint, reach in when you repair and jolt when you're hit.
- **The monster:** its long claws reach into the bottom of the view, swing with its stride, and rake across on strikes. Its head and legs are folded away so the view is clean. When it charges it drops onto all fours: the view sinks low, bounds with each stride, jolts as its paws land, widens and smears at the edges, and its claws swing up into view and pound the ground ahead.

### Animation
- **The monster's gallop:** at a full charge it doesn't run upright. It drops onto all fours and bounds: spine pitched nearly flat and flexing with each stride, its long arms reaching out and slamming down as front legs, its hind legs driving underneath. The gait is procedural (the spine and neck are bent in world space and each limb is placed on the ground by two-bone IK, so it works on slopes), blended over its clips by speed. You hear the paws hit the ground in pairs.
- **The rest of its body:** idle, walk and attack clips with live layers on top: turn banking, stop-motion stutter, head tracking toward a survivor who is watching, random spasms, finger tremor, and a listening crouch when it stands still.
- **Survivors:** sprinting survivors lean in, bend their elbows and pump their arms against their stride, and glance back over a shoulder when it is chasing them.

### Survivor tools
- **Hide (E):** step into a locker or outhouse. You make no sound and can't be seen or exposed, for up to 15 s of held breath (8 s to recover). The monster can still tear a hiding place open if it strikes it.
- **Stones (G):** three per match. A stone lands 15 m ahead and clacks, a decoy noise the monster hears like any other.
- **Warnings:** your flashlight falters when it is within 11 m, you hear its clicking and breathing, a pulse when it charges, and a far-off howl now and then that gives its rough bearing. Its red eyes still glint faintly when it's camouflaged.

## How to play

| | Survivors | Monster |
|---|---|---|
| Goal | Restore 4 of the 5 generators (**E** opens a generator's pipe puzzle) to open the exit gate, then escape. Or stay alive until the 5:30 timer runs out. | Catch every survivor (2 hits each). |
| Sees | A moonlit forest, plus a flashlight (**F**). | Echo vision: a dim green grid of light cast from its own eyes. Everything looks the same until sound gives it shape, and its ripples trace survivors it passes over. |
| Movement | **WASD** / arrows. **C** crouch (quiet), **Shift** sprint (loud, uses stamina). | **WASD** / arrows. **Shift** charge (on all fours). |
| Abilities | Working a generator hums, and each restored circuit clangs. | **LMB** or **Space** strike (also rips a circuit out of a half-wired generator). **Q** / **RMB** sonar shriek (lights up every unhidden survivor within 42 m; survivors hear it). |

**Looking around:** click the game to lock the mouse cursor. If the browser won't allow pointer lock, or on a touch screen, drag across the screen to look instead. Touch is only for looking; movement and actions always come from the keyboard.

### Balance
Survivors can outplay a human monster:
- **Speed:** the monster walks faster than a survivor (4.3 vs 3.4) and its all-fours charge (6.6) outruns a survivor's sprint (6.0). Its charge lasts 5.5 s and recovers quickly, so survivors have to break line of sound (hide, crouch, decoy) rather than outrun it.
- **Hearing:** a human monster hears any noise from anywhere on the map. Louder movement makes bigger, more frequent ripples; only standing still, hiding, or a thrown stone elsewhere covers you. The bot monster is limited to range (sprinting ≈ 24 m, walking ≈ 12 m, crouching ≈ 3.6 m), because with unlimited hearing it took every bot survivor in every test match.
- **Strike:** reach 2.3 m and a 1.6 s cooldown. After a hit, the survivor gets a 3 s speed boost and 2.5 s of invulnerability.
- **Shriek:** finds every survivor within 42 m who isn't hidden, on a 14 s cooldown. Each one flares up in monster vision as the wave reaches them and stays lit for a few seconds, and they're warned that it found them. Hiding places protect you.
- **Sabotage:** a strike on a half-wired generator undoes one circuit, at most once every 18 s per generator.
- **Camouflage:** builds only after 1.2 s of stillness, never goes fully invisible (a faint shimmer remains), and a survivor's flashlight beam on it within 14 m breaks it.

### The map
A fenced, 120 m square of night forest:
- **Terrain:** the forest floor rolls in low rises and hollows, and beyond the fence the land climbs into ridges (the creek and the road out run through valleys). Everything built sits on level ground that blends into the hills.
- **Trees and obstacles:** pines and dead trees, rocks and fallen logs (all solid), plus bushes you can hide behind.
- **Buildings and generators:** five generators, one in each of:
  - the two-room **main cabin**, the **hunting cabin** and the **shed** (lit windows);
  - the **old barn**, dark inside, with chest-high stall walls to crouch behind, hay bales, and doors on two sides;
  - the open-sided **sawmill**, with a log carriage down the middle, a great saw blade (it spins once its generator runs) and stacks of lumber.
- **The ruins:** a broken stone keep north of the main cabin, with walls of every height (some you can see over standing, some only crouched), doorways, a collapsed arch and a hollow tower stump.
- **Power lines:** poles carry lines from every generator back to a transformer by the gate. A pole's lamp lights once a generator down its line is running, and the transformer turns green when the gate has power.
- **Camp:** the survivors start around a campfire, ringed by three tents. Dirt paths link it to the buildings and the exit gate, and trails reach the barn, the sawmill and the ruins.
- **The creek:** it winds across the whole forest under low drifting mist.
  - **Wading:** slow (60% speed, 80% for the monster) and loud: splashing counts as noise even when crouched.
  - **Bridges:** broken plank bridges carry the paths over it. They're the quiet way across, though their boards creak a little.
  - **Bots** always use the bridges.
- **Landmarks:** a chapel with a steeple and graveyard, a ranger watchtower with a sweeping searchlight, a ring of standing stones with an altar, a wrecked truck by the gate, and lamp posts along the paths (one is dying).
- **Hiding places:** see *Hiding places* above.
- **Atmosphere:** drifting clouds across a moonlit sky, lightning and thunder, swaying grass, fireflies, campfire embers, moving water, bloom and colour grading.
- **Exit:** the gate is in the south fence. Once four generators run, it slides open and the road beyond it is the way out.

**Camouflage:**
- **Monster:** standing still makes it drop into a listening crouch and fade out completely for survivors, shadow included. The monster's HUD shows when it is hidden.
- **Survivors:** in monster vision, a still, silent survivor is drawn exactly like everything else, in the same dim grid with no outline or highlight. They're just more surface. When sound passes over them (their own noise, the monster's footsteps, or its sonar shriek, a 42 m wave that lights up everyone it finds), its ripple rings wrap around their body in the same green as everything else, tracing their shape for a moment before fading. There's no glow or outline. The louder the sound, the brighter the rings, so a crouched step leaves only faint ones.

**Kills:** the monster rears up and slams its claws down, and the survivor falls backward. A survivor who is taken sees it in first person: they're turned to face the monster, then collapse to the floor. The match result waits until the final kill has played out.

Caught or escaped survivors become free-flying spectators and can press **V** to switch to monster vision.

### Playing against bots
**Play vs bot** starts an offline match straight away:
- **Play as survivor**: a bot monster hunts you, and it's blind too.
  - **Hearing:** it hears you within a radius set by your noise (sprinting ≈ 24 m, walking ≈ 12 m, crouching ≈ 3.6 m).
  - **Pace:** it prowls slowly between generators (favouring half-wired ones, which it tears into when it gets there) and stops every few seconds to listen, fading from sight while it does.
  - **Hunting:** it creeps toward what it heard, and only gallops in a short charge at a fresh, close sound.
  - **Lost trail:** where it last heard you it listens, shrieks, then sweeps the area. Once the gate opens it guards it.
- **Play as monster**: two bot survivors who play by stealth.
  - **What they know:** only what they could really see or hear. That's a moving monster within 14 m, a still one within 4 m, its charging footsteps within 22 m, and its shriek.
  - **Reacting:** when they notice you, they freeze silently, then creep away sideways in a crouch.
  - **Sprinting:** only in a short burst when you charge right at them or hit them, then they go quiet again.
  - **Generators:** they wire one circuit at a time (8–13 s each) and lose the one in progress if they're scared off.
  - **Caution:** they won't work a generator (the hum carries ~13 m) while you were recently nearby, move crouched for a while after a scare, pause to look around, and wait out a guarded gate.

**Custom offline lobby** lets you mix any number of bot survivors with a human or bot monster.

## How it works

### Networking: a host-authoritative star (`game.js` → *NETWORKING*)
- The host registers the peer ID `blindsight-room-<CODE>`, and clients `peer.connect()` to it.
- **Role flags** are set when a player joins: the room creator gets `isMonster: true` and everyone who joins gets `isMonster: false`. The host can reassign roles in the lobby.
- Each client sends `state` (position, yaw, noise level, crouch, repairing) at 20 Hz. The host merges these into a `snap` and broadcasts it at 20 Hz. Remote players are smoothed with exponential interpolation.
- The host decides all game outcomes: hits and HP, generator circuits, sabotage, gate state, escapes, the timer and the win conditions. Clients send intents (`attack`, `repair`, `solve`, `sonar`, `escape`), and the host replies with `event` messages. The pipe puzzle itself runs on the survivor's own client; the host checks the survivor is at the generator and takes at most one solved panel per 2.4 s from each player.

### Monster vision (`game.js` → *MONSTER VISION*)
- Every mesh keeps two materials, its normal `MeshStandardMaterial` and a sonar `ShaderMaterial`. `setViewMode()` swaps them for the whole scene.
- **The grid is cast from the monster's eyes.** Lines are laid out by viewing angle (yaw and pitch from the camera, every 1.6°), not on each surface. They run unbroken across ground, trees and bodies, with no perspective foreshortening to show the shape or slope of anything.
- **In silence, depth is deliberately poor.** There's no shading, no distance falloff and no outlines. A grid-lit shell around the world, seen only in monster vision, continues the same grid past the treetops, so nothing shows as a silhouette against the sky.
- **Sound is what gives things shape.** The shader sums up to 64 **ripples**. Each ripple is an expanding spherical shell, `(origin, startTime, maxRadius, strength, speed)`, kept in a ring buffer of shared uniforms.
  - **Wavefront:** a razor-thin, white-hot edge that glitters as it passes, with a broader band behind it. The loudest sounds bleach toward white.
  - **Resonance:** a surface keeps ringing after the front passes and fades over `uHold` seconds. This is worked out in the shader from the time since the front went by, so it needs no extra buffers.
  - **Shape while ringing:** contour rings of equal distance from the sound drift slowly outward, bending over whatever they land on. Surfaces that face the sound echo harder than ones turned away, so trunks, walls and slopes read as solid shapes.
- **Ripples show more on bodies.** Survivors (and the monster, for spectators) use the `entity` sonar material: same colour, grid and brightness as the world, so a silent body is just more surface. The only difference is how a passing sound draws on them: its contour rings are about 3× tighter (`uRingScale`), brighter (`uRingGain`) and even all the way round (`uRingFace` = 0), and they ring a little longer (`uHold` 0.8 s). Without this, a survivor's own step crossed their body in about two frames and never showed on them.
- The monster's client creates ripples from each survivor's synced **noise** level. Crouching gives small, rare ripples (~4 m), walking gives medium ones, and sprinting gives large, frequent ones (~13 m). Repairs, hits, generators and the gate opening send out big pulses.
- The monster view is finished with UnrealBloom and a custom CRT pass: scanlines, barrel distortion, chromatic split, a slow radar sweep line, a shockwave ring that races out when it shrieks, the picture tearing when its strike lands, dark veins at the rim of its vision that swell with its heartbeat (which races when it charges), and the edges smearing back while it gallops.
- **Sound compass:** a faint ring around the monster's view shows an arc in the direction of every sound it hears, brighter and thicker for louder sounds and wider for nearer ones, so it can turn toward a noise behind it.
- Survivors get a grain/vignette pass with a damage effect and a fear effect when the monster is near.

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

## IDEA Foundry build
`python3 tools/build-foundry.py` writes `foundry/` (the upload folder) and `blindsight-foundry.zip`, then checks them against the Foundry build contract: served file types only, relative paths, the storage snippet first in `<head>`, and prefixed storage keys (`blindsight:`).
- `game.js` is inlined into `index.html`, so the page also opens straight from the filesystem.
- Foundry can't serve `.glb`, so each model ships as base64 inside plain `.js` files (at most 3 MB each) loaded by script tags. `game.js` reads them from `window.BLINDSIGHT_MODELS`. That works from the filesystem too.

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
- `tools/`: `build-foundry.py` (IDEA Foundry upload folder), `build-play.py` (artifact build) and `optimize-models.sh` (texture compression for the models).
