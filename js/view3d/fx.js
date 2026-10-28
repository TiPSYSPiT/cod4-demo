/* The map's ambient effects (smoke, fire, dust, falling paper ...) as the game plays them.
 *
 * maps3d/<map>/fx.json (tools/export/fx_export.py): the createfx placements of the map and the FX
 * definitions they use. The game spawns each placement client side when the map loads
 * (CG_ParseClientEffects -> FX_SpawnOrientedEffect(def, delay * 1000, origin, axis)), i.e. delay
 * seconds (-15 by default) before time 0, and the looping elements run for the whole game.
 *
 * The game updates its particles step by step (EffectsCore fx_update.cpp); every step only adds the
 * integral of the element's velocity curve and gravity, and every random value comes from a fixed table
 * indexed by a seed of (spawn time, sequence, effect seed). So the state of every element is a function
 * of the time: this module computes, for the demo time t, every element alive at t directly
 * (spawn times of the looping elements, FX_SpawnLoopingElems; one-shot counts, FX_SpawnOneShotElems;
 * runners spawning further effects, FX_SpawnRunner), its position (FX_IntegrateVelocity, gravity
 * 800 x scale), its visual state (FX_EvaluateVisualState: colour, size, rotation from the visual state
 * samples, the atlas frame, distance fade, FX_CalculatePackedLighting) and draws it as the game's
 * sprites (FX_GenSpriteVerts: billboards, oriented sprites, tails). Seeking is free.
 *
 * The same system plays the effects the demo records (setDemo): grenade and rocket explosions and
 * smoke grenades (the weapon's projExplosionEffect and the impact table's effect for the surface hit,
 * CG_EntityEvent EV_GRENADE_EXPLODE / EV_CUSTOM_EXPLODE ...), flashbangs, bullet impacts on players
 * (the impact table, CG_ImpactEffectForWeapon), scripted effects (EV_PLAY_FX: the bomb, cars) and the
 * muzzle flash of every shot (the weapon's worldFlashEffect at the weapon's tag_flash). The effects'
 * lights (omniLight elements, R_AddOmniLightToScene) light the world and the models (lighting.js
 * DLIGHTS: the DL_MAX strongest), and colliding elements stop on the ground under their effect.
 * Not drawn: sounds, models, decals, trails, emitted elements. The effects' own random seed is rand()
 * in the game, here a fixed function of the placement / event. */
import * as THREE from 'three';
import { blendOptions, blendFactors, premultiplies } from './blend.js';
import { loadTexture } from './mapLoader.js';
import { DLIGHTS, DL_MAX, objectLighting, setObjectLighting, gridLit } from './lighting.js';
import { WorldTracer } from './trace.js';
import { HitBoxes, modelsAt } from './hitboxes.js';
import { fetchJSON } from './data.js';

/* fx_randomTable (fx_random.cpp): 479 seeds + 28 keys */
const RAND = new Float32Array([
  0.4300513, 0.58586591, 0.14015682, 0.3638894, 0.87767053, 0.67589945, 0.18348631, 0.28799689, 0.68363762, 0.071270868,
  0.94988143, 0.45510319, 0.87240946, 0.84151697, 0.37590459, 0.64859152, 0.85434818, 0.0097696204, 0.49672353, 0.43216714,
  0.43313825, 0.23515075, 0.5371843, 0.61560357, 0.03023384, 0.057191439, 0.65731519, 0.29047075, 0.90327185, 0.23431137,
  0.05183224, 0.91735321, 0.91935956, 0.4768306, 0.21653092, 0.4561961, 0.69488961, 0.044218689, 0.63184845, 0.90852547,
  0.092098549, 0.94213349, 0.43789461, 0.3860575, 0.50210679, 0.44924319, 0.077410743, 0.02781762, 0.71404278, 0.46823773,
  0.16539073, 0.84952122, 0.58761573, 0.75461656, 0.12618695, 0.84028637, 0.19792362, 0.62809461, 0.65041906, 0.68348265,
  0.95578396, 0.53067636, 0.70822668, 0.27705476, 0.89751518, 0.19948892, 0.46663198, 0.45911321, 0.97627419, 0.97676295,
  0.88385767, 0.94792533, 0.29644635, 0.86131966, 0.55083162, 0.14450631, 0.4517478, 0.24042863, 0.81023574, 0.82853132,
  0.52504712, 0.37389964, 0.69264203, 0.13117498, 0.3472065, 0.31517592, 0.0083110398, 0.44988856, 0.49951336, 0.9003765,
  0.78329813, 0.81486571, 0.4483971, 0.4672305, 0.93911082, 0.89200824, 0.17852297, 0.31579405, 0.83032441, 0.99541497,
  0.99564368, 0.83419341, 0.93674266, 0.59296888, 0.82696533, 0.25299728, 0.65787756, 0.60125524, 0.71742213, 0.16162384,
  0.49152723, 0.74315333, 0.82406402, 0.27905896, 0.14410391, 0.41164124, 0.17885713, 0.24133457, 0.32128367, 0.098229118,
  0.88920987, 0.7849403, 0.43577054, 0.11585052, 0.56665128, 0.3038781, 0.98217356, 0.28906128, 0.4941771, 0.11015297,
  0.77107245, 0.80635756, 0.23325177, 0.80025041, 0.73169285, 0.34092966, 0.80862534, 0.36114588, 0.45414591, 0.63507688,
  0.29330644, 0.74397641, 0.77859789, 0.71629274, 0.42346886, 0.26225805, 0.22746687, 0.56216818, 0.23426829, 0.204547,
  0.78050673, 0.73767084, 0.26677799, 0.92962486, 0.12538251, 0.035765801, 0.67172313, 0.95439821, 0.73759651, 0.61376756,
  0.57056129, 0.41414258, 0.26482594, 0.59178662, 0.59692085, 0.42688146, 0.4482491, 0.2322731, 0.08040332, 0.72192836,
  0.6125083, 0.59067816, 0.78994411, 0.53614408, 0.82144821, 0.0048924498, 0.26253748, 0.72266257, 0.3699922, 0.97312027,
  0.63466078, 0.81400824, 0.63080442, 0.89367366, 0.70864719, 0.033989701, 0.48497409, 0.01206893, 0.92950028, 0.1581609,
  0.099648967, 0.8424297, 0.97269017, 0.68393487, 0.95944852, 0.4509795, 0.82100147, 0.18113543, 0.0096133696, 0.920946,
  0.33979946, 0.89501613, 0.065963529, 0.90690607, 0.35550943, 0.25761193, 0.1111341, 0.57185584, 0.18842904, 0.33852205,
  0.046839122, 0.95978206, 0.80558294, 0.92706299, 0.59524548, 0.45904613, 0.43219119, 0.52756715, 0.20981228, 0.80596066,
  0.57433665, 0.57474899, 0.080443613, 0.97415334, 0.34311083, 0.78087932, 0.5398711, 0.1471191, 0.21029839, 0.69047922,
  0.64907241, 0.0037523599, 0.25652143, 0.066917039, 0.42544365, 0.60155916, 0.98711497, 0.43153438, 0.4893913, 0.056757361,
  0.23902097, 0.57154202, 0.015792551, 0.54616123, 0.28140566, 0.03631027, 0.21171141, 0.87545216, 0.22514275, 0.23361419,
  0.29637456, 0.11000722, 0.67475307, 0.66369998, 0.22543389, 0.16714393, 0.23289442, 0.44037509, 0.441459, 0.6035313,
  0.19945596, 0.46643037, 0.55098015, 0.46017194, 0.01365657, 0.7092557, 0.72405142, 0.83080012, 0.83758152, 0.20579153,
  0.65234804, 0.13164432, 0.58492744, 0.35376385, 0.29083517, 0.1880834, 0.73528826, 0.82383567, 0.73836708, 0.32443753,
  0.79825288, 0.88416022, 0.29525176, 0.58739269, 0.52058733, 0.4052889, 0.04222694, 0.89132303, 0.74553084, 0.15682253,
  0.3840099, 0.92480797, 0.8763603, 0.78868055, 0.86117363, 0.39133897, 0.71420085, 0.12660342, 0.51410252, 0.72796601,
  0.35408342, 0.51130998, 0.39910421, 0.18174252, 0.080187671, 0.69640565, 0.54660672, 0.52597398, 0.5497635, 0.28814542,
  0.13676344, 0.81884927, 0.8216908, 0.1969064, 0.30875972, 0.86829132, 0.44542047, 0.044237342, 0.24750334, 0.054299012,
  0.12496416, 0.11764297, 0.30022261, 0.87562662, 0.58950698, 0.58307421, 0.16994901, 0.6894263, 0.19844636, 0.16028295,
  0.7327404, 0.74463415, 0.52504176, 0.86025077, 0.65626323, 0.86740291, 0.036132291, 0.20404001, 0.42704168, 0.78181702,
  0.84354407, 0.40591183, 0.87515259, 0.61463499, 0.32317799, 0.71624094, 0.16840763, 0.28943446, 0.35340124, 0.066314623,
  0.18790971, 0.92870241, 0.57402211, 0.33305961, 0.21671356, 0.075696267, 0.01095232, 0.49700284, 0.9989416, 0.25630879,
  0.33151048, 0.29058096, 0.1273568, 0.37259457, 0.48575065, 0.01453627, 0.31546465, 0.93492645, 0.22717103, 0.27263665,
  0.15749003, 0.24550053, 0.18373783, 0.98265928, 0.31101075, 0.30897412, 0.26391375, 0.081691124, 0.83008957, 0.52232796,
  0.65347987, 0.99033225, 0.87762624, 0.02487598, 0.11673046, 0.84127766, 0.83317691, 0.66335428, 0.27539879, 0.25289989,
  0.89033073, 0.35153669, 0.79241872, 0.06226705, 0.078950956, 0.48853651, 0.18124095, 0.35651085, 0.8659876, 0.62736237,
  0.76226276, 0.23658484, 0.55449253, 0.2344183, 0.060345381, 0.27069253, 0.7884531, 0.65331531, 0.89417225, 0.53179425,
  0.22478817, 0.01499144, 0.27721068, 0.5308041, 0.20394848, 0.79406381, 0.22481775, 0.92929673, 0.83930409, 0.99520814,
  0.35052964, 0.15813006, 0.51348597, 0.03899226, 0.96105975, 0.22541645, 0.51048911, 0.93245894, 0.78994197, 0.52231276,
  0.35033268, 0.32351711, 0.88878679, 0.45213586, 0.81627446, 0.55437946, 0.047238011, 0.837286, 0.10283028, 0.080125153,
  0.52949619, 0.87636662, 0.30254862, 0.59845614, 0.090570398, 0.70794213, 0.30488759, 0.8177613, 0.051665921, 0.72196418,
  0.37726265, 0.76605135, 0.35348725, 0.093858831, 0.34912285, 0.30874071, 0.93809372, 0.26611614, 0.42589629, 0.70167565,
  0.30498829, 0.9933089, 0.45530573, 0.93443823, 0.04146773, 0.73757112, 0.35768315, 0.86916125, 0.69214576, 0.99868959,
  0.51038635, 0.38308778, 0.58059692, 0.063681237, 0.038692512, 0.71719843, 0.98433518, 0.72153294, 0.95375413, 0.4300513,
  0.58586591, 0.14015682, 0.3638894, 0.87767053, 0.67589945, 0.18348631, 0.28799689, 0.68363762, 0.071270868, 0.94988143,
  0.45510319, 0.87240946, 0.84151697, 0.37590459, 0.64859152, 0.85434818, 0.0097696204, 0.49672353, 0.43216714, 0.43313825,
  0.23515075, 0.5371843, 0.61560357, 0.03023384, 0.057191439, 0.65731519, 0.29047075
]);
// the game's integer lookups take the low 16 bits of the float (LOWORD(fx_randomTable[i]))
const RAND16 = new Uint16Array(RAND.buffer).filter((_, i) => i % 2 === 0);
const SEEDS = 479;
const K = { VEL: 0, ANGVEL: 3, ORIGIN: 6, OFFSET_YAW: 9, OFFSET_HEIGHT: 10, OFFSET_RADIUS: 11, ANGLES: 12, GRAVITY: 15,
  LIFE: 17, DELAY: 18, COUNT: 19, VISUAL: 21, TILE: 22, COLOR: 23, ROTATION: 24, ROTATION_DELTA: 25, SIZE0: 26, SIZE1: 27, SCALE: 28 };
const INF = 0x7FFFFFFF;
const T = { BILLBOARD: 0, ORIENTED: 1, TAIL: 2, TRAIL: 3, CLOUD: 4, MODEL: 5, OMNI: 6, SPOT: 7, SOUND: 8, DECAL: 9, RUNNER: 10 };
const F = { SPAWN_RELATIVE: 2, OFFSET_MASK: 0x30, OFFSET_SPHERE: 0x10, OFFSET_CYLINDER: 0x20, RUN_MASK: 0xC0,
  RUN_SPAWN: 0x40, RUN_EFFECT: 0x80, RUN_OFFSET: 0xC0, RANDOM_AXIS: 8, LOCAL_VEL: 0x1000000, WORLD_VEL: 0x2000000,
  NONUNIFORM: 0x10000000, COLLIDE: 0x100, DIE_ON_TOUCH: 0x200 };
const MAX_PARTICLES = 8192;
const IMPACT_MS = 3000;
const MAX_MARKS = 400;                      // marks drawn at once (the game recycles its mark pool)                     // bullet impacts on the world: shots of the last 3 s
const EYE_HEIGHT = { stand: 60, crouch: 40, prone: 11 };
const PEN_MIN_FX_DIST = 30;                 // bullet_penetrationMinFxDist: exit effects of a longer passage only
// surface types drawn as single sheets (windows, fences, leaves): passed through at the minimum depth;
// other surfaces whose back is not drawn (the ground, solid brushes) stop the bullet
const THIN_SURFACES = new Set([4, 8, 9, 15, 24]);                    // cloth, foliage, glass, paper, plastic
const SIM_STEP = 50;                        // FX_UpdateElementPosition_Colliding: at most 50 ms per trace
const SIM_PER_FRAME = 60;                   // colliding elements simulated per frame (the others wait a frame)
const MAX_MODELS = 160;                     // debris models drawn at once
const EMIT_STEP = 20;                       // ms between the samples of an emitting element's path
const TRAIL_STEP = 10;                      // ms between the samples of a moving effect's path (trail sections)
const BRASS_MS = 4000;                      // casings of the shots of the last 4 s (their effects' life)

/* G_GoodRandomFloat (bullet.cpp): the shuffled Park-Miller generator the bullet spread uses */
function goodRandom(state) {
  let idum = -state.v | 0;
  const iv = new Int32Array(32);
  for (let j = 39; j >= 0; j--) {
    idum = (16807 * (idum % 127773) - 2836 * Math.trunc(idum / 127773)) | 0;
    if (idum < 0) idum += 0x7FFFFFFF;
    if (j < 32) iv[j] = idum;
  }
  idum = (16807 * (idum % 127773) - 2836 * Math.trunc(idum / 127773)) | 0;
  if (idum < 0) idum += 0x7FFFFFFF;
  state.v = idum;
  return Math.min(0.99999988, Math.fround(iv[Math.trunc(iv[0] / 0x4000000)]) * 4.656612875245797e-10);
}
const FLASH_MS = 30;

