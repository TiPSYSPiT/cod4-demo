/* Event list, chat and console lines. All times in ms since the first snapshot. */
C4.define('events', function (C4) {
  'use strict';
  const { stripColors } = C4.text;

  const EVENT_TYPES = [
    // [key, label, default visible, requested by the brief]
    ['ready', 'Player ready', true],
    ['connected', 'Player connected', true],
    ['disconnected', 'Player disconnected', true],
    ['joined', 'Joined the server', true],
    ['left', 'Left the server', true],
    ['attack_eliminated', 'Attack eliminated', true],
    ['defence_eliminated', 'Defence eliminated', true],
    ['bomb_planted', 'Bomb planted', true],
    ['bomb_defused', 'Bomb defused', true],
    ['kill', 'Kill', true],
    ['halftime', 'Halftime', true],
    ['timeout', 'Timeout called', true],
    ['team_join', 'Joined team', false],
    ['bomb_pickup', 'Bomb picked up', false],
    ['bomb_drop', 'Bomb dropped', false]
  ];

  /** name -> client resolver over every name a client ever had */
  function nameResolver(nameHistory, names) {
    const all = [];
    for (const h of nameHistory) all.push([stripColors(h.name).trim(), h.client]);
    for (const [cl, v] of names) {
      all.push([stripColors(v.name).trim(), cl]);
      // CoD4X clan tag: server messages can carry it in front of the name ("[TAG]name")
      if (v.clantag) all.push(['[' + stripColors(v.clantag).trim() + ']' + stripColors(v.name).trim(), cl]);
    }
    all.sort((a, b) => b[0].length - a[0].length);
    const exact = new Map();
    for (const [n, cl] of all) if (n && !exact.has(n)) exact.set(n, cl);
    return {
      exact(text) { const n = stripColors(text).trim(); return exact.has(n) ? exact.get(n) : null; },
      /** longest known name the text starts with; returns [client, rest] */
      prefix(text) {
        for (const [n, cl] of all) if (n && text.startsWith(n)) return [cl, text.slice(n.length)];
        return [null, text];
      },
      /** first known name contained in the text */
      contained(text) {
        for (const [n, cl] of all) if (n.length >= 3 && text.includes(n)) return cl;
        return null;
      }
    };
  }

  function buildEvents(ctx) {
    const { commands, rounds, kills, slotEvents, resolver, povClient, playerName, endTime } = ctx;
    const ev = [];
    const add = (t, type, text, clients = [], extra = {}) => ev.push(Object.assign({ t, type, text, clients }, extra));

    for (const s of slotEvents) {
      if (s.t <= 0) continue;                       // already connected when the demo started
      add(s.t, s.kind, playerName(s.client) + (s.kind === 'connected' ? ' connected (client slot ' + s.client + ' appears)' : ' disconnected (client slot ' + s.client + ' freed)'), [s.client]);
    }
    let lastReadyWaiting = null, lastSelfReady = null;
    for (const c of commands) {
      const d = c.d;
      if (d.verb === 'f' || d.verb === 'e' || d.verb === 'c' || d.verb === 'g') {
        const text = stripColors(d.text).trim();
        let m;
        if ((m = text.match(/^MP_CONNECTED(.+)$/))) {
          const cl = resolver.exact(m[1]);
          add(c.t, 'joined', m[1].trim() + ' joined the server', cl != null ? [cl] : []);
        } else if ((m = text.match(/^(.+?) EXE_LEFTGAME$/))) {
          const cl = resolver.exact(m[1]);
          add(c.t, 'left', m[1].trim() + ' left the server', cl != null ? [cl] : []);
        } else if ((m = text.match(/^(.+) Joined (Attack|Defence|Defense|Shoutcaster|Spectators?)$/i))) {
          const cl = resolver.exact(m[1]);
          add(c.t, 'team_join', m[1].trim() + ' joined ' + m[2], cl != null ? [cl] : []);
        } else if ((m = text.match(/^Timeout called by (.+)$/i))) {
          const cl = resolver.exact(m[1]);
          add(c.t, 'timeout', 'Timeout called by ' + m[1].trim(), cl != null ? [cl] : []);
        } else if ((m = text.match(/^MP_EXPLOSIVES_(PLANTED|DEFUSED|RECOVERED|DROPPED)_BY(.*)$/))) {
          const cl = resolver.exact(m[2]);
          const type = { PLANTED: 'bomb_planted', DEFUSED: 'bomb_defused', RECOVERED: 'bomb_pickup', DROPPED: 'bomb_drop' }[m[1]];
          const verb = { PLANTED: 'planted the bomb', DEFUSED: 'defused the bomb', RECOVERED: 'picked up the bomb', DROPPED: 'dropped the bomb' }[m[1]];
          add(c.t, type, m[2].trim() + ' ' + verb, cl != null ? [cl] : []);
        }
      } else if (d.verb === 'v') {
        for (const [name, value] of d.dvars) {
          if (name === 'self_ready') {
            if (value === '1' && lastSelfReady !== '1') add(c.t, 'ready', playerName(povClient) + ' is ready (demo POV)', [povClient], { pov: true });
            lastSelfReady = value;
          } else if (name === 'waiting_on') {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && lastReadyWaiting != null && n < lastReadyWaiting) {
              const k = lastReadyWaiting - n;
              add(c.t, 'ready', (k === 1 ? 'A player is' : k + ' players are') + ' ready - waiting on ' + n + ' more', [], { anonymous: true });
            }
            if (Number.isFinite(n)) lastReadyWaiting = n;
          }
        }
      }
    }
    // status lines: "All Players are Ready!", "Attack eliminated", "Defence eliminated"
    const seen = new Map();
    for (const s of ctx.status) {
      let type = null;
      if (/^all players are ready/i.test(s.text)) type = 'ready';
      else if (/^attack eliminated/i.test(s.text)) type = 'attack_eliminated';
      else if (/^defen[cs]e eliminated/i.test(s.text)) type = 'defence_eliminated';
      if (!type) continue;
      const key = type + s.text;
      if (seen.has(key) && s.t - seen.get(key) < 3000) continue;
      seen.set(key, s.t);
      add(s.t, type, s.text, [], type === 'ready' ? { all: true } : {});
    }
    for (const h of ctx.halftimes) add(h, 'halftime', 'Halftime - teams switch sides', [], { heuristic: !ctx.halftimeFromSound });
    for (const k of kills) add(k.t, 'kill', '', [k.attacker, k.victim].filter(x => x != null && x < 64), { kill: k.index });

    ev.sort((a, b) => a.t - b.t || EVENT_TYPES.findIndex(x => x[0] === a.type) - EVENT_TYPES.findIndex(x => x[0] === b.type));
    for (const e of ev) { e.t = Math.max(0, Math.min(e.t, endTime)); e.round = roundAt(rounds, e.t); }
    return ev;
  }

  /** index of the round a time belongs to (by segment), or -1 */
  function roundAt(rounds, t) {
    for (let i = 0; i < rounds.length; i++) if (t >= rounds[i].segStart && t < rounds[i].segEnd + 1) return i;
    return -1;
  }

  /* ---- chat ---- */
  function buildChat(ctx) {
    const { commands, resolver, rounds } = ctx;
    const out = [];
    for (const c of commands) {
      if (c.d.verb !== 'h' && c.d.verb !== 'i') continue;
      const raw = c.d.text || '';
      let clean = stripColors(raw);
      const prefixes = [];
      while (/^[([]/.test(clean)) {
        const close = clean.indexOf(clean[0] === '(' ? ')' : ']');
        if (close < 0 || close > 40) break;
        prefixes.push(clean.slice(1, close));
        clean = clean.slice(close + 1).trimStart();
      }
      let [client, rest] = resolver.prefix(clean);
      let message;
      if (client != null && rest.startsWith(':')) message = rest.slice(1).trim();
      else {
        client = null;
        const i = clean.indexOf(': ');
        message = i >= 0 ? clean.slice(i + 2) : clean;
      }
      const dead = prefixes.some(p => /dead/i.test(p));
      out.push({ t: c.t, round: roundAt(rounds, c.t), scope: c.d.scope, client, dead,
        senderRaw: client == null ? (clean.indexOf(':') > 0 ? clean.slice(0, clean.indexOf(':')) : '') : null,
        text: quickMessage(message), raw });
    }
    return out;
  }

  const QUICK = {
    QUICKMESSAGE_FOLLOW_ME: 'Follow me!', QUICKMESSAGE_MOVE_IN: 'Move in!', QUICKMESSAGE_FALL_BACK: 'Fall back!',
    QUICKMESSAGE_SUPPRESSING_FIRE: 'Suppressing fire!', QUICKMESSAGE_ATTACK_LEFT_FLANK: 'Attack left flank!',
    QUICKMESSAGE_ATTACK_RIGHT_FLANK: 'Attack right flank!', QUICKMESSAGE_HOLD_THIS_POSITION: 'Hold this position!',
    QUICKMESSAGE_REGROUP: 'Regroup!', QUICKMESSAGE_ENEMY_SPOTTED: 'Enemy spotted!', QUICKMESSAGE_ENEMIES_SPOTTED: 'Enemies spotted!',
    QUICKMESSAGE_IM_IN_POSITION: "I'm in position.", QUICKMESSAGE_AREA_SECURE: 'Area secure!', QUICKMESSAGE_GRENADE: 'Grenade!',
    QUICKMESSAGE_SNIPER: 'Sniper!', QUICKMESSAGE_NEED_REINFORCEMENTS: 'Need reinforcements!', QUICKMESSAGE_HOLD_YOUR_FIRE: 'Hold your fire!',
    QUICKMESSAGE_YES_SIR: 'Yes sir!', QUICKMESSAGE_NO_SIR: 'No sir!', QUICKMESSAGE_IM_ON_MY_WAY: "I'm on my way.",
    QUICKMESSAGE_SORRY: 'Sorry.', QUICKMESSAGE_GREAT_SHOT: 'Great shot!', QUICKMESSAGE_TOOK_LONG_ENOUGH: 'Took long enough!',
    QUICKMESSAGE_ARE_YOU_CRAZY: 'Are you crazy?', QUICKMESSAGE_COME_ON: 'Come on.', QUICKMESSAGE_WATCH_SIX: 'Watch your six!'
  };
  function quickMessage(text) {
    const k = String(text || '').trim();
    return QUICK[k] ? QUICK[k] + ' [quick message]' : text;
  }

  /* ---- console ---- */
  function consoleType(v) {
    if (v === 'e') return 'print';
    if (v === 'f') return 'message';
    if (v === 'c' || v === 'g') return 'announcement';
    if (v === 'h' || v === 'i') return 'chat';
    if (v === 'd' || v === 'x' || v === 'y' || v === 'z') return 'configstring';
    if (v === 'v') return 'dvar';
    if (v === 'b' || v === 'G' || v === 'H' || v === 'I') return 'score';
    if (v === 'n' || v === 'B' || v === 'm') return 'restart';
    return 'command';
  }

  function buildConsole(ctx) {
    const { commands, resolver, rounds, gamestate, issues, csCategory, csOld } = ctx;
    const out = [];
    if (gamestate) {
      out.push({ t: 0, type: 'system', text: 'Gamestate: ' + gamestate.configstrings.size + ' config strings, ' + gamestate.baselines.size + ' entity baselines, recording client ' + gamestate.clientNum });
      for (const idx of [0, 1, 2]) {
        const v = gamestate.configstrings.get(idx);
        if (v) out.push({ t: 0, type: 'system', text: ['serverinfo', 'systeminfo', 'game version'][idx] + ': ' + v });
      }
    }
    for (const i of issues) out.push({ t: i.t || 0, type: 'warning', text: i.text });
    for (const c of commands) {
      const d = c.d;
      const type = consoleType(d.verb);
      let text;
      if (type === 'configstring') {
        const old = csOld.get(c);
        text = 'config string ' + d.index + ' (' + csCategory(d.index) + ') = "' + stripColors(d.value) + '"' + (old != null ? '   (was "' + stripColors(old) + '")' : '');
        if (d.verb !== 'd') text = '[' + d.name + '] ' + text;
      } else if (type === 'dvar') {
        text = 'dvars: ' + d.dvars.map(([n, v]) => n + '=' + stripColors(v)).join('  ');
      } else if (d.verb === 'b') {
        text = 'scoreboard: axis ' + d.scoreAxis + ' - allies ' + d.scoreAllies + ', ' + d.entries.length + ' players, limit ' + d.scorelimit;
      } else if (d.verb === 'G' || d.verb === 'H') {
        text = 'team score ' + d.team + ' = ' + d.score;
      } else if (d.text != null) {
        text = stripColors(d.text);
      } else {
        text = c.text;
      }
      const plain = stripColors(c.text);
      out.push({ t: c.t, type, verb: d.verb, text, raw: c.text, client: type === 'chat' || type === 'message' || type === 'print' || type === 'announcement' ? resolver.contained(plain) : null });
    }
    out.sort((a, b) => a.t - b.t);
    for (const o of out) o.round = roundAt(rounds, o.t);
    return out;
  }

  C4.events = { EVENT_TYPES, nameResolver, buildEvents, buildChat, buildConsole, roundAt };
});
