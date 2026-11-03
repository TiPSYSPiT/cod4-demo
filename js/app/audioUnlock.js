/* The page's AudioContext for the 3D view's game sounds (js/view3d/sound.js).
 *
 * Browsers let an AudioContext play only when it was created or resumed during a user gesture (a
 * click, key or touch). One created later - when the 3D map and its sounds have loaded, seconds
 * after the click that opened the demo - stays suspended until the next gesture. So the context is
 * created in the page's first gesture (opening a demo, play, the timeline ...) while the sound is
 * wanted (the default; the 3D view's Game sounds switch stores 'off'), and the sound system takes
 * it over when it loads. Once the browser let it run, it can be suspended and resumed without a
 * gesture (pause / play) - so until the sound system takes it, it is suspended again (no idle audio
 * thread in the 2D view). A dropped file is no gesture for the browsers: the sound then starts with
 * the first click. */
const SOUND_KEY = 'cod4demo3d.sound';            // 'on' / 'off' (default on) - as view3d.js
const EVENTS = ['pointerdown', 'pointerup', 'keydown', 'touchend'];
let ctx = null, ran = false, claimed = false;

const wanted = () => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch (err) { return true; } };

/** the shared context for the sound system (claimed: it suspends and resumes it from now on);
 *  create: make it now if there is none (it can play when this runs in a gesture) */
export function claimAudio(create = false) {
  const c = audioContext(create);
  if (c) claimed = true;
  return c;
}

function audioContext(create) {
  if (!ctx && create) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (err) { ctx = null; }
      if (ctx) {
        ran = ctx.state === 'running';
        if (ran && !claimed) ctx.suspend().catch(() => null);
        ctx.addEventListener('statechange', () => {
          if (ctx.state !== 'running') return;
          ran = true;
          if (!claimed) ctx.suspend().catch(() => null);      // allowed now; idle until the sounds load
        });
      }
    }
  }
  return ctx;
}

/** create (and once start) the context in the page's gestures while the sound is wanted - until the
 *  browser has let it run */
export function armAudio() {
  const on = () => {
    if (ran) { for (const e of EVENTS) window.removeEventListener(e, on, true); return; }
    if (!wanted()) return;
    const c = audioContext(true);
    if (c && c.state === 'suspended') c.resume().catch(() => null);
  };
  for (const e of EVENTS) window.addEventListener(e, on, true);
}