/* bytedirs (com_math.cpp): the 162 directions of DirToByte / ByteToDir (event normals) */
const BYTEDIRS = new Float32Array([
  -0.52573103, 0.0, 0.85065103, -0.44286299, 0.238856, 0.86418802, -0.29524201, 0.0, 0.955423, -0.309017, 0.5, 0.809017,
  -0.16246, 0.26286599, 0.951056, 0.0, 0.0, 1.0, 0.0, 0.85065103, 0.52573103, -0.14762101, 0.71656698, 0.68171799,
  0.14762101, 0.71656698, 0.68171799, 0.0, 0.52573103, 0.85065103, 0.309017, 0.5, 0.809017, 0.52573103, 0.0, 0.85065103,
  0.29524201, 0.0, 0.955423, 0.44286299, 0.238856, 0.86418802, 0.16246, 0.26286599, 0.951056, -0.68171799, 0.14762101, 0.71656698,
  -0.809017, 0.309017, 0.5, -0.58778501, 0.42532501, 0.688191, -0.85065103, 0.52573103, 0.0, -0.86418802, 0.44286299, 0.238856,
  -0.71656698, 0.68171799, 0.14762101, -0.688191, 0.58778501, 0.42532501, -0.5, 0.809017, 0.309017, -0.238856, 0.86418802, 0.44286299,
  -0.42532501, 0.688191, 0.58778501, -0.71656698, 0.68171799, -0.14762101, -0.5, 0.809017, -0.309017, -0.52573103, 0.85065103, 0.0,
  0.0, 0.85065103, -0.52573103, -0.238856, 0.86418802, -0.44286299, 0.0, 0.955423, -0.29524201, -0.26286599, 0.951056, -0.16246,
  0.0, 1.0, 0.0, 0.0, 0.955423, 0.29524201, -0.26286599, 0.951056, 0.16246, 0.238856, 0.86418802, 0.44286299,
  0.26286599, 0.951056, 0.16246, 0.5, 0.809017, 0.309017, 0.238856, 0.86418802, -0.44286299, 0.26286599, 0.951056, -0.16246,
  0.5, 0.809017, -0.309017, 0.85065103, 0.52573103, 0.0, 0.71656698, 0.68171799, 0.14762101, 0.71656698, 0.68171799, -0.14762101,
  0.52573103, 0.85065103, 0.0, 0.42532501, 0.688191, 0.58778501, 0.86418802, 0.44286299, 0.238856, 0.688191, 0.58778501, 0.42532501,
  0.809017, 0.309017, 0.5, 0.68171799, 0.14762101, 0.71656698, 0.58778501, 0.42532501, 0.688191, 0.955423, 0.29524201, 0.0,
  1.0, 0.0, 0.0, 0.951056, 0.16246, 0.26286599, 0.85065103, -0.52573103, 0.0, 0.955423, -0.29524201, 0.0,
  0.86418802, -0.44286299, 0.238856, 0.951056, -0.16246, 0.26286599, 0.809017, -0.309017, 0.5, 0.68171799, -0.14762101, 0.71656698,
  0.85065103, 0.0, 0.52573103, 0.86418802, 0.44286299, -0.238856, 0.809017, 0.309017, -0.5, 0.951056, 0.16246, -0.26286599,
  0.52573103, 0.0, -0.85065103, 0.68171799, 0.14762101, -0.71656698, 0.68171799, -0.14762101, -0.71656698, 0.85065103, 0.0, -0.52573103,
  0.809017, -0.309017, -0.5, 0.86418802, -0.44286299, -0.238856, 0.951056, -0.16246, -0.26286599, 0.14762101, 0.71656698, -0.68171799,
  0.309017, 0.5, -0.809017, 0.42532501, 0.688191, -0.58778501, 0.44286299, 0.238856, -0.86418802, 0.58778501, 0.42532501, -0.688191,
  0.688191, 0.58778501, -0.42532501, -0.14762101, 0.71656698, -0.68171799, -0.309017, 0.5, -0.809017, 0.0, 0.52573103, -0.85065103,
  -0.52573103, 0.0, -0.85065103, -0.44286299, 0.238856, -0.86418802, -0.29524201, 0.0, -0.955423, -0.16246, 0.26286599, -0.951056,
  0.0, 0.0, -1.0, 0.29524201, 0.0, -0.955423, 0.16246, 0.26286599, -0.951056, -0.44286299, -0.238856, -0.86418802,
  -0.309017, -0.5, -0.809017, -0.16246, -0.26286599, -0.951056, 0.0, -0.85065103, -0.52573103, -0.14762101, -0.71656698, -0.68171799,
  0.14762101, -0.71656698, -0.68171799, 0.0, -0.52573103, -0.85065103, 0.309017, -0.5, -0.809017, 0.44286299, -0.238856, -0.86418802,
  0.16246, -0.26286599, -0.951056, 0.238856, -0.86418802, -0.44286299, 0.5, -0.809017, -0.309017, 0.42532501, -0.688191, -0.58778501,
  0.71656698, -0.68171799, -0.14762101, 0.688191, -0.58778501, -0.42532501, 0.58778501, -0.42532501, -0.688191, 0.0, -0.955423, -0.29524201,
  0.0, -1.0, 0.0, 0.26286599, -0.951056, -0.16246, 0.0, -0.85065103, 0.52573103, 0.0, -0.955423, 0.29524201,
  0.238856, -0.86418802, 0.44286299, 0.26286599, -0.951056, 0.16246, 0.5, -0.809017, 0.309017, 0.71656698, -0.68171799, 0.14762101,
  0.52573103, -0.85065103, 0.0, -0.238856, -0.86418802, -0.44286299, -0.5, -0.809017, -0.309017, -0.26286599, -0.951056, -0.16246,
  -0.85065103, -0.52573103, 0.0, -0.71656698, -0.68171799, -0.14762101, -0.71656698, -0.68171799, 0.14762101, -0.52573103, -0.85065103, 0.0,
  -0.5, -0.809017, 0.309017, -0.238856, -0.86418802, 0.44286299, -0.26286599, -0.951056, 0.16246, -0.86418802, -0.44286299, 0.238856,
  -0.809017, -0.309017, 0.5, -0.688191, -0.58778501, 0.42532501, -0.68171799, -0.14762101, 0.71656698, -0.44286299, -0.238856, 0.86418802,
  -0.58778501, -0.42532501, 0.688191, -0.309017, -0.5, 0.809017, -0.14762101, -0.71656698, 0.68171799, -0.42532501, -0.688191, 0.58778501,
  -0.16246, -0.26286599, 0.951056, 0.44286299, -0.238856, 0.86418802, 0.16246, -0.26286599, 0.951056, 0.309017, -0.5, 0.809017,
  0.14762101, -0.71656698, 0.68171799, 0.0, -0.52573103, 0.85065103, 0.42532501, -0.688191, 0.58778501, 0.58778501, -0.42532501, 0.688191,
  0.688191, -0.58778501, 0.42532501, -0.955423, 0.29524201, 0.0, -0.951056, 0.16246, 0.26286599, -1.0, 0.0, 0.0,
  -0.85065103, 0.0, 0.52573103, -0.955423, -0.29524201, 0.0, -0.951056, -0.16246, 0.26286599, -0.86418802, 0.44286299, -0.238856,
  -0.951056, 0.16246, -0.26286599, -0.809017, 0.309017, -0.5, -0.86418802, -0.44286299, -0.238856, -0.951056, -0.16246, -0.26286599,
  -0.809017, -0.309017, -0.5, -0.68171799, 0.14762101, -0.71656698, -0.68171799, -0.14762101, -0.71656698, -0.85065103, 0.0, -0.52573103,
  -0.688191, 0.58778501, -0.42532501, -0.58778501, 0.42532501, -0.688191, -0.42532501, 0.688191, -0.58778501, -0.42532501, -0.688191, -0.58778501,
  -0.58778501, -0.42532501, -0.688191, -0.688191, -0.58778501, -0.42532501
]);
function byteToDir(b) {
  return b >= 0 && b < 162 ? [BYTEDIRS[3 * b], BYTEDIRS[3 * b + 1], BYTEDIRS[3 * b + 2]] : [0, 0, 0];
}
/** the axis of an event effect: forward = the normal, Vec3Basis_RightHanded for the others */
function axisFromDir(dir) {                                           // (any length: normalised here)
  const l = Math.hypot(dir[0], dir[1], dir[2]);
  const fwd = l > 1e-9 ? [dir[0] / l, dir[1] / l, dir[2] / l] : [0, 0, 1];
  const up = perpendicular(fwd);
  return [fwd, cross(up, fwd), up];
}

const rint = (amp, r16) => ((amp + 1) * r16) >>> 16;

/* the rows of the impact table by the weapon's impactType (CG_ImpactEffectForWeapon; + 1: exit wound) */
const IMPACT_ROW = { bullet_small: 0, bullet_large: 2, shotgun: 4, bullet_ap: 6, grenade_bounce: 8, grenade_explode: 9,
  rocket_explode: 10, projectile_dud: 11 };

/** CG_DrawBulletImpacts for client cl's shot at ts (relative ms): the client's guess of where the
 *  bullets hit the world - from the eye along the view, the weapon's spread for the stance scaled by
 *  the speed (CG_GuessSpreadForWeapon), the random of CG_BulletEndpos - traced with tracer
 *  (trace.js) -> [{name (the impact table's effect for the weapon and surface, or null), point,
 *  normal, surface}] per pellet that hit, or null (no sample / not a bullet weapon)
 *  (also used by tools/validate) */
/** the recorder's player state commandTime of the last snapshot at or before t (DemoData psCommandTime) */
export function commandTimeAt(M, t) {
  const C = M.d.psCommandTime;
  if (!C || !C.t.length) return null;
  let lo = 0, hi = C.t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (C.t[m] <= t) lo = m + 1; else hi = m; }
  return lo > 0 ? C.ct[lo - 1] : null;
}
// the client's guess of another player's shot happens when the shot's snapshot is read as the next one
// (CG_SetNextSnap -> CG_CheckEvents), while the frame shows the snapshot before: the shooter's angles,
// muzzle and speed of that frame, the seed of the recorder's predicted (demo: copied) player state then
const CLIENT_LAG = 50;
// ?shots=server: a traced shot of a shooter the server reports a flesh hit for (within 100 ms) ends at
// that hit - no wall impacts behind the victim. Not what the game's client draws (it guesses the spread
// with another seed than the server, so its traced bullets can pass the victim); off by default.
const SERVER_SHOTS = typeof location !== 'undefined' && new URLSearchParams(location.search).get('shots') === 'server';
const SERVER_HIT_MS = 100;

/** the recorder's player state of the client's frame (the snapshot at t) when it is client cl's
 *  (DemoData psAim) -> index or -1: the client fires that player's shots from its player state */
export function ownShotState(M, cl, t) {
  const P = M.d.psAim;
  if (!P || !P.t.length) return -1;
  let lo = 0, hi = P.t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (P.t[m] <= t) lo = m + 1; else hi = m; }
  const i = lo - 1;
  return i >= 0 && P.client[i] === cl && t - P.t[i] < 100 ? i : -1;
}
const PERK_BULLETACCURACY = 2, PERK_SPREAD = 0.65;          // specialty_bulletaccuracy, perk_weapSpreadMultiplier
const PSOS_RESETTING = 1, PSOS_ENABLED = 2;
/** the spread of the recorder's own shot (DrawBulletImpacts for the player state's client):
 *  BG_GetSpreadForWeapon by the view height (prone 11 .. crouched 40 .. standing 60) and the perk,
 *  ADS when fWeaponPosFrac is 1, scaled by the player state's aimSpreadScale */
function ownSpread(P, i, sp) {
  const vh = P.vh[i], v = k => sp[k] || 0;
  let mn, mx;
  if (P.spreadOverrideState[i] === PSOS_ENABLED) mn = mx = P.spreadOverride[i];
  else if (vh <= 40) { const f = (vh - 11) / 29; mn = (v(2) - v(4)) * f + v(4); mx = (v(3) - v(5)) * f + v(5); }
  else { const f = (vh - 40) / 20; mn = (v(0) - v(2)) * f + v(2); mx = (v(1) - v(3)) * f + v(3); }
  if (P.spreadOverrideState[i] === PSOS_RESETTING) mx = P.spreadOverride[i];
  if (P.perks[i] & PERK_BULLETACCURACY) { mn *= PERK_SPREAD; mx *= PERK_SPREAD; }
  // the frame's state lies between the snapshot before and this one: ADS only when both are fully aimed
  const prev = i > 0 && P.client[i - 1] === P.client[i] ? i - 1 : i;
  const ads = P.ads[i] === 1 && P.ads[prev] === 1 && sp[6] != null;
  const base = ads ? v(6) : mn;
  return { spread: (mx - base) * P.aim[i] / 255 + base, ads };
}
/** the recorder's view origin (BG_GetPlayerViewOrigin: the view height, the lean; not the bob) */
function ownEye(s, P, i) {
  const e = [s.x, s.y, s.z + P.vh[i]], f = P.lean[i];
  if (f) {
    const lean = (2 - Math.abs(f)) * f, roll = 16 * lean * Math.PI / 180, y = s.yaw * Math.PI / 180;   // AddLeanToPosition
    const cr = Math.cos(roll), d = lean * 20;
    e[0] += d * cr * Math.sin(y); e[1] -= d * cr * Math.cos(y); e[2] -= d * Math.sin(roll);
  }
  e[2] = Math.max(e[2], s.z + 8);
  return e;
}

