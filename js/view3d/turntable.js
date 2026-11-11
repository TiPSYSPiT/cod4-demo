/* Debug view (index.html?debug=models, off by default): every player character combination and every world weapon model on a
 * turntable, with its model and material names - the colour map each surface draws with, its alpha test / blending / culling, and
 * a surface without a colour map (drawn in the fallback colour) in red. The characters are built exactly as the 3D view builds
 * them (characters.js Character: the body, the head on the body's bones by name) and posed by the game's animation, a stance
 * pose or the bind pose; the weapons as they hang at tag_weapon_right. Combinations: the game's character scripts (below), the
 * loaded demo's (playerModels) and ?body=&head=. Keys: Esc closes, the arrow keys page. */
import * as THREE from 'three';
import { CharacterLibrary, Character, AnimationLibrary } from './characters.js';
import { loadTexture } from './mapLoader.js';

/* the game's character scripts (common_mp.ff character/character_mp_*.gsc: setModel + attach) - the bodies of the SAS carry
 * their head; tools/audit/model_audit.py lists them from the scripts themselves */
export const SCRIPT_COMBOS = [
  ['body_mp_arab_regular_assault', 'head_mp_arab_regular_suren'], ['body_mp_arab_regular_cqb', 'head_mp_arab_regular_headwrap'],
  ['body_mp_arab_regular_engineer', 'head_mp_arab_regular_ski_mask'], ['body_mp_arab_regular_sniper', 'head_mp_arab_regular_sadiq'],
  ['body_mp_arab_regular_support', 'head_mp_arab_regular_asad'],
  ['body_mp_opforce_assault', 'head_mp_opforce_headwrap'], ['body_mp_opforce_cqb', 'head_mp_opforce_gasmask'],
  ['body_mp_opforce_eningeer', 'head_mp_opforce_gasmask'], ['body_mp_opforce_sniper', 'head_mp_opforce_ghillie'],
  ['body_mp_opforce_sniper_urban', 'head_mp_opforce_justin'], ['body_mp_opforce_support', 'head_mp_opforce_3hole_mask'],
  ['body_mp_sas_urban_assault', null], ['body_mp_sas_urban_recon', null], ['body_mp_sas_urban_sniper', null],
  ['body_mp_sas_urban_specops', null], ['body_mp_sas_urban_support', null],
  ['body_mp_usmc_assault', 'head_mp_usmc_tactical_mich'], ['body_mp_usmc_recon', 'head_mp_usmc_nomex'],
  ['body_mp_usmc_sniper', 'head_mp_usmc_tactical_baseball_cap'], ['body_mp_usmc_specops', 'head_mp_usmc_tactical_mich_stripes_nomex'],
  ['body_mp_usmc_support', 'head_mp_usmc_shaved_head'],
  ['body_mp_usmc_woodland_assault', 'head_mp_usmc_tactical_mich'], ['body_mp_usmc_woodland_recon', 'head_mp_usmc_nomex'],
  ['body_mp_usmc_woodland_sniper', 'head_mp_usmc_ghillie'], ['body_mp_usmc_woodland_specops', 'head_mp_usmc_tactical_mich_stripes_nomex'],
  ['body_mp_usmc_woodland_support', 'head_mp_usmc_shaved_head'],
];
const POSES = ['pb_stand_alert', 'pb_combatrun_forward_loop', 'pb_sprint', 'pb_runjump_takeoff', 'pb_crouch_alert', 'pb_crouch_run_forward', 'pb_prone_aim',
  'pb_prone_crawl', 'pb_stand_death_head_collapse', 'pb_crouch_death_fetal', 'stand', 'crouch', 'prone', 'bind'];
// a slot: the names (VIEW_TOP), the model (VIEW_H), its materials below
const SLOT_W = 340, SLOT_H = 540, VIEW_TOP = 40, VIEW_H = 300;

