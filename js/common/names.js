/* Display names of maps and game types. */
C4.define('names', function (C4) {
  'use strict';
  const MAPS = {
    mp_backlot: 'Backlot', mp_bloc: 'Bloc', mp_bog: 'Bog', mp_broadcast: 'Broadcast',
    mp_carentan: 'Chinatown', mp_cargoship: 'Wet Work', mp_citystreets: 'District',
    mp_convoy: 'Ambush', mp_countdown: 'Countdown', mp_crash: 'Crash', mp_crash_snow: 'Winter Crash',
    mp_creek: 'Creek', mp_crossfire: 'Crossfire', mp_farm: 'Downpour', mp_killhouse: 'Killhouse',
    mp_overgrown: 'Overgrown', mp_pipeline: 'Pipeline', mp_shipment: 'Shipment',
    mp_showdown: 'Showdown', mp_strike: 'Strike', mp_vacant: 'Vacant', mp_cluster: 'Cluster'
  };
  const GAMETYPES = {
    sd: 'Search & Destroy', sab: 'Sabotage', war: 'Team Deathmatch', dm: 'Free-for-all',
    dom: 'Domination', koth: 'Headquarters', ctf: 'Capture the Flag', hq: 'Headquarters',
    deathrun: 'Deathrun'
  };

  /** 'mp_backlot_x' -> key 'mp_backlot' (exact name first, then the longest known prefix) */
  function mapKey(raw) {
    const name = String(raw || '').toLowerCase();
    if (MAPS[name]) return name;
    let best = null;
    for (const k of Object.keys(MAPS)) {
      if (name.startsWith(k + '_') && (!best || k.length > best.length)) best = k;
    }
    return best;
  }

  function mapDisplay(raw) {
    const k = mapKey(raw);
    if (k) return MAPS[k];
    return String(raw || '').replace(/^mp_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function gametypeDisplay(raw) {
    return GAMETYPES[String(raw || '').toLowerCase()] || String(raw || '');
  }

  C4.names = { mapKey, mapDisplay, gametypeDisplay, MAPS, GAMETYPES };
});