export function shotImpacts(M, weapons, impacts, tracer, cl, ts, penetration = null, ads = null, view = null) {
  // view: {lag (ms the client's frame is behind the shot's snapshot), seed (true: the recorder's commandTime)}
  const lag = view && view.lag != null ? view.lag : 0;
  const s = M.sampleAt(cl, ts - lag) || M.sampleAt(cl, ts);
  // the recorder's own shot (view.own): the client fires it from its player state of the frame
  const own = view && view.own ? ownShotState(M, cl, ts - lag) : -1;
  if (!s || s.age > 200 || !tracer) return null;
  const W = weapons[M.weaponName(s.weapon, ts)];
  if (!W || W.type !== 'bullet' || !W.spread || !impacts) return null;
  const row = IMPACT_ROW[W.impactType];
  if (row == null) return null;
  const stance = s.prone ? 'prone' : s.crouch ? 'crouch' : 'stand';
  // the start: the weapon's tag_flash in the shooter's pose (DrawBulletImpacts: FX_GetBoneOrientation),
  // else the eye
  // (the recorder's own: the view origin)
  const muzzle = own < 0 && view && view.muzzle ? view.muzzle(cl, ts - lag, s) : null;
  const eye = own >= 0 ? ownEye(s, M.d.psAim, own) : muzzle || [s.x, s.y, s.z + EYE_HEIGHT[stance]];
  const p = s.pitch * Math.PI / 180, y = s.yaw * Math.PI / 180, sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(y), cy = Math.cos(y);
  const fwd = [cp * cy, cp * sy, -sp], right = [sy, -cy, 0], up = [sp * cy, sp * sy, cp];
  // the spread: min .. max of the stance by the speed (aimSpreadScale = speed / 255)
  const prev = M.sampleAt(cl, ts - lag - 50);
  const speed = prev ? Math.min(255, Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z) * 20) : 0;
  const [smin, smax] = stance === 'prone' ? [W.spread[4], W.spread[5]] : stance === 'crouch' ? [W.spread[2], W.spread[3]] : [W.spread[0], W.spread[1]];
  // aiming down the sights (CG_IsPlayerADS: the legs animation's movetype is a walk): from the ADS
  // spread up to the stance's maximum, else from the stance's minimum (DrawBulletImpacts)
  const aiming = !!(ads && W.spread[6] != null && ads(cl, ts));
  const base = aiming ? W.spread[6] : smin;
  const spread = own >= 0 ? ownSpread(M.d.psAim, own, W.spread).spread : ((smax || 0) - (base || 0)) * speed / 255 + (base || 0);
  const pellets = W.class === 'spread' ? Math.max(1, W.shotCount) : 1, range = W.class === 'spread' && W.minDamageRange ? W.minDamageRange : 8192;
  const aim = Math.tan(spread * Math.PI / 180) * range;
  const out = [];
  out.start = eye;                                    // (sound.js: the shot's line for the whizby)
  if (own >= 0) out.own = true;
  for (let k = 0; k < pellets; k++) {
    // the game seeds with the recorder's command time + shot (without it: the demo time)
    const ct = view && view.seed ? commandTimeAt(M, ts - lag) : null;
    const st = { v: ((ct != null ? ct : ts) + k) | 0 };
    const theta = goodRandom(st) * 360 * Math.PI / 180, r = goodRandom(st);
    const rx = r * Math.cos(theta) * aim, ry = r * Math.sin(theta) * aim;
    const end = [0, 1, 2].map(j => eye[j] + fwd[j] * range + right[j] * rx + up[j] * ry);
    const hit = tracer.trace(eye, end);
    if (!out.end) out.end = hit ? hit.point : end;
    if (!hit) continue;
    if (hit.player != null) { out.players = (out.players || 0) + 1; if (hit.boxes) out.playerBoxes = (out.playerBoxes || 0) + 1; if (hit.posed) out.playerPosed = (out.playerPosed || 0) + 1; }
    const entry = h => ({ name: (impacts[row] && impacts[row][h.surface === 7 ? 0 : h.surface]) || null, point: h.point, normal: h.normal, surface: h.surface, tri: h.tri,
      impactType: W.impactType });
    // a player: the server's flesh impact is in the demo, the client plays nothing there
    if (hit.player == null) out.push(entry(hit));
    const depths = penetration && W.penetrateType && penetration[W.penetrateType];
    if (depths) penetrate(tracer, depths, eye, end, hit, out, entry, h => ({
      name: (impacts[row + 1] && impacts[row + 1][h.surface === 7 ? 0 : h.surface]) || null, point: h.point, normal: h.normal, surface: h.surface, exit: true,
      impactType: W.impactType }));
  }
  return out;
}

/* ---------- the players as obstacles of the traced shots ----------
 * The client traces another player's shot with MASK_SHOT (cg_weapons.cpp BulletTrace ->
 * CG_LocationalTrace): it stops at players (their hit boxes). With sv_clientSideBullets the client
 * plays nothing there - the server sends the flesh impact (EV_BULLET_HIT) - and the bullet goes on
 * through the body (FireBulletPenetrate with the flesh depth). The hit boxes are the bones' boxes of
 * the player model (hitboxes.js: the game's XBoneInfo boxes in the character's stance pose); while a
 * player's models are not loaded, one capsule: standing up to 72 units, crouched 52, prone along the
 * body. */
const PLAYER_CAPSULE = { stand: [11, 72], crouch: [12, 52] };
const PRONE = { radius: 10, back: 30, front: 34, z: 10 };
let playerHitId = 0;                                                  // (penetrate: entry and exit differ)
/** the first hit of the segment a -> b on a capsule p0 - p1 of radius r, starting outside -> fraction or null */
function capsuleHit(a, b, p0, p1, r) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ax = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const dotv = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const inside = p => { const w = [p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]], L = dotv(ax, ax), k = Math.max(0, Math.min(1, L ? dotv(w, ax) / L : 0));
    return Math.hypot(w[0] - ax[0] * k, w[1] - ax[1] * k, w[2] - ax[2] * k) < r; };
  if (inside(a)) return null;                                         // a trace from inside does not hit it again
  let best = null;
  // the cylinder: |(a + t d - p0) x ax|^2 = r^2 |ax|^2 with 0 <= (a + t d - p0).ax <= |ax|^2
  const L = dotv(ax, ax), ao = [a[0] - p0[0], a[1] - p0[1], a[2] - p0[2]];
  const dd = dotv(d, ax), od = dotv(ao, ax);
  const A = L * dotv(d, d) - dd * dd, B = L * dotv(d, ao) - dd * od, C = L * dotv(ao, ao) - od * od - r * r * L;
  if (A > 1e-9) {
    const disc = B * B - A * C;
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / A, h = od + t * dd;
      if (t >= 0 && t <= 1 && h >= 0 && h <= L) best = t;
    }
  }
  // the end spheres
  for (const c of [p0, p1]) {
    const oc = [a[0] - c[0], a[1] - c[1], a[2] - c[2]], qa = dotv(d, d), qb = dotv(oc, d), qc = dotv(oc, oc) - r * r;
    const disc = qb * qb - qa * qc;
    if (disc < 0) continue;
    const t = (-qb - Math.sqrt(disc)) / qa;
    if (t >= 0 && t <= 1 && (best == null || t < best)) best = t;
  }
  return best;
}
/** the capsule of a living player at t (Match.sampleAt) -> [p0, p1, r] or null */
function playerCapsule(s) {
  if (s.prone) {
    const y = s.yaw * Math.PI / 180, f = [Math.cos(y), Math.sin(y)], z = s.z + PRONE.z;
    return [[s.x - f[0] * PRONE.back, s.y - f[1] * PRONE.back, z], [s.x + f[0] * PRONE.front, s.y + f[1] * PRONE.front, z], PRONE.radius];
  }
  const [r, h] = s.crouch ? PLAYER_CAPSULE.crouch : PLAYER_CAPSULE.stand;
  return [[s.x, s.y, s.z + r], [s.x, s.y, s.z + h - r], r];
}
/** the traced shot's obstacles: those of base (the world, props, cars) and the living players at t
 *  (relative ms) but the shooter - their bone boxes (hitBoxes: hitboxes.js HitBoxes, loaded) or a
 *  capsule -> a tracer; its player hits carry player: client, surface flesh */
export function shotTracer(base, M, t, shooter, hitBoxes = null) {
  const caps = [];
  for (const k of Object.keys(M.d.positions || {})) {
    const cl = Number(k);
    if (cl === shooter) continue;
    // the state just before the shot: a killing shot's victim is flagged dead in the same snapshot
    const s = M.sampleAt(cl, t) || M.sampleAt(cl, t - 50);
    if (s && s.age <= 200) caps.push([cl, playerCapsule(s), s, hitBoxes && hitBoxes.loaded ? modelsAt(M, cl, t) : null]);
  }
  if (!caps.length) return base;
  return {
    worldTriangles: base.worldTriangles, propTriangles: base.propTriangles, built: base.built,
    trace(a, b) {
      const w = base.trace(a, b);
      let best = w ? w.frac : 1, hit = null, boxHit = null;
      for (const [cl, [p0, p1, r], s, models] of caps) {
        const h = models ? hitBoxes.trace(a, b, s, models, best, cl, t) : undefined;
        if (h !== undefined) {                                          // the bone boxes decided
          if (h && h.frac < best) { best = h.frac; hit = cl; boxHit = h; }
          continue;
        }
        const f = capsuleHit(a, b, p0, p1, r);
        if (f != null && f < best) { best = f; hit = cl; boxHit = null; }
      }
      if (hit == null) return w;
      if (boxHit) return { frac: best, point: boxHit.point, normal: boxHit.normal, surface: 7, player: hit, boxes: true, posed: boxHit.posed, tri: -1e6 - (playerHitId++ % 1e6) };
      const [p0, p1, r] = caps.find(c => c[0] === hit)[1];
      const point = [0, 1, 2].map(k => a[k] + (b[k] - a[k]) * best);
      const ax = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], L = ax[0] ** 2 + ax[1] ** 2 + ax[2] ** 2;
      const k = Math.max(0, Math.min(1, L ? ((point[0] - p0[0]) * ax[0] + (point[1] - p0[1]) * ax[1] + (point[2] - p0[2]) * ax[2]) / L : 0));
      const n = [0, 1, 2].map(j => (point[j] - (p0[j] + ax[j] * k)) / r);
      return { frac: best, point, normal: n, surface: 7, player: hit, tri: -1e6 - (playerHitId++ % 1e6) };
    }
  };
}

/** FireBulletPenetrate (the client's version): through up to 5 surfaces while the depth table allows -
 *  from the hit on along the shot (BG_AdvanceTrace), the next surface ahead, then back from there to
 *  the hit: the exit point; depth = the distance between them (at least 1), damage left -= depth / the
 *  surfaces' smaller depth. A passage longer than bullet_penetrationMinFxDist gets the exit effect (the
 *  impact table's exit row, along the shot) and the next surface's entry effect. The world here is the
 *  render world (surfaces, not the collision brushes): a wall's depth is the distance to its inner face */
function penetrate(tracer, depths, start, end, hit, out, entry, exit) {
  const len = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
  const dir = [0, 1, 2].map(k => (end[k] - start[k]) / len);
  const dotN = h => -(h.normal[0] * dir[0] + h.normal[1] * dir[1] + h.normal[2] * dir[2]);
  let left = 1;
  for (let i = 0; i < 5; i++) {
    let maxDepth = hit.surface ? depths[hit.surface] || 0 : 0;
    if (maxDepth <= 0) return;
    const last = hit.point, d = dotN(hit);
    if (d < 0.125) return;                                            // grazing: the game stops here
    const from = last.map((v, k) => v + dir[k] * 0.135 / d);
    const next = tracer.trace(from, end);
    // back towards the hit: from just before the next surface (or the shot's end)
    const rd = next ? Math.max(0.125, dotN(next)) : 1;
    const revStart = next ? next.point.map((v, k) => v - dir[k] * 0.01 / rd) : end;
    let rev = tracer.trace(revStart, last.map((v, k) => v - dir[k] * 0.01));
    // the reverse trace found the entry surface itself: the render world has no back there
    if (rev && rev.tri === hit.tri) {
      if (!THIN_SURFACES.has(hit.surface)) return;
      rev = { point: last, surface: hit.surface };
    }
    if (rev) {
      const depth = Math.max(1, Math.hypot(last[0] - rev.point[0], last[1] - rev.point[1], last[2] - rev.point[2]));
      maxDepth = Math.min(maxDepth, rev.surface ? depths[rev.surface] || 0 : 0);
      if (maxDepth <= 0) return;
      left -= depth / maxDepth;
      if (left <= 0) return;
      const far = next ? next.point : end;
      if ((rev.point[0] - far[0]) ** 2 + (rev.point[1] - far[1]) ** 2 + (rev.point[2] - far[2]) ** 2 > PEN_MIN_FX_DIST * PEN_MIN_FX_DIST) {
        if (rev.player == null) out.push(exit({ point: rev.point, normal: dir.slice(), surface: rev.surface }));
        if (next && next.player == null) out.push(entry(next));
      }
    }
    if (!next) return;
    hit = next;
  }
}

/** BG_EvaluateTrajectory / BG_EvaluateTrajectoryDelta of a projectile (DemoData grenades: segments
 *  [trTime, trType, base xyz, delta xyz], times relative to the demo start) at t -> {origin, axis}
 *  (axis 0 = the direction of flight; CG_PlayBoltedEffect's tag_fx points along the rocket), or null
 *  outside the segments. TR_LINEAR(_STOP) 2 / 3, TR_GRAVITY 5 (g = 800); others stand still */
export function projectileFrame(g, t, gravity = 800) {
  const S = g.segments;
  if (!S || !S.length || t < S[0][0] - 100) return null;
  let i = S.length - 1;
  while (i > 0 && S[i][0] > t) i--;
  const [tr, type, bx, by, bz, vx, vy, vz] = S[i], dt = Math.max(0, t - tr) / 1000;
  let o, v;
  if (type === 2 || type === 3) { o = [bx + vx * dt, by + vy * dt, bz + vz * dt]; v = [vx, vy, vz]; }
  else if (type === 5) { o = [bx + vx * dt, by + vy * dt, bz + vz * dt - 0.5 * gravity * dt * dt]; v = [vx, vy, vz - gravity * dt]; }
  else { o = [bx, by, bz]; v = g._lastDir || [1, 0, 0]; }
  if (Math.hypot(v[0], v[1], v[2]) > 1e-3) g._lastDir = v;
  return { origin: o, axis: axisFromDir(v) };
}

/** the traces' obstacles (FxSystem.setWorld; also tools/validate): the world's triangles without the
 *  decal groups (positions, index: the world mesh; groups: world.json) and the placed prop collision
 *  ({positions: 9 floats per triangle, surface}) in one WorldTracer */
export function worldTracer(P, I, groups, props) {
  const keep = [], surf = [];
  for (const g of groups) {
    if (g.decal) continue;
    for (let k = g.start; k < g.start + g.count; k += 3) { keep.push(I[k], I[k + 1], I[k + 2]); surf.push(g.surface || 0); }
  }
  let pos = P, n = keep.length / 3;
  const np = props ? props.surface.length : 0;
  if (np) {
    pos = new Float32Array(P.length + props.positions.length);
    pos.set(P); pos.set(props.positions, P.length);
    const v0 = P.length / 3;
    for (let k = 0; k < np * 3; k++) keep.push(v0 + k);
    for (let k = 0; k < np; k++) surf.push(props.surface[k]);
  }
  const tr = new WorldTracer(pos, new Uint32Array(keep), new Uint8Array(surf));
  tr.propTriangles = np; tr.worldTriangles = n;
  return tr;
}

/** The effects a demo records, as the client plays them (CG_EntityEvent): for every detonation the
 *  impact table's effect for its surface (grenades, rockets; CG_ImpactEffectForWeapon) and the weapon's
 *  projExplosionEffect (smoke grenades from customExplode.startTime, flashbangs only that), for every
 *  bullet impact on a player the impact table's flesh effect, for every EV_PLAY_FX its named effect.
 *  t relative to the demo start. -> {list: [{kind, name, origin, axis, t}], missing: [{kind, name}],
 *  empty: impacts whose table entry is empty (the game plays nothing: fatal headshots have only an exit
 *  effect)} (also used by tools/validate) */
