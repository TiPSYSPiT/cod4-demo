/* The hints over a view (2D and 3D): the technical details (map file, data, triangle counts) - shown
 * on the view only while they matter (loading, a warning), otherwise in the rail's info popover
 * (main.js reads `text`) - and the controls hint, shown for a few seconds after a change and then faded. */
const C4 = window.C4;
const { el } = C4.ui;

export class InfoHint {
  /** parent: the view's stage; the box on the view is `box` (class map-hint; "warn" for a warning) */
  constructor(parent, title = 'Map and data details') {
    this.title = title;
    this.text = '';
    this.warn = false;
    this.box = el('div', { class: 'map-hint', role: 'status', hidden: true });
    parent.append(this.box);
  }

  /** the details text; open: shown on the view (loading), warn: a warning (shown, highlighted) */
  set(text, { open = false, warn = false } = {}) {
    this.text = text;
    this.warn = warn;
    if (this.box.textContent !== text) this.box.textContent = text;
    this.box.classList.toggle('warn', warn);
    this.box.hidden = !(open || warn);
    if (InfoHint.onChange) InfoHint.onChange(this);
  }
}
/** called after every set() (main.js: refreshes an open info popover) */
InfoHint.onChange = null;

/** show a hint now and fade it out after ms (a help text: once read, it only covers the view) */
export function fadeHint(node, ms = 4000) {
  node.classList.remove('faded');
  clearTimeout(node._fadeTimer);
  node._fadeTimer = setTimeout(() => node.classList.add('faded'), ms);
}

/** show a hint and keep it (a message that matters: e.g. the followed player is not visible) */
export function holdHint(node) {
  clearTimeout(node._fadeTimer);
  node.classList.remove('faded');
}
