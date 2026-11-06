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
| Sees | A moonlit forest, plus a flashlight (**F**). | A flat, top-down sonar screen. The world appears only where sound sweeps across it. |
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
- **Monster:** standing still makes it drop into a listening crouch and fade out completely for survivors, shadow included. The monster's HUD shows when it is hidden.
- **Survivors:** in monster vision a survivor is drawn only while making noise. Stay silent and within about 1.5 s you vanish completely: ripples pass straight through you.
- **The counter:** the monster's sonar shriek. Every survivor within 30 m flashes up as a white outline for about a second as the wave (14 m/s) reaches them.

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

### Monster vision: a 2D sonar screen (`game.js` → *SOUND RIPPLES + THE MONSTER'S SONAR SCREEN*)
The monster doesn't get a 3D view. It reads a flat, heading-up sonar plate drawn on a 2D canvas over the game, and the 3D scene isn't rendered at all while you play it.
- **The plate:** the wendigo is the arrow at the centre, pointing the way it faces. Range rings mark every 10 m, bearing lines every 30°, with an N marker. Scroll to zoom from 14 to 40 m.
- **Ripples:** sound is up to 48 expanding rings, `(origin, startTime, maxRadius, strength, speed)`. Each ring is drawn, with a bright blip where it started.
- **Obstacles:** trees (trunk dot plus canopy ring), rocks, logs, cabin walls, furniture, the fence and bushes (dashed) appear only where a ring sweeps over them. Each lit shape keeps a ~1 s afterglow, and the monster always senses what's within ~4.5 m. Generators and the gate are always faintly marked.
- **Survivors:** they aren't drawn at all. Their noise shows only as rings and blips (crouching gives small, rare ones, sprinting large, frequent ones). A shriek flashes everyone within 30 m as a white marker.
- **Screen treatment:** scanlines, a vignette, a flash on shrieks, and shake on kills. Spectators who press V get the same screen, plus a red marker for the monster.

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
- **Monster animation:** `game.js` builds the clips at runtime from pose functions.
  - **Locomotion:**
    - **Idle:** ragged breathing, a stalling and snapping head scan, fingers flexing.
    - **Walk:** a limping, lurching stride, arms swinging late and loose, head held eerily level.
    - **Run:** an all-fours gallop.
    - **Stalk:** a folded, owl-like listening crouch with claws tapping.
    - Motion is layered from uneven harmonics of each loop, so it reads as organic while still looping seamlessly.
  - **One-shots:** claw swipes (coil, strike, overshoot), the kill (rear up, slam, bite and wrench the head) and the shriek (convulsions). They play on top of locomotion, triggered by attack, kill and sonar events, so everyone sees the same thing.
  - **Live layer:** on top of the clips, its head turns to track a nearby survivor, random spasms jerk the head, neck and claws, and the claws never stop trembling.
  - **Kill choreography:** the monster and victim turn to face each other, and the victim is drawn into reach. The slam lands on them and they fall away from the monster.
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