export function demoEffectList(M, defs, weapons, impacts) {
  const d = M.d, list = [], missing = [];
  let empty = 0;
  const add = (kind, name, origin, axis, t) => {
    if (name && defs[name]) list.push({ kind, name, origin, axis, t });
    else missing.push({ kind, name: name || null });
  };
  const impactFx = (W, surf, flags = 0) => {
    let row = W && IMPACT_ROW[W.impactType];
    if (row != null && row < 8 && flags & 4) row++;                   // the bullets' exit rows
    if (row == null || !impacts || !impacts[row]) return null;
    const col = surf === 7 ? 29 + ((flags & 2) ? ((flags & 1) ? 3 : 1) : ((flags & 1) ? 2 : 0)) : surf;
    return impacts[row][col] || null;
  };
  for (const g of d.grenades || []) {
    const det = g.detonation;
    if (!det || det.event == null) continue;
    const W = weapons[g.weapon], o = [det.x, det.y, det.z], axis = axisFromDir(byteToDir(det.dir));
    const row = W && IMPACT_ROW[W.impactType];
    if (det.event !== 48 && row != null) add('explosion', impactFx(W, det.surf), o, axis, det.t);
    if (W && W.explosion) add(g.kind === 'smoke' ? 'smoke' : g.kind === 'flash' ? 'flash' : 'explosion', W.explosion, o, axis,
      det.start != null ? det.start : det.t);
    if (!W || (row == null && !W.explosion)) missing.push({ kind: 'explosion', name: g.weapon });
  }
  const fx = d.fx3d || {};
  for (const r of fx.impacts || []) {
    const W = weapons[M.weaponName(r[6], r[0])], name = impactFx(W, r[5], r[7]);
    // impact flags: 1 head, 2 fatal (Bullet_Process), 4 exit; an empty entry of a known row is no effect
    if (!name && W && IMPACT_ROW[W.impactType] != null && impacts && impacts[IMPACT_ROW[W.impactType]]) { empty++; continue; }
    add(r[5] === 7 ? 'blood' : 'impact', name, [r[1], r[2], r[3]], axisFromDir(byteToDir(r[4])), r[0]);
  }
  for (const r of fx.playFx || []) {
    const name = (fx.effectNames || {})[r[7]];
    add('playFx', name && name.toLowerCase(), [r[1], r[2], r[3]], anglesToAxis([r[4], r[5], r[6]]), r[0]);
  }
  return { list, missing, empty };
}               // (amplitude + 1) * LOWORD(r) >> 16
const useed = x => (x >>> 0) % SEEDS;                                // the game sums the seed parts as uint32

