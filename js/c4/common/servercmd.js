/* Decoding of reliable server commands (first character selects the handler,
 * CG_DeployServerCommand / CL_CGameNeedsServerCommand). */
C4.define('servercmd', function (C4) {
  'use strict';
  const { tokenize } = C4.text;
  const NAMES = {
    B: 'map_restart', C: 'set_equipped_offhand', D: 'reverb_deactivate', E: 'channel_volume_set',
    F: 'channel_volume_deactivate', G: 'team_score_axis', H: 'team_score_allies', I: 'client_score',
    J: 'menu_show_notify', K: 'reset_player_muting', L: 'close_ingame_menu', N: 'set_stat',
    a: 'select_weapon', b: 'scoreboard', c: 'announcement', d: 'configstring', e: 'print',
    f: 'game_message', g: 'bold_game_message', h: 'chat', i: 'team_chat', j: 'dynent_destroy',
    k: 'local_sound_stop', n: 'map_restart_persist', o: 'play_music', p: 'stop_music',
    q: 'fade_sounds', r: 'reverb', s: 'local_sound', t: 'open_script_menu', u: 'close_script_menu',
    v: 'set_client_dvars', w: 'disconnect', x: 'big_configstring_start',
    y: 'big_configstring_append', z: 'big_configstring_end'
  };
  const int = s => { const v = parseInt(s, 10); return Number.isFinite(v) ? v : null; };

  function decode(text) {
    const verb = text ? text[0] : '';
    const out = { verb, name: NAMES[verb] || 'unknown' };
    if (verb === 'd' || verb === 'x' || verb === 'y' || verb === 'z') {
      const argv = tokenize(text, 3);
      out.index = argv.length > 1 ? int(argv[1]) : null;
      out.value = argv.length > 2 ? argv[2] : '';
      return out;
    }
    const args = tokenize(text).slice(1);
    out.args = args;
    switch (verb) {
      case 'b': {
        const n = int(args[0]) || 0;
        out.scoreAxis = int(args[1]);
        out.scoreAllies = int(args[2]);
        out.scorelimit = int(args[3]);
        out.entries = [];
        for (let i = 0; i < Math.min(n, 64); i++) {
          const b = 4 + 7 * i;
          if (b + 7 > args.length) break;
          const v = args.slice(b, b + 7).map(int);
          out.entries.push({ client: v[0], score: v[1], ping: v[2], deaths: v[3], statusIcon: v[4], kills: v[5], assists: v[6] });
        }
        break;
      }
      case 'h': case 'i': out.text = args[0] || ''; out.scope = verb === 'h' ? 'all' : 'team'; break;
      case 'c': case 'e': case 'f': case 'g': out.text = args[0] || ''; break;
      case 'G': case 'H': out.team = verb === 'G' ? 'axis' : 'allies'; out.score = int(args[0]); break;
      case 'I': out.client = int(args[0]); out.score = int(args[1]); break;
      case 'v':
        out.dvars = [];
        for (let i = 0; i < args.length; i += 2) out.dvars.push([args[i], args[i + 1] == null ? '' : args[i + 1]]);
        break;
      case 'w': out.reason = args[0] || ''; break;
      default: break;
    }
    return out;
  }

  /** Reassembles x / y / z pieces into one config string update. */
  class BigConfigString {
    constructor() { this.index = null; this.buf = ''; }
    feed(d) {
      if (d.verb === 'x') { this.index = d.index; this.buf = d.value; }
      else if (d.verb === 'y') this.buf += d.value;
      else if (d.verb === 'z') {
        this.buf += d.value;
        if (this.index != null) { const r = [this.index, this.buf]; this.index = null; this.buf = ''; return r; }
      }
      return null;
    }
  }

  C4.servercmd = { decode, BigConfigString, NAMES };
});