/** open the turntable over the page; resolves when it is shown */
export async function openTurntable({ demo = null } = {}) {
  const q = new URLSearchParams(location.search);
  const tex = new Map();
  const texture = file => {
    if (!file) return null;
    if (!tex.has(file)) {
      const t = loadTexture('maps3d/' + file);
      t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
      tex.set(file, t);
    }
    return tex.get(file);
  };
  const lib = new CharacterLibrary(texture), anims = new AnimationLibrary();
  await Promise.all([lib.available(), anims.load()]);
  const weaponTable = await lib.weaponTable();

  // the lists: character combinations and weapon models
  const combos = new Map();
  const addCombo = (body, head, src) => {
    if (!body) return;
    const k = body + '|' + (head || '');
    if (!combos.has(k)) combos.set(k, { body, head: head || null, src: new Set() });
    combos.get(k).src.add(src);
  };
  if (q.get('body')) addCombo(q.get('body'), q.get('head'), 'url');
  for (const [b, h] of SCRIPT_COMBOS) addCombo(b, h, 'script');
  // the demo's own (actors.js modelsAt: the body and its head) - a demo loaded later (?demo=) adds them when it is there
  let demoData = null;
  const addDemo = d => {
    demoData = d;
    if (d && d.playerModels) for (const list of Object.values(d.playerModels)) for (const e of list) {
      const ns = [e.body, ...(e.attach || [])].filter(Boolean), b = ns.find(n => n.startsWith('body_'));
      if (b) addCombo(b, ns.find(n => n.startsWith('head_')), 'demo');
    }
  };
  addDemo(demo || (window.cod4 && window.cod4.data));
  const weaponModels = new Map();
  const addWeapon = (model, by) => { if (!model) return; if (!weaponModels.has(model)) weaponModels.set(model, new Set()); weaponModels.get(model).add(by); };
  if (weaponTable) for (const [w, e] of Object.entries(weaponTable.weapons)) {
    for (const m of e.models || []) addWeapon(m, w);
    addWeapon(e.knife, w + ' (knife)');
  }
  addWeapon('prop_suitcase_bomb', 'the carried bomb');

  // the page
  // (its own stylesheet: the page's CSP allows no inline styles)
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = 'css/turntable.css';
  await new Promise(r => { style.onload = style.onerror = r; document.head.append(style); });
  const root = document.createElement('div'); root.className = 'tt';
  root.innerHTML = `<div class="tt-bar"><b>Models</b>
    <select data-k="list"><option value="chars">Characters</option><option value="weapons">Weapon models</option></select>
    <select data-k="pose">${POSES.map(p => `<option>${p}</option>`).join('')}</select>
    <select data-k="zoom"><option value="full">whole model</option><option value="head">head / weapon close</option></select>
    <select data-k="lod"><option value="0">LOD 0</option><option value="1">LOD 1</option><option value="2">LOD 2</option><option value="3">LOD 3</option></select>
    <label><input type="checkbox" data-k="spin" checked> turn</label>
    <input data-k="filter" placeholder="filter" size="14">
    <span class="sp"></span><span data-k="page"></span>
    <button data-k="prev">&lt;</button><button data-k="next">&gt;</button><button data-k="close">Close</button></div>
    <div class="tt-slots"></div>`;
  document.body.append(root);
  const $ = k => root.querySelector(`[data-k="${k}"]`);
  const slotsEl = root.querySelector('.tt-slots');
  $('pose').value = q.get('pose') || 'pb_stand_alert';
  if (q.get('zoom')) $('zoom').value = q.get('zoom');
  if (q.get('list') === 'weapons') $('list').value = 'weapons';
  if (q.get('filter')) $('filter').value = q.get('filter');
  if (q.get('lod')) $('lod').value = q.get('lod');

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.setScissorTest(true);
  root.insertBefore(renderer.domElement, slotsEl);
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xe6edf5, 0x463c30, 1.5); hemi.position.set(0, 0, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(0.7, -0.6, 1);
  const back = new THREE.DirectionalLight(0x9fb4d0, 0.6); back.position.set(-0.6, 0.8, 0.4);
  scene.add(hemi, sun, back);
  const camera = new THREE.PerspectiveCamera(30, SLOT_W / SLOT_H, 0.5, 4000); camera.up.set(0, 0, 1);

  let page = 0, slots = [], angle = 0, last = performance.now(), raf = 0, closed = false, build = 0, watch = 0;
  const items = () => {
    const f = $('filter').value.trim().toLowerCase();
    const list = $('list').value === 'chars'
      ? [...combos.values()].map(c => ({ kind: 'char', key: c.body + '|' + (c.head || ''), ...c }))
      : [...weaponModels].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([model, by]) => ({ kind: 'weapon', key: model, model, by }));
    return f ? list.filter(x => x.key.toLowerCase().includes(f) || (x.by && [...x.by].some(b => b.includes(f)))) : list;
  };
  const layout = () => {
    const w = innerWidth, h = innerHeight - 40;
    renderer.setSize(w, h);
    return { cols: Math.max(1, Math.floor(w / SLOT_W)), rows: Math.max(1, Math.floor(h / SLOT_H)), w, h };
  };

  /** material lines of a model part: name -> colour map, alpha, blending, culling; none: red */
  const matLines = (model, lod) => {
    const meta = model.meta, L = meta.lods && meta.lods[lod] || { surfaceStart: 0, surfaceCount: meta.surfaces.length };
    const seen = new Map();
    for (let j = L.surfaceStart; j < L.surfaceStart + L.surfaceCount; j++) {
      const s = meta.surfaces[j], m = s.material >= 0 ? meta.materials[s.material] : null;
      const k = m ? m.name : '(surface ' + j + ': no material)';
      if (!seen.has(k)) seen.set(k, { m, tris: 0 });
      seen.get(k).tris += s.indexCount / 3;
    }
    return [...seen].map(([k, { m, tris }]) => {
      if (!m) return { bad: true, text: k + ' - fallback colour, ' + tris + ' tris' };
      if (m.noDraw || m.shadowOnly) return { bad: false, text: k + ' - not drawn (' + (m.noDraw ? 'no lit technique' : 'shadow only') + ')' };
      const f = [m.texture ? m.texture.replace('_textures/', '') : 'NO COLOUR MAP - fallback colour'];
      if (m.textureGuess) f.push('guessed: ' + m.textureGuess);
      if (m.alphaTest) f.push('alpha ' + m.alphaTest + (m.textureAlpha ? '' : ' (map opaque)'));
      if (m.blend) f.push('blend ' + m.blend);
      if (m.doubleSided) f.push('2-sided');
      return { bad: !m.texture, text: k + ' -> ' + f.join(' · ') + ' (' + tris + ' tris)' };
    });
  };

  async function show() {
    const my = ++build;
    for (const s of slots) { scene.remove(s.obj); s.el.remove(); }
    slots = [];
    const { cols, rows } = layout();
    const list = items(), per = cols * rows, pages = Math.max(1, Math.ceil(list.length / per));
    page = Math.max(0, Math.min(page, pages - 1));
    $('page').textContent = (list.length ? page + 1 : 0) + ' / ' + pages + ' (' + list.length + ')';
    const lod = Number($('lod').value), pose = $('pose').value;
    const chunk = list.slice(page * per, page * per + per);
    if (pose.startsWith('p') && pose.includes('_')) await anims.preload([pose]);
    await Promise.all(chunk.map(async (it, i) => {
      const el = document.createElement('div');
      el.className = 'tt-slot';
      el.style.left = (i % cols) * SLOT_W + 'px'; el.style.top = Math.floor(i / cols) * SLOT_H + 'px';
      el.style.width = SLOT_W + 'px'; el.style.height = SLOT_H + 'px';
      const slot = { i, it, el, obj: null, center: new THREE.Vector3(0, 0, 36), size: 80 };
      // (as text: the names may come from a demo file)
      const title = (name, src) => { const b = document.createElement('b'), sp = document.createElement('span'); b.textContent = name; sp.className = 'src'; sp.textContent = src; el.replaceChildren(b, sp); };
      let lines = [];
      try {
        if (it.kind === 'char') {
          const [b, h] = await Promise.all([lib.load(it.body), it.head ? lib.load(it.head) : null]);
          const c = new Character(b, h);
          for (const P of c.parts) { const k = Math.min(lod, P.meshes.length - 1); P.meshes.forEach((m, j) => { m.visible = j === k; }); }
          if (pose === 'bind') { /* the models' bind pose as built */ }
          else if (['stand', 'crouch', 'prone'].includes(pose)) c.pose(pose, 0);
          else {
            const clip = anims.clip(pose, c);
            if (clip) c.animate([{ clip, time: q.get('time') != null ? Math.min(clip.duration, Number(q.get('time'))) : pose.includes('death') ? clip.duration : Math.min(0.5, clip.duration), weight: 1 }], 0, pose.includes('prone') ? 'prone' : pose.includes('crouch') ? 'crouch' : 'stand');
          }
          slot.obj = c.group;
          slot.headBone = c.byName.get('j_head');
          title(it.body + (it.head ? ' + ' + it.head : ''), [...it.src].join(', '));
          lines.push({ part: true, text: it.body.replace('body_mp_', 'body ') });
          lines.push(...matLines(b, Math.min(lod, (b.meta.lods || [0]).length - 1)));
          if (h) { lines.push({ part: true, text: it.head.replace('head_mp_', 'head ') }); lines.push(...matLines(h, Math.min(lod, (h.meta.lods || [0]).length - 1))); }
        } else {
          const m = await lib.load(it.model);
          const mesh = new THREE.Mesh(m.geo, m.mats);
          const g = new THREE.Group(); g.add(mesh);
          m.geo.computeBoundingBox();
          const bb = m.geo.boundingBox;
          slot.center = bb.getCenter(new THREE.Vector3()); slot.size = Math.max(4, bb.getSize(new THREE.Vector3()).length());
          mesh.position.sub(slot.center); slot.center.set(0, 0, 0);
          slot.obj = g;
          title(it.model, [...it.by].slice(0, 4).join(', ') + (it.by.size > 4 ? ' ...' : ''));
          lines = matLines(m, 0);
          lines.push({ text: 'bones: ' + m.meta.bones.map(x => x.name).join(', ') });
        }
      } catch (err) {
        title(it.key, '');
        lines = [{ bad: true, text: 'not loaded: ' + err.message }];
      }
      const ul = document.createElement('ul');
      for (const l of lines) { const li = document.createElement('li'); li.textContent = l.text; if (l.bad) li.className = 'bad'; if (l.part) li.className = 'part'; ul.append(li); }
      el.append(ul);
      if (my !== build) return;
      slotsEl.append(el);
      if (slot.obj) scene.add(slot.obj);
      slots.push(slot);
    }));
    if (my === build) window.__turntableReady = true;
  }

  const draw = now => {
    if (closed) return;
    raf = requestAnimationFrame(draw);
    if ($('spin').checked) angle += (now - last) / 1000 * 0.6;
    last = now;
    const { cols, h } = layout();
    renderer.setScissor(0, 0, innerWidth, h);
    renderer.setClearColor(0x1d2228); renderer.clear();
    const head = $('zoom').value === 'head';
    for (const s of slots) if (s.obj) s.obj.visible = false;
    for (const s of slots) {
      if (!s.obj) continue;
      const x = (s.i % cols) * SLOT_W, y = h - (Math.floor(s.i / cols) + 1) * SLOT_H;
      const vy = y + SLOT_H - VIEW_TOP - VIEW_H;
      renderer.setViewport(x, vy, SLOT_W, VIEW_H); renderer.setScissor(x, vy, SLOT_W, VIEW_H);
      camera.aspect = SLOT_W / VIEW_H; camera.updateProjectionMatrix();
      s.obj.visible = true;
      s.obj.rotation.z = q.get('angle') != null ? Number(q.get('angle')) * Math.PI / 180 : angle;
      s.obj.updateMatrixWorld(true);
      let c = s.center.clone(), dist;
      if (s.it.kind === 'char') {
        if (head && s.headBone) { s.headBone.getWorldPosition(c); dist = 55; } else { c.set(0, 0, 34); dist = 210; }
      } else dist = s.size * (head ? 1.2 : 1.9);
      camera.position.set(c.x + dist, c.y, c.z + dist * 0.12);
      camera.lookAt(c);
      renderer.render(scene, camera);
      s.obj.visible = false;
    }
  };
  const close = () => {
    closed = true; cancelAnimationFrame(raf); clearInterval(watch);
    for (const s of slots) scene.remove(s.obj);
    renderer.dispose(); root.remove(); style.remove();
    removeEventListener('keydown', onKey, true); removeEventListener('resize', show);
  };
  const onKey = e => {
    if (e.code === 'Escape') { e.stopPropagation(); close(); }
    else if (e.code === 'ArrowRight') { e.stopPropagation(); page++; show(); }
    else if (e.code === 'ArrowLeft') { e.stopPropagation(); page--; show(); }
  };
  addEventListener('keydown', onKey, true);
  addEventListener('resize', show);
  $('prev').onclick = () => { page--; show(); };
  $('next').onclick = () => { page++; show(); };
  $('close').onclick = close;
  for (const k of ['list', 'pose', 'lod', 'filter']) $(k).addEventListener(k === 'filter' ? 'input' : 'change', () => { if (k !== 'pose' && k !== 'lod') page = 0; show(); });
  page = Number(q.get('page') || 1) - 1;
  await show();
  raf = requestAnimationFrame(draw);
  watch = setInterval(() => { const d = window.cod4 && window.cod4.data; if (d && d !== demoData) { addDemo(d); show(); } }, 1000);
  return { close, show };
}