/* ---------- vector helpers (game axes: x forward, y left, z up; arrays [x, y, z]) ---------- */
function anglesToAxis(a) {                                            // AnglesToAxis (degrees)
  const p = a[0] * Math.PI / 180, y = a[1] * Math.PI / 180, r = a[2] * Math.PI / 180;
  const sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(y), cy = Math.cos(y), sr = Math.sin(r), cr = Math.cos(r);
  return [[cp * cy, cp * sy, -sp],                                    // forward
    [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp],          // left = -right
    [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp]];        // up
}
function perpendicular(v) {                                           // PerpendicularVector
  const a = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
  const i = a[0] <= a[1] && a[0] <= a[2] ? 0 : a[1] <= a[2] ? 1 : 2;
  const t = [0, 0, 0]; t[i] = 1;
  const d = t[0] * v[0] + t[1] * v[1] + t[2] * v[2];
  const p = [t[0] - d * v[0], t[1] - d * v[1], t[2] - d * v[2]], l = Math.hypot(...p) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(v) { const l = Math.hypot(v[0], v[1], v[2]); if (l) { v[0] /= l; v[1] /= l; v[2] /= l; } return l; }
function rotateAround(v, axis, deg) {                                 // RotatePointAroundVector
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const x = cross(axis, v);
  return [0, 1, 2].map(i => v[i] * c + x[i] * s + axis[i] * d * (1 - c));
}

/* ---------- spawn origin and the element's frame (fx_update_util.cpp) ---------- */
function spawnOrigin(e, frame, seed, out) {                           // FX_GetSpawnOrigin + FX_OffsetSpawnOrigin
  const o = [0, 1, 2].map(k => e.spawnOrigin[k][1] * RAND[seed + K.ORIGIN + k] + e.spawnOrigin[k][0]);
  const A = frame.axis;
  if (e.flags & F.SPAWN_RELATIVE) for (let k = 0; k < 3; k++) out[k] = frame.origin[k] + o[0] * A[0][k] + o[1] * A[1][k] + o[2] * A[2][k];
  else for (let k = 0; k < 3; k++) out[k] = frame.origin[k] + o[k];
  offsetOrigin(e, frame, seed, out);
}
function offsetOrigin(e, frame, seed, out) {
  const mode = e.flags & F.OFFSET_MASK;
  if (!mode) return;
  const radius = e.spawnOffsetRadius[1] * RAND[seed + K.OFFSET_RADIUS] + e.spawnOffsetRadius[0];
  if (mode === F.OFFSET_SPHERE) {                                     // FX_RandomDir
    const h = RAND[seed + K.OFFSET_HEIGHT] * 2 - 1, yaw = RAND[seed + K.OFFSET_YAW] * 2 * Math.PI, s = Math.sqrt(1 - h * h);
    out[0] += radius * s * Math.cos(yaw); out[1] += radius * s * Math.sin(yaw); out[2] += radius * h;
  } else {                                                            // cylinder around the effect's forward axis
    const yaw = RAND[seed + K.OFFSET_YAW] * 2 * Math.PI, A = frame.axis;
    const height = e.spawnOffsetHeight[1] * RAND[seed + K.OFFSET_HEIGHT] + e.spawnOffsetHeight[0];
    const c = radius * Math.cos(yaw), s = radius * Math.sin(yaw);
    for (let k = 0; k < 3; k++) out[k] += c * A[1][k] + s * A[2][k] + height * A[0][k];
  }
}
const IDENTITY = { origin: [0, 0, 0], axis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
function orientation(e, frame, seed) {                                // FX_GetOrientation (a static effect: frameNow = frameAtSpawn)
  const run = e.flags & F.RUN_MASK;
  if (!run) return IDENTITY;
  if (run !== F.RUN_OFFSET) return frame;
  const origin = [0, 0, 0], o = [0, 1, 2].map(k => e.spawnOrigin[k][1] * RAND[seed + K.ORIGIN + k] + e.spawnOrigin[k][0]);
  const A = frame.axis;
  if (e.flags & F.SPAWN_RELATIVE) for (let k = 0; k < 3; k++) origin[k] = frame.origin[k] + o[0] * A[0][k] + o[1] * A[1][k] + o[2] * A[2][k];
  else for (let k = 0; k < 3; k++) origin[k] = frame.origin[k] + o[k];
  const fwd = [0, 0, 0];
  offsetOrigin(e, frame, seed, fwd);
  for (let k = 0; k < 3; k++) origin[k] += fwd[k];
  if (!normalize(fwd)) { fwd[0] = 1; fwd[1] = 0; fwd[2] = 0; }
  let left, up;
  if ((e.flags & F.OFFSET_MASK) === F.OFFSET_SPHERE) { up = perpendicular(fwd); left = cross(up, fwd); }
  else {
    const u = Math.abs(fwd[2]) < 0.999 ? [0, 0, 1] : [0, 1, 0];
    left = cross(u, fwd); normalize(left); up = cross(fwd, left);
  }
  return { origin, axis: [fwd, left, up] };
}
function toWorld(o, p, out) {                                         // FX_OrientationPosToWorldPos
  const A = o.axis;
  for (let k = 0; k < 3; k++) out[k] = o.origin[k] + p[0] * A[0][k] + p[1] * A[1][k] + p[2] * A[2][k];
}

/* ---------- velocity (fx_update.cpp FX_IntegrateVelocity from 0, fx_update_util.cpp FX_GetVelocityAtTime) ---------- */
// a velocity sample: 24 floats = local {velocity base[3], amplitude[3], totalDelta base[3], amplitude[3]}, world {...}
function addFrame(S0, S1, f, w0, w1, life, rl, pos, first) {
  for (let k = 0; k < 3; k++) {
    let v = 0;
    // across segments: + totalDelta(segment) - totalDelta(first segment) (FX_IntegrateVelocityAcrossSegments)
    if (first) v += (rl[k] * S0[f + 9 + k] + S0[f + 6 + k] - rl[k] * first[f + 9 + k] - first[f + 6 + k]) * life;
    v += (rl[k] * S0[f + 3 + k] + S0[f + k]) * w0 + (rl[k] * S1[f + 3 + k] + S1[f + k]) * w1;
    pos[k] += v;
  }
}
function integrate(e, seed, life, t1, orient, local, world) {
  const rl = [RAND[seed], RAND[seed + 1], RAND[seed + 2]], n = e.velIntervalCount, V = e.vel;
  if (!V || !n) { toWorld(orient, local, world); return; }
  let i0, l1, across;
  if (n === 1) { i0 = 0; l1 = t1; across = false; }
  else {
    const end = n * t1;
    i0 = Math.max(0, Math.min(n - 1, Math.ceil(end) - 1)); l1 = end - i0; across = i0 > 0;
  }
  const w1b = 0.5 * l1 * l1 * life, w1a = l1 * life - w1b, first = across ? V[0] : null;
  if (e.flags & F.LOCAL_VEL) addFrame(V[i0], V[i0 + 1], 0, w1a, w1b, life, rl, local, first);
  toWorld(orient, local, world);
  if (e.flags & F.WORLD_VEL) addFrame(V[i0], V[i0 + 1], 12, w1a, w1b, life, rl, world, first);
}
function velocityAt(e, seed, life, elapsed, orient, base, out) {      // + the element's base velocity
  const n = e.velIntervalCount, V = e.vel, rl = [RAND[seed], RAND[seed + 1], RAND[seed + 2]];
  out[0] = base[0]; out[1] = base[1]; out[2] = base[2];
  if (!V || !n) return;
  const sp = n * Math.min(elapsed / life, 0.99999), i = Math.floor(sp), w1 = n * (sp - i), w0 = n - w1;
  const S0 = V[i], S1 = V[i + 1];
  const vel = f => [0, 1, 2].map(k => ((rl[k] * S0[f + 3 + k] + S0[f + k]) * w0 + (rl[k] * S1[f + 3 + k] + S1[f + k]) * w1) * 1000);
  if (e.flags & F.WORLD_VEL) { const w = vel(12); for (let k = 0; k < 3; k++) out[k] += w[k]; }
  if (e.flags & F.LOCAL_VEL) {
    const l = vel(0), A = orient.axis;
    for (let k = 0; k < 3; k++) out[k] += l[0] * A[0][k] + l[1] * A[1][k] + l[2] * A[2][k];
  }
}

/** the velocity curve's displacement after elapsed ms (world): FX_IntegrateVelocity from 0 */
function displacement(e, seed, life, elapsed, orient, out) {
  const local = [0, 0, 0];
  integrate(e, seed, life, elapsed / life, orient, local, out);
  for (let k = 0; k < 3; k++) out[k] -= orient.origin[k];
  return out;
}
/** FX_GetElemAxis: spawn angles + angular velocity x ms (radians), in the element's orientation */
function elemAxis(e, seed, orient, msec) {
  const a = [0, 1, 2].map(k => e.spawnAngles[k][1] * RAND[seed + K.ANGLES + k] + e.spawnAngles[k][0] +
    msec * (e.angularVelocity[k][1] * RAND[seed + K.ANGVEL + k] + e.angularVelocity[k][0]));
  const L = anglesToAxis(a.map(x => x * 180 / Math.PI)), A = orient.axis;
  return L.map(l => [0, 1, 2].map(k => l[0] * A[0][k] + l[1] * A[1][k] + l[2] * A[2][k]));
}
/** FX_GetMsecForSamplingAxis: the rotation slows down within 300 ms after the element came to rest */
function axisMsec(elapsed, rest) {
  if (rest == null || elapsed <= rest) return elapsed;
  const since = elapsed - rest;
  return since < 300 ? elapsed - since * since / 600 : rest + 150;
}

/* ---------- the effect system ---------- */
export class FxSystem {
  /** dir: maps3d/<map>/ -> FxSystem: the map's fx.json and the shared maps3d/_fx/common.json (the
   *  weapons' effects, the impact effects); null if neither exists */
  static async load(dir, lightGrid = null, lights = null, sunIndex = 1) {
    const get = url => fetchJSON(url).catch(err => { if (!/HTTP 404/.test(err.message)) console.warn('effects:', err.message); return null; });
    const [map, common] = await Promise.all([get(dir + 'fx.json'), get('maps3d/_fx/common.json')]);
    if (!map && !common) return null;
    return new FxSystem(map || { effects: [], defs: {}, materials: {} }, common, lightGrid, lights, sunIndex);
  }

  constructor(data, common, lightGrid, lights, sunIndex) {
    this.defs = Object.assign({}, common ? common.defs : {}, data.defs);
    this.weapons = common ? common.weapons : {};
    // the impact table (12 rows: impactType, + 1 for exit wounds; 29 surfaces + 4 flesh kinds); the
    // map's own when its names could be read, else the shared one (they are the same on the stock maps)
    this.impacts = data.impacts || (common && common.impacts) || null;
    const materials = Object.assign({}, common ? common.materials : {}, data.materials);
    this.lightGrid = lightGrid;
    this.sight = lightGrid && lightGrid.sight;
    this.demo = [];                                 // effects of the demo, sorted by start time
    this.lasting = [];                              // ... those that never end (looping)
    this.shots = null;
    this.lights = [];
    this.sunColor = lights && lights[sunIndex] ? lights[sunIndex].color : [1, 1, 1];
    this.lightCache = new Map();
    this.durations = new Map();
    this.group = new THREE.Group();
    this.group.name = 'ambient effects';
    this.count = 0;
    // one mesh per material: the effect shaders (colour = texture x vertex colour; the additive ones
    // multiply by alpha: rgb x a, blended one / one)
    this.batches = new Map();
    const loader = new THREE.TextureLoader();
    for (const [name, m] of Object.entries(materials)) {
      if (m.skip || m.missing) continue;
      // additive (the destination factor one: one/one, srcalpha/one, invdestcolor/one - order-independent,
      // not sorted); the colour times alpha in the shader where the source factor has no alpha (blend.js)
      const add = (blendFactors(m.blend) || [])[1] === 'one', decal = /^[mw]c\//.test(name);
      const premul = premultiplies(m.blend);
      const tex = m.texture ? loadTexture('maps3d/' + m.texture, loader) : null;
      if (tex) { tex.flipY = false; tex.colorSpace = THREE.NoColorSpace; }
      const tint = m.colorTint || [1, 1, 1, 1];
      // the game's blend factors (blend.js) - an unmapped one (e.g. invdestcolor/one, the light beams and
      // fire balls) drawn with normal blending showed its black texels as black cards
      // (one/invsrcalpha: normal blending of the plain colour - the same as the premultiplied colour with
      // one / invsrcalpha; the ShaderMaterial premultiplies itself where premul says so)
      const blend = blendOptions(m.blend || 'srcalpha/invsrcalpha');
      delete blend.premultipliedAlpha;
      const mat = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: tex }, uTint: { value: new THREE.Vector4(...tint) } },
        vertexShader: `
attribute vec4 color;
varying vec2 vUv; varying vec4 vColor;
void main() { vUv = uv; vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
uniform sampler2D uMap; uniform vec4 uTint;
varying vec2 vUv; varying vec4 vColor;
void main() {
  ${tex ? 'vec4 t = texture2D(uMap, vUv);' : 'float r = length(vUv * 2.0 - 1.0); vec4 t = vec4(1.0, 1.0, 1.0, clamp(1.0 - r, 0.0, 1.0));'}
  vec4 c = t * vColor * uTint;
  ${premul ? 'gl_FragColor = vec4(c.rgb * c.a, c.a);' : 'gl_FragColor = c;'}
}`,
        side: THREE.DoubleSide, depthTest: true, ...blend,
        // marks lie on the world's surfaces: pulled towards the camera in depth
        ...(decal ? { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 } : {}),
      });
      const geo = new THREE.BufferGeometry();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = decal ? 5 : add ? 11 : 10;
      mesh.name = 'fx ' + name;
      this.group.add(mesh);
      this.batches.set(name, { mesh, add, cap: 0, n: 0, list: [] });
    }
    // the placements: spawned at delay x 1000 ms of the game's clock (the demo's server time)
    this.effects = data.effects.map((p, i) => {
      const def = this.defs[p.fx];
      const axis = anglesToAxis(p.angles);
      return { def, frame: { origin: p.origin, axis }, begin: Math.round(p.delay * 1000), seed: (i * 7919 + 13) % SEEDS,
        light: def && def.flags & 1 ? this.packedLighting(p.origin) : null };
    }).filter(e => e.def);
    this.tmp = { local: [0, 0, 0], world: [0, 0, 0], vel: [0, 0, 0], base: [0, 0, 0], d: [0, 0, 0] };
    this.penetration = common ? common.penetration || null : null;
    this.paths = new Map();                         // colliding elements: their simulated paths
    this.models = [];                               // debris models of this frame
    this.modelPool = new Map();                     // name -> meshes
    this.modelLib = null;
    this.simPerFrame = SIM_PER_FRAME;               // the video export lifts the budget (every frame complete)
    this.ready = false;                             // every shot traced (setWorld), or no world
  }

  /** the library of the effects' debris models (characters.js CharacterLibrary: maps3d/_characters) */
  setModels(library, onChange = null) { this.modelLib = library; this.onChange = onChange; }

  /** the effects the demo records (M: app/match.js Match), on the game's clock (server time) */
  setDemo(M) {
    const d = M.d, t0 = (d.meta && d.meta.firstServerTime) || 0;
    this.t0 = t0;
    // the players' bone boxes for the traced shots (hitboxes.js)
    this.hitBoxes = new HitBoxes();
    this.hitBoxLoad = this.hitBoxes.loadFor(M).catch(() => null);
    const { list: events } = demoEffectList(M, this.defs, this.weapons, this.impacts);
    const list = events.map((e, i) => {
      const def = this.defs[e.name];
      return { def, frame: { origin: e.origin, axis: e.axis }, begin: t0 + e.t, seed: useed((t0 + e.t) * 7 + i * 131),
        light: def.flags & 1 ? this.packedLighting(e.origin) : null, dur: this.duration(def) };
    });
    // CG_PlayBoltedEffect: the weapon's projTrailEffect on its projectile (rockets, launched grenades),
    // moving with it; FX_StopEffect at the detonation ends the looping elements
    for (const g of d.grenades || []) {
      const W = this.weapons[g.weapon], def = W && W.trail && this.defs[W.trail];
      if (!def || !g.segments || !g.segments.length) continue;
      const a = g.launch != null ? g.launch : g.first, b = g.detonation ? g.detonation.t : g.last;
      const start = projectileFrame(g, a);
      if (!start || b <= a) continue;
      list.push({ def, frame: start, track: ms => projectileFrame(g, ms - t0), begin: t0 + a, stopAt: t0 + b,
        seed: useed((t0 + a) * 11 + 7), light: def.flags & 1 ? this.packedLighting(start.origin) : null,
        dur: b - a + this.tail(def), trail: true });
    }
    this.marks = [];
    for (const e of list) this.addMarks(e);
    this.lasting = list.filter(e => !(e.dur < 1e8));
    this.demo = list.filter(e => e.dur < 1e8).sort((a, b) => a.begin - b.begin);
    this.maxDur = this.demo.reduce((m, e) => Math.max(m, e.dur), 0);
    // muzzle flashes: every shot seen, per client (the frame is the weapon's tag_flash at draw time)
    this.shots = [];
    for (const [cl, times] of Object.entries(d.shotsSeen || {})) this.shots.push({ cl: +cl, times });
    this.M = M;
    this.flashDur = new Map();
    // the server's flesh impacts per shooter (?shots=server): impact rows [t, x, y, z, dir, surface, weapon,
    // flags, shooter], surface 7 = flesh
    this.serverHits = new Map();
    if (SERVER_SHOTS) {
      for (const r of (d.fx3d && d.fx3d.impacts) || []) {
        if (r[5] !== 7) continue;
        if (!this.serverHits.has(r[8])) this.serverHits.set(r[8], []);
        this.serverHits.get(r[8]).push({ t: r[0], p: [r[1], r[2], r[3]] });
      }
    }
  }

  /** the server's flesh hit of shooter cl nearest to the shot at ts (within 100 ms), or null */
  serverHitNear(cl, ts) {
    let best = null;
    for (const h of this.serverHits.get(cl) || []) {
      const dt = Math.abs(h.t - ts);
      if (dt <= SERVER_HIT_MS && (!best || dt < Math.abs(best.t - ts))) best = h;
    }
    return best;
  }

  /** FX_CalculatePackedLighting / R_GetAverageLightingAtPoint: the grid colour at the point plus the
   *  sun x its visibility, as 5:6:5 -> [r, g, b] 0..255 */
  packedLighting(o) {
    const key = Math.round(o[0] / 16) + ',' + Math.round(o[1] / 16) + ',' + Math.round(o[2] / 16);
    let c = this.lightCache.get(key);
    if (c) return c;
    c = null;                                       // no grid: unlit
    const out = {};
    if (this.lightGrid && this.lightGrid.sample(o[0], o[1], o[2], out) && out.block) {
      // the corners' colours averaged, alpha = the sun's visibility; when the primary light is not
      // the sun the game takes black with alpha 128
      const avg = [0, 0, 0], sun = out.light === this.lightGrid.sunIndex;
      if (sun) for (let t = 0; t < 64; t++) for (let k = 0; k < 3; k++) avg[k] += out.block[4 * t + k] / 64;
      const sunA = sun ? out.sun * 255 : 128;
      c = avg.map((v, k) => Math.max(0, Math.min(255, Math.floor(this.sunColor[k] * sunA * 0.5 + v))));
      c = c.map(v => (v & 0xF8) | (v >> 5));                      // 5:6:5 packing and unpacking (approximately)
    }
    this.lightCache.set(key, c);
    return c;
  }

  /** the longest an element of def lasts after it was spawned (delay + life; runners: their effect) */
  tail(def) {
    let d = 0;
    for (const e of def.elems) {
      const delay = Math.max(0, e.spawnDelayMsec[0] + e.spawnDelayMsec[1]);
      d = Math.max(d, delay + (e.type === T.RUNNER ? this.runnerDuration(e) : e.lifeSpanMsec[0] + e.lifeSpanMsec[1]));
    }
    return d;
  }

  /** the frame of an effect at game time ms: a moving one (track) where its bolt is, else its frame */
  frameOf(eff, ms) { return (eff.track && eff.track(ms)) || eff.frame; }

  /** the longest time an effect of def can still show something after it started (ms) */
  duration(def) {
    let d = this.durations.get(def);
    if (d != null) return d;
    this.durations.set(def, Infinity);              // recursion guard
    const [nLoop] = def.counts;
    d = 0;
    def.elems.forEach((e, i) => {
      const delay = Math.max(0, e.spawnDelayMsec[0] + e.spawnDelayMsec[1]), life = e.lifeSpanMsec[0] + e.lifeSpanMsec[1];
      let tail = delay + life;
      if (e.type === T.RUNNER) tail = delay + Math.max(0, ...e.visuals.map(v => v.effect && this.defs[v.effect] ? this.duration(this.defs[v.effect]) : 0));
      const spawnEnd = i < nLoop ? Math.min(def.msecLoopingLife, e.spawn[1] >= INF ? Infinity : e.spawn[0] * (e.spawn[1] - 1)) : 0;
      d = Math.max(d, spawnEnd + tail);
    });
    this.durations.set(def, d);
    return d;
  }

  /** compute and upload all particles alive at time t (ms, the game's clock: the server time) for the
   *  camera; muzzle(cl): the frame of client cl's tag_flash now ({origin, axis}) or null */
  update(t, camera, muzzle = null, opts = {}) {
    this.cam = camera.position;
    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    this.camRight = [m[0], m[1], m[2]]; this.camUp = [m[4], m[5], m[6]];
    for (const b of this.batches.values()) b.list.length = 0;
    this.count = 0;
    this.lights.length = 0;
    this.models.length = 0;
    this.sims = 0;
    if (this.paths.size > 30000) this.paths.clear();
    t = Math.floor(t);
    if (opts.ambient !== false) for (const eff of this.effects) this.effect(eff, t, 0);
    if (opts.demo !== false) {
      for (const eff of this.lasting) this.effect(eff, t, 0);
      // the demo's effects that started in the last maxDur ms
      const D = this.demo;
      let lo = 0, hi = D.length;
      while (lo < hi) { const k = (lo + hi) >> 1; if (D[k].begin < t - this.maxDur) lo = k + 1; else hi = k; }
      for (let i = lo; i < D.length && D[i].begin <= t; i++) if (t - D[i].begin <= D[i].dur) this.effect(D[i], t, 0);
      if (muzzle && this.shots) this.flashes(t, muzzle);
      if (this.tracer && this.shots && opts.impacts !== false) this.worldImpacts(t);
      this.drawMarks(t);
    }
    for (const b of this.batches.values()) this.upload(b);
    this.drawModels();
    this.setLights();
  }

  /** the obstacles of the bullet and debris traces (trace.js): the map's render world without the decal
   *  groups, with each triangle's surface type (world.json groups "surface"), and the props' collision
   *  triangles (props.js propCollision: the models' own collision surfaces and their surface types) */
  setWorld(world) {
    const geo = world && world.mesh && world.mesh.geometry;
    if (!geo || !geo.index) return;
    const tracer = worldTracer(geo.attributes.position.array, geo.index.array, world.info.groups, world.props ? world.props.collision() : null);
    this.propTriangles = tracer.propTriangles;
    this.tracer = tracer;
    this.impactCache = new Map();
    // the hierarchy is built when the browser is idle, not on the first shot; then every shot is traced
    // once (the bullet holes stay for the round)
    setTimeout(async () => {
      if (this.hitBoxLoad) await this.hitBoxLoad;                     // the players' boxes first
      if (this.animLoad) await Promise.race([this.animLoad, new Promise(r => setTimeout(r, 20000))]);   // and their animations
      if (!this.tracer || !this.shots) return;
      this.tracer.build();
      for (const { cl, times } of this.shots) for (const ts of times) {
        const key = cl * 1e7 + ts;
        if (this.impactCache.has(key)) continue;
        const hits = this.traceShot(cl, ts);
        this.impactCache.set(key, hits);
        for (const h of hits || []) this.addMarks(h);
      }
      this.marksSorted = false;
      this.ready = true;
    }, 1500);
  }

  /** CG_DrawBulletImpacts: the impacts of every shot on the world, as the client guesses them for
   *  the other players - from the eye along the view, the spread of the weapon for the stance
   *  (CG_GuessSpreadForWeapon) scaled by the speed, the random of CG_BulletEndpos - traced against the
   *  world; the effect is the impact table's for the weapon and the surface hit */
  worldImpacts(t) {
    const M = this.M, rel = t - this.t0;
    for (const { cl, times } of this.shots) {
      let lo = 0, hi = times.length;
      while (lo < hi) { const k = (lo + hi) >> 1; if (times[k] < rel - IMPACT_MS) lo = k + 1; else hi = k; }
      for (let i = lo; i < times.length && times[i] <= rel; i++) {
        const key = cl * 1e7 + times[i];
        let hits = this.impactCache.get(key);
        if (hits === undefined) {
          hits = this.traceShot(cl, times[i]); this.impactCache.set(key, hits);
          for (const h of hits || []) this.addMarks(h);
          this.marksSorted = false;
        }
        for (const h of hits || []) {
          if (rel - times[i] > this.duration(h.def)) continue;
          this.effect(h, t, 0);
        }
      }
    }
  }

  /** the obstacles at the demo time rel (ms): the world, and the script models where they stand then */
  tracerAt(rel) { return this.scripts && this.scripts.tracerFor ? this.scripts.tracerFor(this.tracer, rel) : this.tracer; }

  traceShot(cl, ts) {
    const tv = ts - CLIENT_LAG;                        // the client's frame: players and cars where it shows them
    const hits = shotImpacts(this.M, this.weapons, this.impacts, shotTracer(this.tracerAt(tv), this.M, tv, cl, this.hitBoxes), cl, ts, this.penetration,
      this.hitBoxes ? this.hitBoxes.adsTest() : null,
      { lag: CLIENT_LAG, seed: true, own: true, muzzle: this.hitBoxes ? (c, t, s) => this.hitBoxes.muzzle(c, t, s) : null });
    if (!hits) return null;
    // ?shots=server: the shot ends at the server's hit of this shooter
    const sh = SERVER_SHOTS && hits.start ? this.serverHitNear(cl, ts) : null;
    if (sh) {
      const d = p => Math.hypot(p[0] - hits.start[0], p[1] - hits.start[1], p[2] - hits.start[2]), dh = d(sh.p);
      const kept = hits.filter(h => d(h.point) < dh - 4);
      kept.start = hits.start;
      kept.end = sh.p;
      hits.length = 0;
      hits.push(...kept);
      hits.end = sh.p;
    }
    if (!hits.length) return Object.assign([], { sounds: [], line: hits.start && hits.end ? [hits.start, hits.end] : null });
    const out = [];
    const sounds = [];                          // (sound.js: every hit, also those without an effect)
    hits.forEach((h, k) => {
      sounds.push({ point: h.point, surface: h.surface, exit: !!h.exit, impactType: h.impactType });
      const def = h.name && this.defs[h.name];
      if (!def) return;
      const begin = this.t0 + ts;
      out.push({ def, frame: { origin: h.point, axis: axisFromDir(h.normal) }, begin, seed: useed(begin * 5 + k * 97 + cl),
        light: def.flags & 1 ? this.packedLighting(h.point) : null, surface: h.surface });
    });
    out.sounds = sounds;
    out.line = hits.start && hits.end ? [hits.start, hits.end] : null;  // the first bullet's path (whizby)
    return out;
  }

  /** CG_FireWeapon: the weapon's world muzzle flash at its tag_flash for every shot of the last moments */
  flashes(t, muzzle) {
    const M = this.M, rel = t - this.t0;
    for (const { cl, times } of this.shots) {
      let lo = 0, hi = times.length;
      while (lo < hi) { const k = (lo + hi) >> 1; if (times[k] < rel - 400) lo = k + 1; else hi = k; }
      for (let i = lo; i < times.length && times[i] <= rel; i++) {
        const W = this.weapons[M.weaponName(M.sampleAt(cl, times[i]) ? M.sampleAt(cl, times[i]).weapon : 0, times[i])];
        const def = W && W.flash && this.defs[W.flash];
        if (!def || rel - times[i] > this.duration(def)) continue;
        const frame = muzzle(cl);
        if (!frame) continue;
        // the flash itself lives a few ms (the game draws it in the frame of the shot); shots are known to
        // the snapshot (50 ms): it shows for the first FLASH_MS, at the shot's own moment
        const begin = this.t0 + times[i], age = rel - times[i];
        this.effect({ def, frame, begin, seed: useed(begin * 3 + cl * 17), light: null, transient: true }, age < FLASH_MS ? begin + 1 : t, 0);
      }
    }
    if (this.casings !== false) this.shellEjects(t, muzzle);
  }

  /** CG_EjectWeaponBrass: the weapon's worldShellEjectEffect at its tag_brass for every shot (the casings
   *  fly, bounce and lie on the ground for their life). The frame is the tag's at the first frame drawn
   *  after the shot, kept for the shot (a casing in the air does not follow the gun) */
  shellEjects(t, muzzle) {
    const M = this.M, rel = t - this.t0;
    const frames = this.brassFrames || (this.brassFrames = new Map());
    if (frames.size > 4000) frames.clear();
    for (const { cl, times } of this.shots) {
      let lo = 0, hi = times.length;
      while (lo < hi) { const k = (lo + hi) >> 1; if (times[k] < rel - BRASS_MS) lo = k + 1; else hi = k; }
      for (let i = lo; i < times.length && times[i] <= rel; i++) {
        const smp = M.sampleAt(cl, times[i]);
        const W = this.weapons[M.weaponName(smp ? smp.weapon : 0, times[i])];
        const def = W && W.shellEject && this.defs[W.shellEject];
        if (!def || rel - times[i] > this.duration(def)) continue;
        const key = cl * 1e7 + times[i];
        let eff = frames.get(key);                    // one effect per shot: its casings' bounce paths are kept
        if (!eff || eff.def !== def) {
          const frame = muzzle(cl, 'tag_brass');
          if (!frame) continue;
          const begin = this.t0 + times[i];
          eff = { def, frame, begin, seed: useed(begin * 5 + cl * 31), light: def.flags & 1 ? this.packedLighting(frame.origin) : null };
          frames.set(key, eff);
        }
        this.effect(eff, t, 0);
      }
    }
  }

  /** FX_CreateImpactMark: the marks (decal elements) an effect leaves: the world material of a random
   *  material pair, size, colour and rotation of the element's first visual state, on the plane of the
   *  effect's frame (axis 0 = the surface normal). They stay until the round ends (map_restart) */
  addMarks(eff) {
    const def = eff.def, [nLoop, nOne] = def.counts;
    for (let i = nLoop; i < nLoop + nOne; i++) {
      const e = def.elems[i];
      if (e.type !== T.DECAL || !e.vis || !e.visualCount) continue;
      const n = e.spawn[0] + (e.spawn[1] ? rint(e.spawn[1], RAND16[eff.seed + K.COUNT]) : 0);
      for (let k = 0; k < n; k++) {
        let begin = e.spawnDelayMsec[0] + eff.begin;
        if (e.spawnDelayMsec[1]) begin += rint(e.spawnDelayMsec[1], RAND16[useed(296 * k + begin + eff.seed) + K.DELAY]);
        const seed = useed(begin + eff.seed + 296 * (k & 0xFF));
        const pair = (e.visualCount * RAND16[seed + K.VISUAL]) >>> 16;
        // the pair: model material, world material (FX_ImpactMark gets both; world surfaces use the latter)
        const pairVis = [e.visuals[2 * pair + 1], e.visuals[2 * pair]].filter(v => v && v.material && this.batches.has(v.material));
        const vis = pairVis.find(v => /^wc\//.test(v.material)) || pairVis[0];
        const batch = vis && this.batches.get(vis.material);
        if (!batch) continue;
        const A0 = e.vis[0], vl = RAND[seed + K.COLOR], vli = 1 - vl;
        const col = [0, 1, 2, 3].map(c => Math.round(A0.base.color[c] * vli + A0.amplitude.color[c] * vl));
        const size = RAND[seed + K.SIZE0] * A0.amplitude.size[0] + A0.base.size[0];
        const rv = RAND[seed + K.ROTATION_DELTA];
        const rot = e.initialRotation[1] * RAND[seed + K.COLOR] + e.initialRotation[0] + (rv * A0.amplitude.rotationTotal + A0.base.rotationTotal);
        if (size <= 0) continue;
        const A = eff.frame.axis, o = eff.frame.origin, c = Math.cos(rot), sn = Math.sin(rot);
        // a mark is drawn with the surface's light (the game's marks take the lightmap of the surface
        // they lie on): here the light at the point, as for lit effects
        const L = this.packedLighting(o) || [255, 255, 255];
        // (the models' rule: light = 2 x the grid colour)
        for (let ch = 0; ch < 3; ch++) col[2 - ch] = Math.min(255, Math.round(col[2 - ch] * 2 * L[ch] / 255));
        const rt = [0, 1, 2].map(j => c * A[1][j] + sn * A[2][j]), rb = [0, 1, 2].map(j => sn * A[1][j] - c * A[2][j]);
        this.marks.push({ begin, batch, q: { p: [o[0] + A[0][0] * 0.5, o[1] + A[0][1] * 0.5, o[2] + A[0][2] * 0.5], rt, rb, s0: size, s1: size,
          uv: [0, 0, 1, 1], col: [col[2] / 255, col[1] / 255, col[0] / 255, col[3] / 255], d2: 0 } });
      }
    }
  }

  /** the marks of the round at t (the last MAX_MARKS), into their batches */
  drawMarks(t) {
    if (!this.marks || !this.marks.length) return;
    if (!this.marksSorted) { this.marks.sort((a, b) => a.begin - b.begin); this.marksSorted = true; }
    const rel = t - this.t0, rounds = (this.M && this.M.d.rounds) || [];
    const r = rounds.find(x => rel >= x.segStart && rel < x.segEnd);
    const from = this.t0 + (r ? r.segStart : 0);
    const M = this.marks;
    let hi = M.length;
    { let lo = 0, h = M.length; while (lo < h) { const k = (lo + h) >> 1; if (M[k].begin <= t) lo = k + 1; else h = k; } hi = lo; }
    for (let i = hi - 1, n = 0; i >= 0 && n < MAX_MARKS && M[i].begin >= from; i--, n++) M[i].batch.list.push(M[i].q);
  }

  /** the strongest lights of the effects -> DLIGHTS (lighting.js) */
  setLights() {
    const L = this.lights;
    for (const l of L) l.score = (l.color[0] * 0.3 + l.color[1] * 0.59 + l.color[2] * 0.11) * l.radius /
      (1 + Math.hypot(l.pos[0] - this.cam.x, l.pos[1] - this.cam.y, l.pos[2] - this.cam.z));
    L.sort((a, b) => b.score - a.score);
    const n = Math.min(DL_MAX, L.length);
    for (let i = 0; i < n; i++) {
      DLIGHTS.pos.value[i].set(L[i].pos[0], L[i].pos[1], L[i].pos[2], 1 / L[i].radius);
      DLIGHTS.color.value[i].set(L[i].color[0], L[i].color[1], L[i].color[2]);
    }
    DLIGHTS.count.value = n;
  }

  /** FX_SpawnTrailLoopingElems: a moving effect's trail elements - one where it starts, then one every
   *  splitDist units of its path (the track sampled every TRAIL_STEP ms), up to its stop -> [{ms, dist}]
   *  (game time, distance travelled), kept on the effect */
  trailSpawns(eff, index, split) {
    const cache = eff.trails || (eff.trails = new Map());
    let list = cache.get(index);
    if (list) return list;
    list = [{ ms: eff.begin, dist: 0 }];
    const end = Math.min(eff.stopAt != null ? eff.stopAt : eff.begin + 60000, eff.begin + 60000);
    let prev = this.frameOf(eff, eff.begin).origin, dist = 0, next = split;
    for (let ms = eff.begin + TRAIL_STEP; ms <= end && list.length < 4000; ms = Math.min(end, ms + TRAIL_STEP)) {
      const o = this.frameOf(eff, ms).origin, seg = Math.hypot(o[0] - prev[0], o[1] - prev[1], o[2] - prev[2]);
      while (seg > 0 && dist + seg >= next) {
        const f = (next - dist) / seg;
        list.push({ ms: Math.round(ms - TRAIL_STEP + TRAIL_STEP * f), dist: next });
        next += split;
      }
      dist += seg; prev = o;
      if (ms >= end) break;
    }
    cache.set(index, list);
    return list;
  }

  /** FX_DrawTrail: the trail elements alive at t as the ribbon's sections - each the trail's cross-section
   *  (FxTrailVertex pos x size along the basis the effect had at the element's spawn, rotated by the
   *  element's rotation; FX_GenTrail_VertsForSegment), joined to the next by the index pairs
   *  (FX_GenTrail_IndsForSegment). u = distance / repeatDist (+ scrolling), v = the vertex's texCoord; the
   *  first section of a trail is transparent, a section that just died leaves an interpolated tail */
  trail(eff, e, index, t) {
    const td = e.trail;
    if (td.verts.length < 2 || td.inds.length < 2 || td.splitDist <= 0 || !e.vis) return;
    const vis = e.visuals[0], batch = vis && vis.material && this.batches.get(vis.material);
    if (!batch) return;
    const spawns = this.trailSpawns(eff, index, td.splitDist), segs = [];
    let last = null, lastNorm = 1, uOff = null;
    for (let k = 0; k < spawns.length; k++) {
      const sp = spawns[k];
      let begin = sp.ms + e.spawnDelayMsec[0];
      if (e.spawnDelayMsec[1]) begin += rint(e.spawnDelayMsec[1], RAND16[useed(begin + eff.seed + 296 * k) + K.DELAY]);
      if (begin > t) break;
      const seed = useed(296 * k + begin + eff.seed);
      const life = e.lifeSpanMsec[0] + rint(e.lifeSpanMsec[1], RAND16[seed + K.LIFE]);
      if (life <= 0) continue;
      const elapsed = t - begin, normTime = elapsed / life;
      if (normTime >= 1 && (k + 1 >= spawns.length || spawns[k + 1].ms > t)) { lastNorm = normTime; last = null; continue; }
      if (uOff === null) {
        uOff = -Math.floor(sp.dist / td.repeatDist);
        if (td.scrollTimeMsec) uOff += td.scrollTimeMsec > 0 ? (t % td.scrollTimeMsec) / td.scrollTimeMsec : 1 - (t % -td.scrollTimeMsec) / -td.scrollTimeMsec;
      }
      const state = this.trailSection(eff, e, index, sp, k, seed, begin, life, Math.min(elapsed, life), t, td, uOff);
      if (!state) continue;
      if (normTime < 1) {
        if (k === 0) state.col[3] = 0;                                // the trail's first section
        else if (lastNorm >= 1 && last) {                             // a tail towards the section that just died
          const a = (lastNorm - 1) / (lastNorm - normTime), mix = (x, y) => x + (y - x) * a;
          segs.push({ p: last.p.map((v, j) => mix(v, state.p[j])), l: last.l.map((v, j) => mix(v, state.l[j])), up: last.up.map((v, j) => mix(v, state.up[j])),
            size: state.size, col: state.col, u: mix(last.u, state.u) });
        }
        segs.push(state);
      }
      lastNorm = normTime; last = state;
    }
    if (segs.length < 2) return;
    const V = td.verts, I = td.inds;
    const corner = (sg, v) => [sg.p[0] + v[0] * sg.size[0] * sg.l[0] + v[1] * sg.size[1] * sg.up[0],
      sg.p[1] + v[0] * sg.size[0] * sg.l[1] + v[1] * sg.size[1] * sg.up[1], sg.p[2] + v[0] * sg.size[0] * sg.l[2] + v[1] * sg.size[1] * sg.up[2]];
    for (let s0 = 0; s0 + 1 < segs.length && this.count < MAX_PARTICLES; s0++) {
      const A = segs[s0], B = segs[s0 + 1];
      const d2 = (A.p[0] - this.cam.x) ** 2 + (A.p[1] - this.cam.y) ** 2 + (A.p[2] - this.cam.z) ** 2;
      for (let j = 0; j + 1 < I.length; j += 2) {
        const v0 = V[I[j]], v1 = V[I[j + 1]];
        if (!v0 || !v1) continue;
        batch.list.push({ quad: [corner(A, v0), corner(A, v1), corner(B, v1), corner(B, v0)],
          uvq: [A.u, v0[4], A.u, v1[4], B.u, v1[4], B.u, v0[4]], colq: [A.col, A.col, B.col, B.col].map(c => [c[2] / 255, c[1] / 255, c[0] / 255, c[3] / 255]), d2 });
        this.count++;
      }
    }
  }

  /** one section of a trail: the element's position (world-space element, from the frame where it was
   *  spawned), basis, size, colour (BGRA bytes incl. lighting and distance fade) and u coordinate */
  trailSection(eff, e, index, sp, k, seed, begin, life, elapsed, t, td, uOff) {
    const pl = this.place(eff, e, index, sp.ms, k, seed, begin, life, elapsed, t);
    if (!pl) return null;
    const p = [pl.world[0], pl.world[1], pl.world[2]], A = this.frameOf(eff, sp.ms).axis;
    const S = e.vis, norm = elapsed / life;
    const spn = e.visStateIntervalCount * norm, si = Math.min(Math.floor(spn), S.length - 2), sl = spn - si, sli = 1 - sl;
    const A0 = S[si], A1 = S[si + 1];
    const vl = RAND[seed + K.COLOR], vli = 1 - vl;
    const col = [0, 1, 2, 3].map(c => Math.round(sl * (A1.base.color[c] * vli + A1.amplitude.color[c] * vl) + sli * (A0.base.color[c] * vli + A0.amplitude.color[c] * vl)));
    const sizeAt = (c, key) => { const r = RAND[seed + key]; return (r * A0.amplitude.size[c] + A0.base.size[c]) * sli + (r * A1.amplitude.size[c] + A1.base.size[c]) * sl; };
    const size0 = sizeAt(0, K.SIZE0), size1 = e.flags & F.NONUNIFORM ? sizeAt(1, K.SIZE1) : size0;
    if (e.lightingFrac && eff.light) {
      for (let c = 0; c < 3; c++) {
        const f = Math.floor((2 * eff.light[c] - 255) * e.lightingFrac / 255) + 255;
        col[2 - c] = Math.max(0, Math.min(255, Math.floor(f * col[2 - c] / 255)));
      }
    }
    if (e.fadeInRange[1] || e.fadeOutRange[1]) {
      const d = Math.hypot(p[0] - this.cam.x, p[1] - this.cam.y, p[2] - this.cam.z);
      const lerp = r => { const b = d - r[0]; return b < 0 ? 1 : r[1] > b ? 1 - b / r[1] : 0; };
      const fin = e.fadeInRange[1] ? lerp(e.fadeInRange) : 1, fout = e.fadeOutRange[1] ? 1 - lerp(e.fadeOutRange) : 1;
      col[3] = (Math.floor(Math.min(fin, fout) * 255 + 0.5) * col[3]) >> 8;
    }
    const rv = RAND[seed + K.ROTATION_DELTA], w4 = sl * sl * 0.5, w = sl - w4;
    const rot = e.initialRotation[1] * RAND[seed + K.COLOR] + e.initialRotation[0] +
      ((rv * A0.amplitude.rotationTotal + A0.base.rotationTotal) + (rv * A0.amplitude.rotationDelta + A0.base.rotationDelta) * w +
       (rv * A1.amplitude.rotationDelta + A1.base.rotationDelta) * w4) * life;
    const c = Math.cos(rot), sn = Math.sin(rot), b0 = A[1], b1 = A[2];
    return { p, l: [0, 1, 2].map(j => c * b0[j] + sn * b1[j]), up: [0, 1, 2].map(j => sn * b0[j] - c * b1[j]),
      size: [size0, size1], col, u: sp.dist / td.repeatDist + uOff };
  }

  /** where an element is elapsed ms after its spawn (now = the game time, for elements that move with
   *  their effect): the spawn origin (FX_GetOriginForElem, in the effect's frame when it was played)
   *  moved by the velocity curve and gravity, or along its simulated bounces -> {orient, world, baseVel,
   *  rest} (this.tmp arrays, valid until the next call) or null (died on touch) */
  place(eff, e, index, played, sequence, seed, begin, life, elapsed, now) {
    const run = e.flags & F.RUN_MASK, frame = run ? this.frameOf(eff, now) : this.frameOf(eff, played), orient = orientation(e, frame, seed);
    const local = this.tmp.local, world = this.tmp.world;
    if (run === F.RUN_OFFSET) { local[0] = 0; local[1] = 0; local[2] = 0; }
    else {
      spawnOrigin(e, frame, seed, local);
      if (run) {                                                      // relative to the effect: in its frame
        const d = [local[0] - frame.origin[0], local[1] - frame.origin[1], local[2] - frame.origin[2]], A = frame.axis;
        for (let k = 0; k < 3; k++) local[k] = d[0] * A[k][0] + d[1] * A[k][1] + d[2] * A[k][2];
      }
    }
    if (elapsed > 0) integrate(e, seed, life, elapsed / life, orient, local, world);
    else toWorld(orient, local, world);
    const baseVel = this.tmp.base;
    baseVel[0] = 0; baseVel[1] = 0; baseVel[2] = 0;
    let rest = null;
    const path = e.flags & F.COLLIDE && this.tracer && this.tracer.built ? this.bouncePath(eff, e, index, sequence, seed, begin, life, played) : null;
    if (path) {                                                       // bounces off the world (FX_CollisionResponse)
      if (path.die != null && elapsed >= path.die) return null;
      rest = path.rest ? path.rest.t : null;
      this.pathAt(path, e, seed, life, elapsed, orient, world, baseVel);
    } else if (e.flags & (F.LOCAL_VEL | F.WORLD_VEL | F.COLLIDE)) {
      const g = e.gravity[1] * RAND[seed + K.GRAVITY] + e.gravity[0], s = elapsed / 1000;
      world[2] -= 400 * g * s * s;
      baseVel[2] = -800 * g * s;
      if (e.flags & F.COLLIDE) {                                      // until simulated: stops on the ground
        const gz = this.groundOf(eff);
        if (gz != null && world[2] < gz + 1) { world[2] = gz + 1; baseVel[2] = 0; }
      }
    }
    return { orient, world, baseVel, rest };
  }

  /** FX_ProcessEmitting over an element's whole life, once: its path sampled every EMIT_STEP ms, an
   *  emission every emitDist + emitDistVariance x random units (the game's rand(); here a random
   *  sequence seeded by the element) -> [{t (ms after the spawn), p, dir, k}], or null (over budget) */
  emissions(eff, e, index, played, sequence, seed, begin, life) {
    const own = !eff.transient && (eff.emits || (eff.emits = new Map()));
    const o = eff.frame.origin;
    const key = own ? index * 1e6 + sequence * 64 + (begin & 63)
      : 'e|' + begin + '|' + eff.seed + '|' + index + '|' + sequence + '|' + Math.round(o[0]) + ',' + Math.round(o[1]) + ',' + Math.round(o[2]);
    const cache = own || this.paths;
    let list = cache.get(key);
    if (list && list.begin === begin) return list.items;
    if (this.sims++ >= this.simPerFrame) return null;
    const base = e.emitDist[1] * RAND[seed + 20] + e.emitDist[0] + e.emitDistVariance[0], vari = e.emitDistVariance[1];
    const items = [];
    if (base + vari > 0.5) {
      let rnd = (seed * 2654435761 + index * 97 + sequence) >>> 0;
      const next = () => { rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0; return (rnd >>> 8) / 16777216; };
      let prev = null, prevT = 0, travelled = 0, goal = base + next() * vari;
      for (let ms = 0; ms <= life && items.length < 400; ms = Math.min(life, ms + EMIT_STEP)) {
        const pl = this.place(eff, e, index, played, sequence, seed, begin, life, ms, begin + ms);
        if (!pl) break;
        const p = [pl.world[0], pl.world[1], pl.world[2]];
        if (prev) {
          const seg = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
          while (seg > 0 && travelled + seg >= goal) {
            const f = (goal - travelled) / seg;
            items.push({ t: Math.floor(prevT + (ms - prevT) * f), p: [0, 1, 2].map(k => prev[k] + (p[k] - prev[k]) * f),
              dir: [p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]], k: items.length });
            goal += base + next() * vari;
          }
          travelled += seg;
        }
        prev = p; prevT = ms;
        if (ms >= life) break;
      }
    }
    cache.set(key, { begin, items });
    return items;
  }

  /** FX_UpdateElementPosition_Colliding for one element, once from its spawn to its end: steps of at
   *  most SIM_STEP ms traced against the world (trace.js); on a hit the velocity (curve + base) is
   *  scaled by the reflection factor and mirrored at the surface (FX_CollisionResponse), elements that
   *  die on touch end there, a slow element hitting a floor at the start of a step comes to rest.
   *  -> {segs: [{t, p, bv, D}], rest: {t, p} | null, die: ms | null, impacts: [{t, p, n}]}, or null
   *  (over this frame's simulation budget) */
  bouncePath(eff, e, index, sequence, seed, begin, life, played = begin) {
    // the cache: on the effect itself (placements, demo effects), by a string key for the runners'
    // effects (new objects every frame)
    const o = eff.frame.origin;
    const own = !eff.transient && (eff.paths || (eff.paths = new Map()));
    const key = own ? index * 1e6 + sequence * 64 + (begin & 63)
      : begin + '|' + eff.seed + '|' + index + '|' + sequence + '|' + Math.round(o[0]) + ',' + Math.round(o[1]) + ',' + Math.round(o[2]);
    const cache = own || this.paths;
    let path = cache.get(key);
    if (path && path.begin === begin) return path;
    if (this.sims++ >= this.simPerFrame) return null;
    const frame = this.frameOf(eff, played), orient = orientation(e, frame, seed), run = e.flags & F.RUN_MASK;
    const local = [0, 0, 0], start = [0, 0, 0];
    if (run !== F.RUN_OFFSET) {
      spawnOrigin(e, frame, seed, local);
      if (run) {
        const d = [local[0] - frame.origin[0], local[1] - frame.origin[1], local[2] - frame.origin[2]], A = frame.axis;
        for (let k = 0; k < 3; k++) local[k] = d[0] * A[k][0] + d[1] * A[k][1] + d[2] * A[k][2];
      }
    }
    toWorld(orient, local, start);
    const g = e.gravity[1] * RAND[seed + K.GRAVITY] + e.gravity[0];
    const rf = e.reflectionFactor[1] * RAND[seed + 16] + e.reflectionFactor[0];
    path = { begin, segs: [{ t: 0, p: start, bv: [0, 0, 0], D: [0, 0, 0] }], rest: null, die: null, impacts: [], orient };
    let a = 0, pos = start.slice(), bv = [0, 0, 0], Da = [0, 0, 0];
    const Db = [0, 0, 0], pre = [0, 0, 0];
    const tracer = this.tracerAt(begin - this.t0);                     // the cars where they stand then
    for (let iter = 0; a < life && iter < 400; iter++) {
      const b = Math.min(a + SIM_STEP, life), dt = (b - a) / 1000;
      displacement(e, seed, life, b, orient, Db);
      const next = [0, 1, 2].map(k => pos[k] + Db[k] - Da[k] + bv[k] * dt);
      next[2] -= 400 * g * dt * dt;
      const hit = tracer.trace(pos, next);
      if (!hit) { pos = next; bv[2] -= 800 * g * dt; a = b; Da[0] = Db[0]; Da[1] = Db[1]; Da[2] = Db[2]; continue; }
      const n = hit.normal, hp = hit.point;
      // a hit within the lift off the surface (below) counts as at the step's start: in contact
      const near = hit.frac * Math.hypot(next[0] - pos[0], next[1] - pos[1], next[2] - pos[2]) < 0.2;
      let on = near ? a : a + Math.floor((b - a) * hit.frac);
      bv[2] -= 800 * g * (on - a) / 1000;
      if (e.flags & F.DIE_ON_TOUCH || on >= life - 1) {
        if (e.effectOnImpact) path.impacts.push({ t: on, p: hp, n });
        path.segs.push({ t: on, p: hp, bv: [0, 0, 0], D: displacement(e, seed, life, on, orient, [0, 0, 0]) });
        path.die = Math.max(on, 1);
        break;
      }
      velocityAt(e, seed, life, on, orient, bv, pre);
      const pl = pre[0] * pre[0] + pre[1] * pre[1] + pre[2] * pre[2];
      const sc = pre.map(v => v * rf);
      if (e.effectOnImpact && pl > 1) path.impacts.push({ t: on, p: hp, n });
      if (on === a) {
        on++;
        if (sc[0] * sc[0] + sc[1] * sc[1] + sc[2] * sc[2] <= 1 && n[2] > 0.7) { path.rest = { t: on, p: hp }; break; }
      }
      const vn = sc[0] * n[0] + sc[1] * n[1] + sc[2] * n[2];
      for (let k = 0; k < 3; k++) bv[k] += sc[k] - 2 * vn * n[k] - pre[k];
      pos = [hp[0] + n[0] * 0.1, hp[1] + n[1] * 0.1, hp[2] + n[2] * 0.1];  // off the surface (the game traces a box)
      a = Math.min(on, life);
      Da = displacement(e, seed, life, a, orient, [0, 0, 0]);
      path.segs.push({ t: a, p: pos, bv: bv.slice(), D: Da.slice() });
    }
    cache.set(key, path);
    this.pathCount = (this.pathCount || 0) + 1;
    return path;
  }

  /** the position of a simulated element at elapsed ms -> world, its velocity's base part -> base */
  pathAt(path, e, seed, life, elapsed, orient, world, base) {
    if (path.rest && elapsed >= path.rest.t) {
      for (let k = 0; k < 3; k++) { world[k] = path.rest.p[k]; base[k] = 0; }
      return;
    }
    const S = path.segs;
    let i = S.length - 1;
    while (i > 0 && S[i].t > elapsed) i--;
    const sg = S[i], dt = (elapsed - sg.t) / 1000, D = displacement(e, seed, life, elapsed, orient, this.tmp.d);
    const g = e.gravity[1] * RAND[seed + K.GRAVITY] + e.gravity[0];
    for (let k = 0; k < 3; k++) { world[k] = sg.p[k] + D[k] - sg.D[k] + sg.bv[k] * dt; base[k] = sg.bv[k]; }
    world[2] -= 400 * g * dt * dt;
    base[2] -= 800 * g * dt;
  }

  /** the debris models of this frame: meshes of the library's models (loaded on first use), lit like
   *  the players by the light grid at their origin */
  drawModels() {
    for (const list of this.modelPool.values()) for (const m of list) m.visible = false;
    if (!this.modelLib) return;
    const used = new Map(), M4 = this.tmpM || (this.tmpM = new THREE.Matrix4());
    for (const d of this.models) {
      const model = this.modelLib.loaded(d.name);
      if (!model) {
        if (!this.modelLib.models.has(d.name)) this.modelLib.available().then(idx => {
          if (idx[d.name]) this.modelLib.load(d.name).then(() => this.onChange && this.onChange()).catch(() => null);
        });
        continue;
      }
      let list = this.modelPool.get(d.name);
      if (!list) this.modelPool.set(d.name, list = []);
      const k = used.get(d.name) || 0;
      used.set(d.name, k + 1);
      let mesh = list[k];
      if (!mesh) {
        const lg = objectLighting();
        mesh = new THREE.Mesh(model.geo, model.mats.map((m, j) => gridLit(m.clone(), lg, model.shadings && model.shadings[j])));
        mesh.userData.lg = lg;
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
        mesh.name = 'fx model ' + d.name;
        this.group.add(mesh);
        list.push(mesh);
      }
      const [f, l, u] = d.axis, s = d.scale, p = d.pos;
      M4.set(f[0] * s, l[0] * s, u[0] * s, p[0], f[1] * s, l[1] * s, u[1] * s, p[1], f[2] * s, l[2] * s, u[2] * s, p[2], 0, 0, 0, 1);
      mesh.matrix.copy(M4);
      mesh.matrixWorldNeedsUpdate = true;
      mesh.visible = true;
      // the light grid at the origin (re-sampled when the model moved)
      const last = mesh.userData.at;
      if (this.lightGrid && (!last || Math.abs(last[0] - p[0]) + Math.abs(last[1] - p[1]) + Math.abs(last[2] - p[2]) > 8)) {
        const smp = {};
        if (this.lightGrid.sample(p[0], p[1], p[2] + 4, smp)) setObjectLighting(mesh.userData.lg, smp);
        mesh.userData.at = p.slice();
      }
    }
  }

  /** the ground under an effect (colliding elements stop there): the first blocking point of the
   *  map's sight model (brushes and terrain) straight below the effect's origin, or null */
  groundOf(eff) {
    if (eff.ground !== undefined) return eff.ground;
    eff.ground = null;
    const S = this.sight, o = eff.frame.origin;
    if (!S) return null;
    const a = [o[0], o[1], o[2] + 1];
    if (!S.blocked(a, [o[0], o[1], o[2] - 4096])) return null;
    let lo = 0, hi = 4096;
    for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2; if (S.blocked(a, [o[0], o[1], a[2] - mid])) hi = mid; else lo = mid; }
    eff.ground = a[2] - hi;
    return eff.ground;
  }

  effect(eff, t, depth) {
    if (t < eff.begin || depth > 4) return;
    const def = eff.def, [nLoop, nOne] = def.counts;
    const elapsed = t - eff.begin;
    for (let i = 0; i < nLoop + nOne; i++) {
      const e = def.elems[i];
      if (e.type === T.TRAIL) { if (eff.track && e.trail && e.trail.verts) this.trail(eff, e, i, t); continue; }
      if (e.type === T.SPOT || e.type === T.SOUND || e.type === T.DECAL) continue;
      if (e.type === T.MODEL && !this.modelLib) continue;
      if (e.spawnRange[1]) {                                          // FX_CullElemForSpawn (also checked per element)
        const o = this.frameOf(eff, t).origin, d = Math.hypot(this.cam.x - o[0], this.cam.y - o[1], this.cam.z - o[2]) - e.spawnRange[0];
        if (d < 0 || d > e.spawnRange[1]) continue;
      }
      if (i < nLoop) {                                                // FX_SpawnLoopingElems: one every intervalMsec
        const interval = Math.max(1, e.spawn[0]), count = e.spawn[1];
        const delayMax = Math.max(0, e.spawnDelayMsec[0] + e.spawnDelayMsec[1]), delayMin = Math.min(0, e.spawnDelayMsec[0]);
        const life = e.type === T.RUNNER ? this.runnerDuration(e) : e.lifeSpanMsec[0] + e.lifeSpanMsec[1];
        let k0 = Math.max(0, Math.ceil((elapsed - life - delayMax) / interval));
        let k1 = Math.floor((elapsed - delayMin) / interval);
        if (count < INF) k1 = Math.min(k1, count - 1);
        if (def.msecLoopingLife < INF) k1 = Math.min(k1, Math.floor(def.msecLoopingLife / interval) + 1);
        if (eff.stopAt != null) k1 = Math.min(k1, Math.floor((eff.stopAt - eff.begin) / interval));   // FX_StopEffect
        if (k1 - k0 > 4000) k0 = k1 - 4000;
        for (let k = k0; k <= k1; k++) this.elem(eff, e, i, eff.begin + k * interval, k, t, depth);
      } else {                                                        // FX_SpawnOneShotElems
        const n = e.spawn[0] + (e.spawn[1] ? rint(e.spawn[1], RAND16[eff.seed + K.COUNT]) : 0);
        for (let k = 0; k < n; k++) this.elem(eff, e, i, eff.begin, k, t, depth);
      }
    }
  }

  runnerDuration(e) {
    return Math.max(0, ...e.visuals.map(v => v.effect && this.defs[v.effect] ? this.duration(this.defs[v.effect]) : 0));
  }

  /** FX_SpawnElem + FX_DrawElement for one element spawned at msecWhenPlayed with this sequence */
  elem(eff, e, index, played, sequence, t, depth) {
    let begin = e.spawnDelayMsec[0] + played;
    if (e.spawnDelayMsec[1]) begin += rint(e.spawnDelayMsec[1], RAND16[useed(296 * sequence + begin + eff.seed) + K.DELAY]);
    if (begin > t) return;
    const seed = useed(begin + eff.seed + 296 * (sequence & 0xFF));
    // FX_CullElemForSpawn: the camera has to be within the spawn range (checked with the current camera)
    if (e.spawnRange[1]) {
      const o = this.frameOf(eff, t).origin, d = Math.hypot(this.cam.x - o[0], this.cam.y - o[1], this.cam.z - o[2]) - e.spawnRange[0];
      if (d < 0 || d > e.spawnRange[1]) return;
    }
    if (e.type === T.RUNNER) {                                        // FX_SpawnRunner: a new effect at the spawn origin
      const vis = e.visualCount > 1 ? e.visuals[(e.visualCount * RAND16[seed + K.VISUAL]) >>> 16] : e.visuals[0];
      const def = vis && vis.effect && this.defs[vis.effect];
      if (!def || t - begin > this.duration(def)) return;
      const origin = [0, 0, 0], at = this.frameOf(eff, played);
      spawnOrigin(e, at, seed, origin);
      let axis = at.axis;
      if (e.flags & F.RANDOM_AXIS) {                                  // FX_RandomlyRotateAxis
        const left = rotateAround(axis[1], axis[0], RAND[seed + K.ROTATION] * 360);
        axis = [axis[0], left, cross(axis[0], left)];
      }
      const sub = { def, frame: { origin, axis }, begin, seed: (479 * ((((214013 * begin + 2531011) >>> 0) >>> 17))) >>> 15,
        light: def.flags & 1 ? this.packedLighting(origin) : null, transient: true };
      sub.seed %= SEEDS;
      this.effect(sub, t, depth + 1);
      return;
    }
    const life = e.lifeSpanMsec[0] + rint(e.lifeSpanMsec[1], RAND16[seed + K.LIFE]);
    const elapsed = t - begin;
    if (life <= 0) return;
    // a colliding element's effect on impact (the flashbang's smoke ...) outlives the element
    const onImpact = e.flags & F.COLLIDE && e.effectOnImpact && this.defs[e.effectOnImpact];
    if (onImpact && this.tracer && this.tracer.built && elapsed < life + this.duration(onImpact)) {
      const path = this.bouncePath(eff, e, index, sequence, seed, begin, life, played);
      if (path) for (const h of path.impacts) {
        if (begin + h.t > t) break;
        this.effect({ def: onImpact, frame: { origin: h.p, axis: axisFromDir(h.n) }, begin: begin + h.t, seed: useed(begin + h.t + seed * 7),
          light: onImpact.flags & 1 ? this.packedLighting(h.p) : null, transient: true }, t, depth + 1);
      }
    }
    // FX_ProcessEmitting: an element with an emitted effect spawns it every emitDist units of its path
    const emitted = e.effectEmitted && this.defs[e.effectEmitted];
    if (emitted && elapsed < life + this.duration(emitted)) {
      const em = this.emissions(eff, e, index, played, sequence, seed, begin, life);
      const dur = this.duration(emitted);
      if (em) for (const x of em) {
        const at = begin + x.t;
        if (at > t) break;
        if (t - at > dur) continue;
        this.effect({ def: emitted, frame: { origin: x.p, axis: axisFromDir(x.dir) }, begin: at, seed: useed(at + seed * 13 + x.k),
          light: emitted.flags & 1 ? this.packedLighting(x.p) : null, transient: true }, t, depth + 1);
      }
    }
    if (elapsed >= life || (!e.visualCount && e.type !== T.OMNI)) return;
    let batch = null, model = null;
    if (e.type === T.MODEL) {
      const vis = e.visualCount > 1 ? e.visuals[(e.visualCount * RAND16[seed + K.VISUAL]) >>> 16] : e.visuals[0];
      model = vis && vis.model ? vis.model.replace(/^,/, '') : null;
      if (!model || this.models.length >= MAX_MODELS) return;
    } else if (e.type !== T.OMNI) {
      const vis = e.visualCount > 1 ? e.visuals[(e.visualCount * RAND16[seed + K.VISUAL]) >>> 16] : e.visuals[0];
      batch = vis && vis.material && this.batches.get(vis.material);
      if (!batch || this.count >= MAX_PARTICLES) return;
    }
    const pl = this.place(eff, e, index, played, sequence, seed, begin, life, elapsed, t);
    if (!pl) return;
    const { orient, world, baseVel, rest } = pl, norm = elapsed / life;
    // the visual state (FX_SetupVisualState, FX_EvaluateVisualState)
    const S = e.vis;
    if (!S) return;
    const sp = e.visStateIntervalCount * norm, si = Math.min(Math.floor(sp), S.length - 2), sl = sp - si, sli = 1 - sl;
    const A0 = S[si], A1 = S[si + 1];
    if (model) {                                                      // FX_DrawElem_Model (FX_InterpolateScale, FX_SetPlacement)
      const r = RAND[seed + K.SCALE], scale = (r * A0.amplitude.scale + A0.base.scale) * sli + (r * A1.amplitude.scale + A1.base.scale) * sl;
      if (scale) this.models.push({ name: model, pos: [world[0], world[1], world[2]], axis: elemAxis(e, seed, orient, axisMsec(elapsed, rest)), scale });
      return;
    }
    const vl = RAND[seed + K.COLOR], vli = 1 - vl;
    const col = [0, 1, 2, 3].map(c => Math.round(sl * (A1.base.color[c] * vli + A1.amplitude.color[c] * vl) + sli * (A0.base.color[c] * vli + A0.amplitude.color[c] * vl)));
    const sizeAt = (c, key) => { const r = RAND[seed + key]; return (r * A0.amplitude.size[c] + A0.base.size[c]) * sli + (r * A1.amplitude.size[c] + A1.base.size[c]) * sl; };
    const size0 = sizeAt(0, K.SIZE0), size1 = e.flags & F.NONUNIFORM ? sizeAt(1, K.SIZE1) : size0;
    if (e.lightingFrac && eff.light) {                                // FX_EvaluateVisualState_DoLighting (colour bytes: B, G, R, A)
      for (let c = 0; c < 3; c++) {
        const f = Math.floor((2 * eff.light[c] - 255) * e.lightingFrac / 255) + 255;
        col[2 - c] = Math.max(0, Math.min(255, Math.floor(f * col[2 - c] / 255)));
      }
    }
    if (e.type === T.OMNI) {                                          // FX_DrawElem_Light: radius = size, colour B, G, R
      if (size0 > 0 && (col[0] || col[1] || col[2])) this.lights.push({ pos: [world[0], world[1], world[2]], radius: size0,
        color: [col[2] / 255, col[1] / 255, col[0] / 255] });
      return;
    }
    const rv = RAND[seed + K.ROTATION_DELTA], w4 = sl * sl * 0.5, w = sl - w4;
    const rot = e.initialRotation[1] * RAND[seed + K.COLOR] + e.initialRotation[0] +
      ((rv * A0.amplitude.rotationTotal + A0.base.rotationTotal) + (rv * A0.amplitude.rotationDelta + A0.base.rotationDelta) * w +
       (rv * A1.amplitude.rotationDelta + A1.base.rotationDelta) * w4) * life;
    // distance fade (FX_EvaluateDistanceFade)
    let fade = 255;
    if (e.fadeInRange[1] || e.fadeOutRange[1]) {
      const d = Math.hypot(world[0] - this.cam.x, world[1] - this.cam.y, world[2] - this.cam.z);
      const lerp = (r) => { const b = d - r[0]; return b < 0 ? 1 : r[1] > b ? 1 - b / r[1] : 0; };
      const fin = e.fadeInRange[1] ? lerp(e.fadeInRange) : 1, fout = e.fadeOutRange[1] ? 1 - lerp(e.fadeOutRange) : 1;
      fade = Math.floor(Math.min(fin, fout) * 255 + 0.5);
    }
    const alpha = (fade * col[3]) >> 8;
    if (alpha <= 0 || (size0 <= 0 && size1 <= 0)) return;
    // the atlas frame (FX_GetSpriteTexCoords)
    const at = e.atlas, n = at.entryCount;
    let s0 = 0, ds = 1, t0 = 0, dt = 1;
    if (n > 1) {
      const mode = at.behavior & 3;
      let idx = mode === 0 ? at.index : mode === 1 ? (n * RAND16[seed + K.TILE]) >>> 16 : (n - 1) & sequence;
      if (at.behavior & 4) idx += Math.floor(n * norm);
      else if (at.fps) idx += Math.floor(at.fps * Math.floor(elapsed) / 1000);
      if (at.behavior & 8 && idx >= n * at.loopCount) idx = n - 1;
      idx &= n - 1;
      ds = 1 / (1 << at.colIndexBits); dt = 1 / (1 << at.rowIndexBits);
      s0 = (idx & ((1 << at.colIndexBits) - 1)) * ds; t0 = (idx >> at.colIndexBits) * dt;
    }
    // the sprite's axes (FX_DrawElem_*): billboards face the camera, oriented sprites use the
    // element's frame, tails stretch along the velocity
    let tan, bin, pos = world;
    if (e.type === T.ORIENTED) { tan = orient.axis[1]; bin = orient.axis[2]; }
    else if (e.type === T.TAIL) {
      const v = this.tmp.vel;
      velocityAt(e, seed, life, elapsed, orient, baseVel, v);
      if (!normalize(v)) return;
      pos = [world[0] - v[0] * size1, world[1] - v[1] * size1, world[2] - v[2] * size1];
      const dc = [this.cam.x - pos[0], this.cam.y - pos[1], this.cam.z - pos[2]];
      tan = cross(v, dc); if (!normalize(tan)) return;
      bin = [v[0], v[1], v[2]];
    } else { tan = this.camRight; bin = this.camUp; }
    const c = Math.cos(rot), s = Math.sin(rot);
    const rt = [c * tan[0] + s * bin[0], c * tan[1] + s * bin[1], c * tan[2] + s * bin[2]];
    const rb = [s * tan[0] - c * bin[0], s * tan[1] - c * bin[1], s * tan[2] - c * bin[2]];
    const d2 = (pos[0] - this.cam.x) ** 2 + (pos[1] - this.cam.y) ** 2 + (pos[2] - this.cam.z) ** 2;
    batch.list.push({ p: [pos[0], pos[1], pos[2]], rt, rb, s0: size0, s1: size1, uv: [s0, t0, ds, dt],
      // vertex colour: the game's bytes are B, G, R, A
      col: [col[2] / 255, col[1] / 255, col[0] / 255, alpha / 255], d2 });
    this.count++;
  }

  upload(b) {
    const list = b.list;
    if (!b.add) list.sort((x, y) => y.d2 - x.d2);                    // blended sprites back to front
    const n = list.length;
    const geo = b.mesh.geometry;
    b.mesh.visible = n > 0;
    if (!n) return;
    if (n > b.cap) {
      // a new geometry: WebGL buffers keep their size (three.js cannot grow an uploaded attribute)
      if (b.cap) { geo.dispose(); b.mesh.geometry = new THREE.BufferGeometry(); b.cap = 0; return this.upload(b); }
      b.cap = Math.max(64, Math.ceil(n * 1.5));
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.cap * 12), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.cap * 8), 2).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.cap * 16), 4).setUsage(THREE.DynamicDrawUsage));
      const idx = new Uint32Array(b.cap * 6);
      for (let i = 0; i < b.cap; i++) idx.set([4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 2, 4 * i + 3, 4 * i], 6 * i);
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    const P = geo.attributes.position.array, U = geo.attributes.uv.array, C = geo.attributes.color.array;
    for (let i = 0; i < n; i++) {
      const q = list[i], o = 12 * i, rt = q.rt, rb = q.rb;
      if (q.quad) {                                                   // a quad of a trail ribbon: its own corners
        for (let v = 0; v < 4; v++) { P[o + 3 * v] = q.quad[v][0]; P[o + 3 * v + 1] = q.quad[v][1]; P[o + 3 * v + 2] = q.quad[v][2]; C.set(q.colq[v], 16 * i + 4 * v); }
        U.set(q.uvq, 8 * i);
        continue;
      }
      // FX_GenSpriteVerts: (pos - left + up), (pos - left - up), (pos + left - up), (pos + left + up)
      for (let k = 0; k < 3; k++) {
        const l = rt[k] * q.s0, u = rb[k] * q.s1;
        P[o + k] = q.p[k] - l + u; P[o + 3 + k] = q.p[k] - l - u; P[o + 6 + k] = q.p[k] + l - u; P[o + 9 + k] = q.p[k] + l + u;
      }
      const [s0, t0, ds, dt] = q.uv;
      U.set([s0, t0 + dt, s0, t0, s0 + ds, t0, s0 + ds, t0 + dt], 8 * i);
      for (let v = 0; v < 4; v++) C.set(q.col, 16 * i + 4 * v);
    }
    geo.setDrawRange(0, n * 6);
    geo.attributes.position.needsUpdate = true; geo.attributes.uv.needsUpdate = true; geo.attributes.color.needsUpdate = true;
  }

  dispose() {
    DLIGHTS.count.value = 0;
    for (const list of this.modelPool.values()) for (const m of list) for (const x of m.material) x.dispose();
    for (const b of this.batches.values()) {
      b.mesh.geometry.dispose();
      if (b.mesh.material.uniforms.uMap.value) b.mesh.material.uniforms.uMap.value.dispose();
      b.mesh.material.dispose();
    }
  }
}

export { FxSystem as AmbientFx };
