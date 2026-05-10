# What's new

- **Resistance: Fall of Man — full pipeline.** Meshes, textures, terrain, ties, gameplay placements, skeletons and animations all working end-to-end. Skinned characters bind correctly and idle / walk / fire clips drive the mesh in preview and exports. Heads up: RFOM ships its assets inside `game.psarc` archives — extract those first with any PSARC unpacker before opening a level.
- **Ratchet & Clank: All 4 One added.** New entry in the game picker, all features working out of the box.
- **Tools of Destruction — skeletons added.** Clank and the rest of the cast show their full bone hierarchy now. Mesh, textures and bones all work. Animation playback is T-pose only for this round — the per-frame format isn't documented anywhere yet.
- **Game picker rebuilt.** Games grouped by franchise, capability badges per game, animated step bar, per-game recent levels.
- **PSARC extraction inside the wizard.** Step 2 has an "Extract a PSARC" path that walks you through extracting one or more archives into the same output folder. Includes per-game tips (R2/R3/V2 need `level_cached.psarc` + `level_uncached.psarc`, RFOM needs `game.psarc` first, ToD varies). Click **Continue →** when you've extracted everything.
- **Auto-open on launch.** Cold start drops you straight into game selection instead of an empty viewport.
- **Loading shows immediately.** Clicking *Open* used to look like the app froze. The progress modal now appears the instant you confirm a folder.
- **Skeleton overlay.** Every preview shows the rig as bright green bone lines so you can see the skeleton at a glance.
- **Cross-game export fixed.** The customisable export (texture quality, armature toggle, animation picker) used to silently fail outside R2 / R3. Works on every supported game now.
- **Cleaner exports.** Characters bind correctly, bones land in the right positions in Blender, animations drive the mesh, and exported GLBs validate clean.

# Game support

| Game | Status |
| --- | --- |
| Resistance 2 | ✅ stable end-to-end |
| Resistance 3 | ✅ stable end-to-end |
| Resistance: Fall of Man | ✅ full pipeline (extract `game.psarc` first) |
| R&C: All 4 One | ✅ added this round, all features working |
| R&C: Full Frontal Assault | ✅ working — a few textures still missing |
| R&C: Tools of Destruction | ⚠️ meshes / textures / skeletons load; animations export T-pose only |

# Install

Pick the bundle below for your OS. Windows users with the previous build installed will see an **Update** button in the title bar — click it to install in place. macOS / Linux still need a manual reinstall from this page.

# Help wanted

- **Testers per game.** Even just running the tool on a level you own and confirming it works is genuinely helpful — the more game / level combinations get tried, the more confident I can be that the parser handles edge cases beyond my own copies. If something breaks (placements off, textures missing, an animation that doesn't drive the mesh, an export that fails), let me know which game and which level so I can reproduce. Logs from the bottom panel are gold.
- **GIFs / screenshots.** Visual examples for the README and the releases page would help people see at a glance what the tool does. Short clips of the MAP loading, an asset preview, or an export-to-Blender flow on any of the games are very welcome — I'll credit you and use them in the docs.

# Bugs / requests

Open a GitHub issue if you can reproduce something, otherwise feel free to DM. I'll answer in my free time.

# Acknowledgements

- [@NefariousTechSupport](https://github.com/NefariousTechSupport) — original Lunacy and the [7thigRewrite](https://github.com/NefariousTechSupport/7thigRewrite) architecture this project draws from.
- [@VELD-Dev](https://github.com/VELD-Dev) — [ReLunacy / LibLunacy](https://github.com/RatchetModding/ReLunacy) (the C# predecessor that the moby / tie / texture decode paths port from).
- [@PredatorCZ](https://github.com/PredatorCZ) — [InsomniaToolset / Spike](https://github.com/PredatorCZ/InsomniaToolset) (canonical reference for IGHW container, RFOM `levelmain` extract, and the V2 GLTF emit pipeline).

Thanks to anyone willing to use, test, or try the tool — every game / level you run through it helps validate the parsers work outside my own small sample.
