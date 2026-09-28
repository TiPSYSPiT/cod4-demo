/* Display names of maps and game types. The maps come from the map registry
 * (assets/maps/maps.js, C4.maps) - there is no second map list here. */
C4.define('names', function (C4) {
  'use strict';
  const GAMETYPES = {
    sd: 'Search & Destroy', sab: 'Sabotage', war: 'Team Deathmatch', dm: 'Free-for-all',
    dom: 'Domination', koth: 'Headquarters', ctf: 'Capture the Flag', hq: 'Headquarters',
    deathrun: 'Deathrun'
  };

  /** 'mp_backlot_x' -> key 'mp_backlot' (see C4.maps.resolve: exact name, alias, longest prefix) */
  function mapKey(raw) {
    return C4.maps ? C4.maps.resolve(raw) : null;
  }

  /** display name from the map registry; unknown maps: "mp_some_map" -> "Some Map" */
  function mapDisplay(raw) {
    const k = mapKey(raw);
    if (k) return C4.maps.MAPS[k].display;
    return String(raw || '').replace(/^mp_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function gametypeDisplay(raw) {
    return GAMETYPES[String(raw || '').toLowerCase()] || String(raw || '');
  }

  C4.names = { mapKey, mapDisplay, gametypeDisplay, GAMETYPES };
});
