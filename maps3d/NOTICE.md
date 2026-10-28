# Where these files come from

`maps3d/` holds map geometry, textures, lightmaps, prop placements and sounds of Call of Duty 4
multiplayer maps. **None of it was authored here.** It is Activision's / Infinity Ward's work
(and, for usermaps such as `mp_cluster` and `mp_backlot_x`, their authors'), extracted from a
legally owned copy of the game with `tools/export/export_maps.py`.

| Files | Source |
|---|---|
| `<map>/world.bin`, `world.json` | The compiled render world (GfxWorld) in `zone/<language>/<map>.ff` (or `usermaps/<map>/<map>.ff`) |
| `<map>/lightmap*.webp` | The baked lightmaps embedded in the same fast file (`*_secondary.webp` / `*_primary.webp`: as stored, `lightmap<N>.webp`: a composite of them) |
| `<map>/lightgrid.bin`, `lightgrid_colors.webp` | The light grid (model lighting, `GfxLightGrid`) of the same render world: grid points, their colour sets (all 56 colours, and six-colour summaries) |
| `world.json` → `lights` | The map's primary lights (`ComWorld`) of the same fast file; the falloff ramps from `main/iw_01.iwd` (`images/falloff_*.iwi`) |
| `<map>/sight.bin` | The sight-blocking brushes and terrain triangles of the map's collision model (`clipMap_t`) in the same fast file |
| `<map>/probes.webp` | The reflection probe cube maps (`GfxReflectionProbe`) embedded in the same fast file, level 0 only |
| `<map>/cells.bin` | The DPVS cell tree of the same render world with each cell's reflection probes |
| `<map>/props.*`, `<map>/props_coll.bin` | Static model placements, the model geometry (with the vertex colours) and the models' collision surfaces (XModels) of the same fast file; models the map does not store come from `zone/<language>/common_mp.ff`; a surface whose material the map's zone does not resolve takes the same model's material from another map's fast file, or the material of a surface of another model with the same triangles and UVs (`materialTwin`) |
| `<map>/audit.json` | The asset audit of the map (`tools/audit/asset_audit.py`): status and issues per asset, derived from the same fast file and the files above - no game data of its own |
| `<map>/sky.webp` | The sky cube map the render world names (`skyImage`), from `main/*.iwd` (`images/<name>.iwi`), downscaled |
| `<map>/fx.json` | The map's effect placements (rawfiles `maps/createfx/<map>_fx.gsc`, `maps/mp/<map>_fx.gsc`), its impact table (`FxImpactTable`) and the effect definitions (`FxEffectDef`) of the same fast file |
| `_fx/common.json` | The effect definitions of `zone/<language>/common_mp.ff` the demos play (the weapons' muzzle flashes and explosions, the impact effects, the gametype scripts' effects) and the weapons' effect names (weapon files of the same fast file) |
| `<map>/entities.json`, `<map>/script_coll.bin` | The map entity string of the same fast file (spawns, bomb sites, script models) and the collision surfaces of the script models' XModels |
| `_sound/aliases.json`, `<map>/sounds.json` | The sound alias lists (`snd_alias_list_t`) of `zone/<language>/localized_common_mp.ff` and of the map fast file, the channel table (rawfile `soundaliases/channels.def` of `code_post_gfx_mp.ff`), the weapons' sound names (WeaponDefs of `common_mp.ff`) and the map's createfx loop sounds |
| `_sound/**/*.wav`, `*.mp3` | The audio of those aliases: loaded sounds from the same fast files (16-bit PCM, re-encoded as IMA ADPCM), streamed sounds from `main/*.iwd` (`sound/...`; WAV re-encoded as IMA ADPCM, MP3 copied) |
| `_characters/*` | Player models (body and head XModels with skeleton, skin weights and the bones' hit boxes) of the map fast files; player animations (`anims.json`, `anims.bin`, `anims/*.bin`, XAnimParts; the anim tree in `anims.json` is derived from the rawfiles `animtrees/multiplayer.atr` and `mp/playeranim.script`), world weapon models (`weapon_*`, `weapons.json`) and the effects' debris models (kind `fx` in `index.json`) of `common_mp.ff`, and the debris models only a map fast file holds (watermelon chunks); the script models (kind `script`: destructible cars, the gametypes' objects) of the map fast files and `common_mp.ff` |
| `_textures/*.webp` | Colour, normal (`*.normal.webp`) and specular maps (`*.specular.webp`): `.iwi` images in `main/*.iwd` (and the usermap's `.iwd`), downscaled |
| `<map>/minimap.json`, `../assets/maps/<usermap>.png` | The 2D map: the world rectangle computed from the map entity string (as the game's `setupMiniMap`); for the custom maps (`mp_coastal`, `mp_manorhouse`, `mp_marketcenter`: `usermaps/<map>/`, the work of their authors) also their compass image from the map's `.iwd` |
| `manifest.json` | No game content: size and hash of every file of this folder (`tools/check_deploy.py`), for the viewer's cache-busting and the check of the deployed site |

It is published only so the viewer can show the real map when it analyses your own
recordings. Nothing here is sold or offered as original work, and extracting game files
grants no rights to them: all rights remain with their owners. The extraction tools are the
actual work of this project (GPL-3.0) and anyone who owns the game can regenerate this folder
(see the README). If a rights holder wants the files removed, open an issue on the repository
and they will be taken down.
