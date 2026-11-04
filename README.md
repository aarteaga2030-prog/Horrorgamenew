# BLINDSIGHT

An asymmetric, peer-to-peer survival horror game for the browser. One player is a **blind monster**; everyone else is a **survivor** trying to escape.

- **Three.js** (r160) renders the game; there are no external assets, and all textures and sounds are generated at runtime.
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
| Sees | A normally lit 3D facility, plus a flashlight (**F**). | A dark green wireframe grid. The world is almost invisible until sound lights it up. |
| Movement | **WASD** + mouse. **C** crouch (quiet), **Shift** sprint (loud, uses stamina). | **WASD** + mouse. **Shift** charge. |
| Abilities | Repairing hums, which also makes noise. | **LMB** strike. **Q** / **RMB** sonar shriek (reveals everything nearby; survivors hear it). |

Caught or escaped survivors become free-flying spectators and can press **V** to switch to monster vision.

**Practice offline** runs the game without any network. You can add bot survivors that wander around making noise, which is a good way to try out the monster view on your own.

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

## Files
- `index.html`: the page layout, CDN imports (import map for Three.js, a script tag for PeerJS), the menu and the HUD.
- `style.css`: the UI styling.
- `game.js`: everything else, including the map, rendering, shaders, networking, gameplay, audio and bots.