/** the attachment check (tools/audit/model_audit.py --poses): every combination posed by each clip; per head bone that is not
 *  the body's (the helmet's j_helmet, j_head_end, the face's), its place relative to j_head against the head's bind pose. The game
 *  animates these bones with offsets on their bind (DObjCalcSkel), so a part carried by them stays on the head: a large
 *  difference means the head part is drawn off the head. Only bones that carry vertices. -> [{combo, clip, bone, dPos (units), dDeg}]
 *  worst bone per pair (bone null: no such bone carries vertices) */
export async function attachmentReport(clips = ['pb_stand_alert', 'pb_combatrun_forward_loop', 'pb_crouch_alert', 'pb_crouch_run_forward', 'pb_prone_aim', 'pb_prone_crawl', 'pb_sprint', 'pb_runjump_takeoff', 'pb_stand_death_head_collapse', 'pb_crouch_death_fetal']) {
  const lib = new CharacterLibrary(() => null), anims = new AnimationLibrary();
  await Promise.all([lib.available(), anims.load()]);
  await anims.preload(clips.filter(c => anims.exists(c)));
  const out = [], W = new THREE.Matrix4(), H = new THREE.Matrix4(), R = new THREE.Matrix4();
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p0 = new THREE.Vector3(), q0 = new THREE.Quaternion();
  for (const [body, head] of SCRIPT_COMBOS) {
    if (!head) continue;
    let b, h;
    try { [b, h] = await Promise.all([lib.load(body), lib.load(head)]); } catch (err) { out.push({ combo: body + '+' + head, error: err.message }); continue; }
    const hb = new Map(h.bones.map((x, i) => [x.name, i]));
    const jh = hb.get('j_head');
    // the bones that carry vertices (a bone without any draws nothing - the ski mask's j_helmet hangs on j_head without j_head_end,
    // the animation turns it as in the game, nothing moves)
    const carried = new Set(), SI = h.geo.attributes.skinIndex, SW = h.geo.attributes.skinWeight;
    for (let v = 0; v < SI.count; v++) for (let j = 0; j < 4; j++) if (SW.getComponent(v, j) > 0) carried.add(h.bones[SI.getComponent(v, j)].name);
    // the bind: each own bone relative to j_head in the head's bind pose
    const bindRel = new Map();
    for (const [n, i] of hb) {
      if (b.bones.some(x => x.name === n) || jh == null || !carried.has(n)) continue;
      W.compose(h.bind[jh].p, h.bind[jh].q, new THREE.Vector3(1, 1, 1)).invert();
      R.compose(h.bind[i].p, h.bind[i].q, new THREE.Vector3(1, 1, 1));
      bindRel.set(n, W.clone().multiply(R));
    }
    for (const clip of clips) {
      const c = new Character(b, h);
      const k = anims.clip(clip, c);
      if (!k) continue;
      c.animate([{ clip: k, time: Math.min(0.4, k.duration), weight: 1 }], 0, clip.includes('prone') ? 'prone' : clip.includes('crouch') ? 'crouch' : 'stand');
      c.group.updateMatrixWorld(true);
      const bones = new Map(c.headMesh.skeleton.bones.map(x => [x.name, x]));
      const jHead = bones.get('j_head');
      let worst = { combo: body + ' + ' + head, clip, bone: null, dPos: 0, dDeg: 0 };
      for (const [n, rel] of bindRel) {
        const bone = bones.get(n);
        if (!bone) continue;
        H.copy(jHead.matrixWorld).invert().multiply(bone.matrixWorld);
        H.decompose(p, q, s); rel.decompose(p0, q0, s);
        const dPos = p.distanceTo(p0), dDeg = THREE.MathUtils.radToDeg(q.angleTo(q0));
        // (the helmet chain decides where a helmet / cap sits; the face bones move by design - jaw, lids, brows)
        if (/^(j_head_end|j_helmet|tag_eye)$/.test(n) && dPos > worst.dPos) worst = { ...worst, bone: n, dPos: +dPos.toFixed(3), dDeg: +dDeg.toFixed(2) };
      }
      out.push(worst);
      c.dispose();
    }
  }
  return out;
}
