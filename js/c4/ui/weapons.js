/* Tab - Weapons: the game's numbers of every weapon in the demo (the weapon files: maps3d/_characters/viewmodels.json,
 * viewmodels_export.py - for a Promod server's demo Promod's own weapon files over them) with how this demo used them.
 * Damage (Bullet_CalcDamageRange, bullet.cpp): `damage` up to maxDamageRange, then linear down to minDamage at
 * minDamageRange (distance from the shooter's eye to the hit), times the hit location's loc* multiplier of the weapon
 * file (G_GetWeaponHitLocationMultiplier); the Stopping Power perk adds 40 % (no perks on Promod servers).
 * 1 m ≈ 39.37 units (the game's inches). */
(function (C4) {
  'use strict';
  const { el, clear, approx } = C4.ui;
  const W = C4.weapons;
  const M_PER_UNIT = 0.0254;

  let dataPromise = null;
  /** viewmodels.json (the weapon files' numbers and Promod's), once - shared with the 3D view's copy via the HTTP cache */
  C4.loadWeaponData = () => (dataPromise = dataPromise || fetch('maps3d/_characters/viewmodels.json').then(r => (r.ok ? r.json() : null)).catch(() => null));

  /** the demo's server ran Promod (its own weapon files) - as viewmodel.js isPromod */
  const isPromod = m => !!(m && (/promod/i.test(m.mod || '') || /promod/i.test(m.fsGame || '') || m.promodVersion));

  /** the numbers of weapon `name` (Promod's over the stock file's for a Promod demo) or null */
  function weaponParams(table, name, promod) {
    const w = table.weapons[name];
    if (!w) return null;
    const P = Object.assign({}, w.params);
    const pm = promod && table.promod && table.promod.weapons[name];
    if (pm) for (const [k, v] of Object.entries(pm.params || {})) { if (v == null) delete P[k]; else P[k] = v; }
    return P;
  }

  /** the damage of a hit with numbers P at distance dist (units) to hit location key (locHead ...) */
  function damageAt(P, dist, locKey) {
    let dmg = P.damage || 0;
    const range = (P.minDamageRange || 0) - (P.maxDamageRange || 0);
    if (dmg !== P.minDamage && range !== 0 && dist >= P.maxDamageRange) {
      dmg = dist >= P.minDamageRange ? P.minDamage : Math.trunc((dist - P.maxDamageRange) / range * P.minDamage + (1 - (dist - P.maxDamageRange) / range) * P.damage);
    }
    const k = locKey && P[locKey] != null ? P[locKey] : 1;
    return Math.max(1, Math.trunc(dmg * k));
  }

  const m = u => (u * M_PER_UNIT).toFixed(0) + ' m';
  const sec = s => (s == null ? '' : s.toFixed(2).replace(/0$/, '') + ' s');
  const NO_RANGE = 999999;                            // (minDamageRange <= 0 in the file: no falloff)

  function render(root, app) {
    clear(root);
    root.append(el('div', { class: 'muted' }, 'Loading the weapon files …'));
    C4.loadWeaponData().then(table => {
      clear(root);
      if (!table || !table.weapons) {
        root.append(el('div', { class: 'empty' }, 'The weapon data (maps3d/_characters/viewmodels.json) is not available' +
          (location.protocol === 'file:' ? ' when the page is opened as a file - serve the folder over http.' : '.')));
        return;
      }
      fill(root, app, table);
    });
  }

  function fill(root, app, table) {
    const d = app.data, promod = isPromod(d.meta);
    // the weapons of the demo: held by a player or named by a kill
    const used = new Map();
    const touch = n => {
      if (!n || n === 'none' || !table.weapons[n]) return null;
      if (!used.has(n)) used.set(n, { name: n, kills: 0, hs: 0, dist: 0, nDist: 0, holders: new Set(), P: weaponParams(table, n, promod) });
      return used.get(n);
    };
    const nameOf = (i, t) => { let list = null; for (const w of d.weaponLists || []) { if (w.t <= t) list = w.list; else break; } return i && list && i <= list.length ? list[i - 1] : null; };
    for (const [cl, P] of Object.entries(d.positions)) {
      if (!P.weapon) continue;
      const seen = new Map();
      for (let i = 0; i < P.t.length; i++) if (!seen.has(P.weapon[i])) seen.set(P.weapon[i], P.t[i]);
      for (const [wi, t] of seen) { const u = touch(nameOf(wi, t)); if (u && +cl < 64) u.holders.add(+cl); }
    }
    for (const k of d.kills) {
      if (!C4.build.kdRule(k).credit || k.phase !== 'live') continue;
      const u = touch(W.killWeapon(k));
      if (!u) continue;
      u.kills++;
      if (k.headshot) u.hs++;
      if (k.distance != null) { u.dist += k.distance; u.nDist++; }
    }
    const rows = [...used.values()];
    const isGun = r => r.P.damage > 0 && r.P.inventoryType !== 'offhand' && r.P.weaponType !== 'grenade' && r.P.weaponClass !== 'grenade' && r.P.weaponClass !== 'item';
    const falloff = r => r.P.minDamage !== r.P.damage && r.P.minDamageRange > 0 && r.P.minDamageRange < NO_RANGE;
    const pellets = r => (r.P.shotCount > 1 ? r.P.shotCount : 1);
    const columns = [
      { key: 'weapon', label: 'Weapon', cls: 'col-player', sort: r => W.label(r.name),
        render: r => { const ic = W.weaponIcon(r.name); return [ic ? C4.ui.iconNode(ic, W.label(r.name)) : null, ' ', W.label(r.name)]; } },
      { key: 'damage', label: 'Damage', title: 'damage of a hit at full / at long range (the weapon file: damage, minDamage; shotguns: per pellet x pellets)', sort: r => r.P.damage || 0,
        render: r => (!isGun(r) ? (r.P.explosionInnerDamage ? r.P.explosionInnerDamage + '→' + r.P.explosionOuterDamage : '')
          : (falloff(r) ? r.P.damage + '→' + r.P.minDamage : String(r.P.damage)) + (pellets(r) > 1 ? ' ×' + pellets(r) : '')) },
      { key: 'range', label: 'Falloff', title: 'full damage up to maxDamageRange, minDamage from minDamageRange on (metres; 1 m ≈ 39 units). Grenades: the explosion radius', sort: r => r.P.maxDamageRange || r.P.explosionRadius || 0,
        render: r => (!isGun(r) ? (r.P.explosionRadius ? 'radius ' + m(r.P.explosionRadius) : '') : falloff(r) ? m(r.P.maxDamageRange) + '–' + m(r.P.minDamageRange) : 'none') },
      { key: 'head', label: 'Head ×', title: 'hit-location multipliers of the weapon file: head', sort: r => r.P.locHead || 0, render: r => (isGun(r) ? String(r.P.locHead == null ? 1 : r.P.locHead) : '') },
      { key: 'torso', label: 'Torso ×', title: 'upper / lower torso', sort: r => r.P.locTorsoUpper || 0, render: r => (isGun(r) ? (r.P.locTorsoUpper == null ? 1 : r.P.locTorsoUpper) + ' / ' + (r.P.locTorsoLower == null ? 1 : r.P.locTorsoLower) : '') },
      { key: 'limbs', label: 'Arm / leg ×', title: 'upper arm / upper leg', sort: r => r.P.locRightArmUpper || 0, render: r => (isGun(r) ? (r.P.locRightArmUpper == null ? 1 : r.P.locRightArmUpper) + ' / ' + (r.P.locRightLegUpper == null ? 1 : r.P.locRightLegUpper) : '') },
      { key: 'btk', label: 'Hits to kill', title: 'hits to kill a player at full health (100) at close range: head / upper torso / upper leg (shotguns: pellets)', sort: r => (isGun(r) ? Math.ceil(100 / damageAt(r.P, 0, 'locTorsoUpper')) : 99),
        render: r => (isGun(r) ? ['locHead', 'locTorsoUpper', 'locRightLegUpper'].map(k => Math.ceil(100 / damageAt(r.P, 0, k))).join(' / ') : '') },
      { key: 'rpm', label: 'RPM', title: 'rounds per minute: 60 / fireTime', sort: r => (r.P.fireTime ? 60 / r.P.fireTime : 0), render: r => (isGun(r) && r.P.fireTime ? String(Math.round(60 / r.P.fireTime)) : '') },
      { key: 'clip', label: 'Clip / ammo', sort: r => r.P.clipSize || 0, render: r => (r.P.clipSize ? r.P.clipSize + ' / ' + (r.P.maxAmmo || 0) : '') },
      { key: 'reload', label: 'Reload', title: 'reloadTime (empty: reloadEmptyTime)', sort: r => r.P.reloadTime || 0,
        render: r => (isGun(r) && r.P.reloadTime ? sec(r.P.reloadTime) + (r.P.reloadEmptyTime && r.P.reloadEmptyTime !== r.P.reloadTime ? ' / ' + sec(r.P.reloadEmptyTime) : '') : '') },
      { key: 'ads', label: 'ADS', title: 'aiming down the sights: adsTransInTime (zoom fov)', sort: r => r.P.adsTransInTime || 0,
        render: r => (isGun(r) && r.P.adsTransInTime ? sec(r.P.adsTransInTime) + (r.P.adsZoomFov ? ' (' + r.P.adsZoomFov + '°)' : '') : '') },
      { key: 'speed', label: 'Speed', title: 'movement speed while holding it (moveSpeedScale)', sort: r => r.P.moveSpeedScale || 0, render: r => (r.P.moveSpeedScale != null ? Math.round(r.P.moveSpeedScale * 100) + ' %' : '') },
      { key: 'kills', label: 'Kills', title: 'kills with it in this demo (match rounds, the kill feed)', sort: r => r.kills, render: r => String(r.kills) },
      { key: 'hs', label: 'HS %', sort: r => (r.kills ? r.hs / r.kills : -1), render: r => (r.kills ? Math.round(100 * r.hs / r.kills) + ' %' : '') },
      { key: 'dist', label: 'Avg kill', title: 'average distance of its kills', sort: r => (r.nDist ? r.dist / r.nDist : -1), render: r => (r.nDist ? m(r.dist / r.nDist) : '') },
      { key: 'used', label: 'Used by', title: 'players seen holding it in this demo', sort: r => r.holders.size, render: r => String(r.holders.size) }
    ];
    for (const c of columns) if (!c.cls) { c.cls = 'col-stat'; c.num = true; }
    const groups = [
      { label: 'Guns', cls: 'a', rows: rows.filter(isGun).sort((a, b) => b.kills - a.kills) },
      { label: 'Grenades and other', cls: 'b', rows: rows.filter(r => !isGun(r)) }
    ].filter(g => g.rows.length);
    if (!groups.length) { root.append(el('div', { class: 'empty' }, 'No weapon of this demo is in the weapon data.')); return; }
    root.append(el('p', { class: 'note' }, 'The numbers of the weapon files for every weapon of this demo' +
      (promod ? ' - Promod\'s own weapon files (the server ran Promod: ' + (d.meta.promodVersion || d.meta.mod || 'promod') + ')' : ' (stock CoD4)') +
      '. A hit does the full damage up to the first range, then less down to the minimum at the second; times the hit location (Bullet_CalcDamageRange, G_GetWeaponHitLocationMultiplier).',
      promod ? null : [' ', approx('the Stopping Power perk adds 40 % to bullet damage; not counted here')]),
      C4.ui.sortableTable(columns, groups, { sortKey: 'kills', asc: false, cls: 'scoreboard weapons-table' }));
  }

  C4.tabs.weapons = { render, damageAt, weaponParams, isPromod };
})(window.C4);
