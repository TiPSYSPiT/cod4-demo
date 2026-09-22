/*!
 * app.js - user interface for the CoD4 Demo Inspector.
 * Parsing and analysis live in dm1.js; this file only handles files and rendering.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function () {
"use strict";

const { parseDemo, parseDemoAsync, analyze, strip } = window.DM1;

const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};
/** Elapsed time as m:ss - truncated, not rounded, like a clock. */
const mmss = s => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const tick = () => new Promise(r => setTimeout(r, 0));

/** CoD4 colour codes (^0 .. ^9) as coloured spans; control characters are dropped. */
function cod4(text, into){
  const node = into || el("span");
  const parts = String(text == null ? "" : text).split(/(\^[0-9])/);
  let color = null;
  for (const part of parts) {
    if (!part) continue;
    if (/^\^[0-9]$/.test(part)) { color = part[1]; continue; }
    const s = el("span", null, part.replace(/\^[:;<=>?]/g, "").replace(/[\x00-\x1f\x7f]/g, ""));
    if (color !== null) s.style.color = "var(--c" + color + ")";
    node.appendChild(s);
  }
  return node;
}

/* ============================ rendering ============================ */

function render(res, opts){
  opts = opts || {};
  const out = $("#out");
  out.textContent = "";
  const wrap = el("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:22px";

  if (opts.fileName) {
    const i = res.info;
    const b = el("div", "samplebanner");
    b.append(el("b", null, opts.fileName),
             el("span", "dim", (i.sizeBytes / 1048576).toFixed(2) + " MB \u00b7 " +
               i.snapshots.toLocaleString("en-US") + " snapshots \u00b7 " +
               i.frames.toLocaleString("en-US") + " frames \u00b7 " +
               (i.cleanEof ? "clean EOF" : "no EOF marker (recording may be truncated)")));
    wrap.append(b);
  }

  wrap.append(scorebug(res), infoGrid(res));

  const tabs = el("div", "tabs");
  const panels = el("div");
  const defs = [
    ["Players", () => playersPanel(res)],
    ["Round by round", () => roundsPanel(res)],
    ["Kills per round", () => killMatrix(res)],
    ["Map", () => mapPanel(res)],
    ["Chat", () => chatLog(res)],
    ["Events", () => eventLog(res)],
    ["Raw data", () => rawPanel(res, opts)]
  ];
  const show = i => {
    [...tabs.children].forEach((b, k) => b.setAttribute("aria-selected", k === i ? "true" : "false"));
    panels.textContent = "";
    panels.append(defs[i][1]());
  };
  defs.forEach(([label], i) => {
    const b = el("button", "tab", label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", "false");
    b.addEventListener("click", () => show(i));
    tabs.append(b);
  });
  wrap.append(tabs, panels);
  out.append(wrap);
  show(0);
}

/** Player name in the team colour, with the CoD4 colour codes in the name itself. */
function playerName(res, player, client){
  const span = el("span", "pname" + (player ? " t" + teamIndex(res, player.team) : ""));
  span.append(cod4(player ? player.name : "client " + client));
  return span;
}

function teamIndex(res, name){
  const i = res.teams.findIndex(t => t.name === name);
  return i === 1 ? 1 : 0;
}

function scorebug(res){
  const empty = { name: "?", wins: 0, halves: [] };
  const a = res.teams[0] || empty, b = res.teams[1] || empty;
  const side = (t, right, win) => {
    const d = el("div", "side" + (right ? " r" : "") + (win ? " w" : ""));
    const meta = el("div", "meta");
    meta.append(el("div", "tname", t.name),
                el("div", "sub", t.halves && t.halves.length ? "Halves " + t.halves.join(" + ") : ""));
    d.append(meta, el("div", "num", String(t.wins)));
    return d;
  };
  const bug = el("div", "bug");
  bug.append(side(a, false, a.wins > b.wins),
             el("div", "mid", res.info.scorelimit ? "MR " + (res.info.scorelimit - 1) : "Final"),
             side(b, true, b.wins > a.wins));
  return bug;
}

function infoGrid(res){
  const i = res.info;
  const rows = [
    ["Map", i.map || "\u2013"],
    ["Mode", (i.gametype === "sd" ? "Search & Destroy" : i.gametype || "\u2013") +
             (i.scorelimit ? " \u00b7 limit " + i.scorelimit : "")],
    ["Ruleset", i.ruleset || i.mod || "\u2013"],
    ["Server", i.server || "\u2013"],
    ["Demo POV", i.povName ? strip(i.povName) : "client " + i.povClient],
    ["Length", mmss(i.durationS) + " min"],
    ["Recorded", i.mapStart || "\u2013"],
    ["Protocol", i.protocol + (i.protocol >= 17 ? " (CoD4X)" : "")]
  ];
  const g = el("dl", "info");
  for (const [k, v] of rows) {
    const d = el("div");
    d.append(el("dt", null, k), el("dd", null, v));
    g.append(d);
  }
  return g;
}

/* ---- players: one table per team ---- */

function playersPanel(res){
  const sec = el("div", "sec");
  for (const team of res.teams) {
    const ti = teamIndex(res, team.name);
    const players = res.players.filter(p => p.team === team.name);
    if (!players.length) continue;
    const k = players.reduce((s, p) => s + p.kills, 0);
    const d = players.reduce((s, p) => s + p.deaths, 0);
    const a = players.reduce((s, p) => s + p.assists, 0);
    const sc = players.reduce((s, p) => s + p.score, 0);

    const block = el("div", "teamblock");
    const head = el("div", "tbhead");
    head.append(el("span", "pill t" + ti, team.name));
    head.append(el("span", "tbwins", team.wins + (team.wins === 1 ? " round" : " rounds") + " won"));
    head.append(el("span", "tbsum", k + " K \u00b7 " + d + " D \u00b7 " +
      (d ? k / d : k).toFixed(2) + " K/D \u00b7 " + a + " A"));
    block.append(head);

    const box = el("div", "scroll");
    const t = el("table", "ptable");
    // Fixed column grid, so both team tables line up underneath each other.
    const cg = el("colgroup");
    ["92px", "", "104px", "76px", "76px", "76px", "96px"].forEach(w => {
      const c = el("col");
      if (w) c.style.width = w;
      cg.append(c);
    });
    const thead = el("thead"), hr = el("tr");
    ["", "Player", "Score", "K", "A", "D", "K/D"]
      .forEach((h, i) => hr.append(el("th", i >= 2 ? "n" : null, h)));
    thead.append(hr);
    const tb = el("tbody");
    for (const p of players) {
      const tr = el("tr");
      const c0 = el("td", "rail t" + ti);
      c0.append(el("span", "pill t" + ti, p.team));
      const nameTd = el("td");
      nameTd.append(cod4(p.name));
      if (p.client === res.info.povClient) nameTd.append(el("span", "dim", "  \u25cf POV"));
      // Whoever joined late or left early gets that next to the name
      if (p.joinedS != null) nameTd.append(el("span", "dim joinleft", "  joined " + mmss(p.joinedS)));
      if (p.leftS != null) nameTd.append(el("span", "dim joinleft", "  left " + mmss(p.leftS)));
      tr.append(c0, nameTd);
      const kd = p.deaths ? p.kills / p.deaths : p.kills;
      [p.score, p.kills, p.assists, p.deaths, kd.toFixed(2)]
        .forEach(v => tr.append(el("td", "n", String(v))));
      tb.append(tr);
    }
    const tr = el("tr", "teamrow sep");
    tr.append(el("td", "rail t" + ti), el("td", null, "Team total"));
    [sc, k, a, d, (d ? k / d : k).toFixed(2)].forEach(v => tr.append(el("td", "n", String(v))));
    tb.append(tr);
    t.append(cg, thead, tb);
    box.append(t);
    block.append(box);
    sec.append(block);
  }
  const info = res.info || {};
  sec.append(el("p", "note", info.statsSource === "killfeed"
    ? "Kills and deaths are counted from the decoded kill feed, by the same rule the scoreboard uses: " +
      "inside rounds only, team kills do not count for the shooter. Score and assists come from the " +
      "server's last scoreboard" + (info.scoreboardStale
        ? ", which it sent before the final round \u2014 so those two columns are one round behind." : ".")
    : "Kills, deaths, assists and score come from the server's last scoreboard command. " +
      "Score = 5 per kill + 3 per assist + 3 per plant or defuse."));
  return sec;
}

/* ---- round by round ---- */

function roundsPanel(res){
  const sec = el("div", "sec");
  if (!res.rounds.length) {
    sec.append(el("p", "note", "No round structure found (not a Search & Destroy / Promod demo?)."));
    return sec;
  }
  const head = el("div", "panelhead");
  head.append(el("h2", null, "Round by round"),
              el("span", "dim", res.rounds.length + " rounds" +
                (res.knifeS !== null && res.knifeS !== undefined
                  ? " \u00b7 knife round at " + mmss(res.knifeS) : "")));
  sec.append(head);

  const list = el("div", "rounds");
  for (const r of res.rounds) {
    const ti = teamIndex(res, r.winner);
    const card = el("div", "round");

    const rh = el("div", "rhead");
    rh.append(el("span", "rnum", "Round " + r.n));
    rh.append(el("span", "rwin t" + ti, r.winner + " win"));
    rh.append(el("span", "rmeta", r.reason + " \u00b7 " + Math.round(r.durS) + "s \u00b7 half " +
      r.half + " \u00b7 at " + mmss(r.startS)));
    rh.append(el("span", "rscore", r.score.replace(":", " \u2014 ")));
    card.append(rh);

    const tl = r.timeline || [];
    if (tl.length) {
      const body = el("div", "tl");
      for (const ev of tl) {
        const row = el("div", "row");
        // Time relative to the round start - that way a round reads like a kill feed.
        row.append(el("div", "t", mmss(Math.max(0, ev.tS - r.startS))));
        const mid = el("div", "what");
        if (ev.kind === "kill") {
          const byName = res.players.find(p => p.client === ev.killer);
          const toName = res.players.find(p => p.client === ev.victim);
          if (ev.suicide) {
            mid.append(playerName(res, toName, ev.victim));
            mid.append(el("span", "dim", "died"));
          } else {
            mid.append(playerName(res, byName, ev.killer));
            mid.append(el("span", "arrow", "\u2192"));
            mid.append(playerName(res, toName, ev.victim));
          }
        } else if (ev.kind === "down") {
          const ei = teamIndex(res, ev.team);
          mid.append(el("span", "pill t" + ei, ev.team));
          mid.append(el("span", null, ev.n > 1 ? ev.n + " players down" : "player down"));
        } else {
          mid.append(el("span", "bicon", "\u25c8"));
          const txt = el("span");
          txt.append(document.createTextNode(ev.action + (ev.player ? " \u2014 " : "")));
          if (ev.player) txt.append(cod4(ev.player));
          mid.append(txt);
        }
        row.append(mid);
        const right = el("div", "rmeta2");
        if (ev.kind === "kill") {
          // For a death with no attacker the cause says more than the "World" badge.
          if (!ev.headshot && ev.weapon !== "suicide")
            right.append(el("span", "weap", ev.weaponLabel));
          if (ev.first && !ev.suicide) right.append(el("span", "badge first", "Opening"));
          if (ev.headshot) right.append(el("span", "badge hs", "Headshot"));
          if (ev.suicide) right.append(el("span", "badge", "World"));
        } else {
          if (ev.first) right.append(el("span", "badge first", "First blood"));
          if (ev.kind === "down") right.append(el("span", "alive", ev.aliveSelf + " v " + ev.aliveOther));
        }
        row.append(right);
        body.append(row);
      }
      card.append(body);
    } else {
      card.append(el("p", "note tlempty", "No timeline data for this round."));
    }

    list.append(card);
  }
  sec.append(list);
  sec.append(el("p", "note", (res.info && res.info.killFeed)
    ? "Kill feed decoded from the obituary events in the snapshots: killer, victim and weapon as the " +
      "server sent them. Weapon names come from the server's own weapon list; for headshots the engine " +
      "sends the hit type instead of the weapon."
    : "Without snapshot data the rows come from the alive counters and only show which side lost a " +
      "player, not who killed whom."));
  return sec;
}

/* ---- kills per round ---- */

function killMatrix(res){
  const sec = el("div", "sec");
  if (!res.rounds.length) {
    sec.append(el("p", "note", "No rounds found."));
    return sec;
  }
  const box = el("div", "scroll");
  const t = el("table", "mtx");
  const thead = el("thead"), head = el("tr");
  head.append(el("th", null, "Player"));
  res.rounds.forEach((r, i) => {
    // A column after a gap carries that gap's kills and is marked with *.
    const gapBefore = i > 0 && !res.rounds[i - 1].exact;
    head.append(el("th", "k" + (r.exact ? "" : " q"), r.exact ? (r.n + (gapBefore ? "*" : "")) : "?"));
  });
  head.append(el("th", "n", "K"), el("th", "n", "D"));
  thead.append(head);
  const tb = el("tbody");
  let max = 1;
  for (const r of res.rounds) for (const v of Object.values(r.kills || {})) max = Math.max(max, v);
  for (const p of res.players) {
    const tr = el("tr");
    const nameTd = el("td");
    nameTd.append(cod4(p.name));
    tr.append(nameTd);
    let K = 0, D = 0;
    for (const r of res.rounds) {
      if (!r.exact) { tr.append(el("td", "k q", "?")); continue; }
      const v = r.kills[p.client] || 0;
      K += v;
      D += r.deaths[p.client] || 0;
      const td = el("td", "k" + (v ? "" : " z"), v ? String(v) : "\u00b7");
      if (v) td.style.background = "rgb(var(--heat) / " + (0.1 + 0.5 * v / max).toFixed(2) + ")";
      tr.append(td);
    }
    tr.append(el("td", "n", String(K)), el("td", "n", String(D)));
    tb.append(tr);
  }
  t.append(thead, tb);
  box.append(t);
  sec.append(box);
  const gaps = res.rounds.filter(r => !r.exact).length;
  sec.append(el("p", "note", ((res.info && res.info.killFeed)
    ? "Counted from the kill feed, so every round is exact."
    : "Differences between consecutive scoreboards.") + (gaps
    ? " For " + gaps + " round(s) the server sent no scoreboard of its own (marked ?); those kills " +
      "are counted in the next column (*). The totals on the right are correct."
    : "")));
  return sec;
}

function chatLog(res){
  const sec = el("div", "sec");
  if (!res.chat.length) {
    sec.append(el("p", "note", "No chat recorded."));
    return sec;
  }
  const log = el("div", "log");
  for (const c of res.chat) {
    const row = el("div", "row");
    row.append(el("div", "t", mmss(c.tS)), el("div", "sc", c.scope === "team" ? "Team" : "All"));
    const m = el("div", "msg");
    m.append(cod4(c.text));
    row.append(m);
    log.append(row);
  }
  sec.append(log);
  return sec;
}

function eventLog(res){
  const sec = el("div", "sec");
  if (!res.events.length) {
    sec.append(el("p", "note", "No events found."));
    return sec;
  }
  const bar = el("div", "bar");
  const f = el("input", "filter");
  f.type = "search";
  f.id = "eventfilter";
  f.placeholder = "Filter events \u2026";
  const count = el("span", "dim", res.events.length + " events");
  bar.append(f, count);
  sec.append(bar);

  const log = el("div", "log");
  const rows = [];
  for (const e of res.events) {
    const row = el("div", "row ev");
    row.append(el("div", "t", mmss(e.tS)));
    const m = el("div", "msg");
    if (e.kind === "half") m.append(el("b", null, "\u2014 Halftime \u2014"));
    else m.append(cod4(e.text));
    row.append(m);
    log.append(row);
    rows.push([row, (mmss(e.tS) + " " + e.text).toLowerCase()]);
  }
  sec.append(log);
  f.addEventListener("input", () => {
    const q = f.value.trim().toLowerCase();
    let shown = 0;
    for (const [row, hay] of rows) {
      const hit = !q || hay.includes(q);
      row.hidden = !hit;
      if (hit) shown++;
    }
    count.textContent = q ? shown + " of " + rows.length + " events" : rows.length + " events";
  });
  return sec;
}

function rawPanel(res, opts){
  const sec = el("div", "sec");
  const bar = el("div", "bar");
  const json = JSON.stringify(res, null, 1);
  const copy = el("button", "btn ghost", "Copy JSON");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(json);
      copy.textContent = "Copied \u2713";
    } catch (e) {
      const pre = $("#jsonbox");
      const r = document.createRange();
      r.selectNodeContents(pre);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      copy.textContent = "Selected \u2013 press Ctrl+C";
    }
    setTimeout(() => { copy.textContent = "Copy JSON"; }, 2200);
  });
  bar.append(copy);

  if (opts.rawCommands) {
    const f = el("input", "filter");
    f.type = "search";
    f.id = "cmdfilter";
    f.placeholder = "Filter server commands \u2026";
    bar.append(f);
    sec.append(bar);
    const box = el("div", "scroll");
    box.style.maxHeight = "520px";
    box.style.overflowY = "auto";
    const t = el("table");
    const thead = el("thead"), head = el("tr");
    ["Time", "Seq", "Command"].forEach((h, i) => head.append(el("th", i === 1 ? "n" : null, h)));
    thead.append(head);
    const tb = el("tbody");
    for (const c of opts.rawCommands) {
      const tr = el("tr");
      tr.append(el("td", "mono dim", mmss((c.time - opts.rawT0) / 1000)), el("td", "n", String(c.cseq)));
      const td = el("td", "mono");
      td.style.whiteSpace = "pre-wrap";
      td.textContent = c.text.length > 400 ? c.text.slice(0, 400) + " \u2026" : c.text;
      tr.append(td);
      tb.append(tr);
    }
    t.append(thead, tb);
    box.append(t);
    sec.append(box);
    f.addEventListener("input", () => {
      const q = f.value.toLowerCase();
      for (const tr of tb.children) tr.hidden = q && !tr.lastChild.textContent.toLowerCase().includes(q);
    });
  } else {
    sec.append(bar, el("p", "note",
      "The full server command stream appears here once you load a demo of your own."));
  }
  const pre = el("pre", "json");
  pre.id = "jsonbox";
  pre.textContent = json;
  sec.append(pre);
  return sec;
}

/* ============================ loading a file ============================ */

const progEl = $("#prog"), pbar = $("#pbar"), pmsg = $("#pmsg"), errEl = $("#error");
function progress(pct, msg){ progEl.hidden = false; pbar.value = pct; pmsg.textContent = msg; }

async function handleFile(file){
  errEl.hidden = true;
  try {
    progress(1, "Reading file \u2026");
    await tick();
    const bytes = new Uint8Array(await file.arrayBuffer());
    progress(3, "Building Huffman table \u2026");
    await tick();
    const t0 = performance.now();
    const parsed = await parseDemoAsync(bytes, frac => {
      progress(4 + 90 * frac, "Decoding snapshots \u2026 " + Math.round(100 * frac) + "%");
    });
    progress(96, "Analysing \u2026");
    await tick();
    const res = analyze(parsed);
    const ms = Math.round(performance.now() - t0);
    progress(100, "Done in " + (ms / 1000).toFixed(1) + " s \u2013 " + parsed.commands.length +
      " server commands, " + parsed.players.size + " players, " + res.kills.length + " kills" +
      (parsed.snapshotErrors ? ", " + parsed.snapshotErrors + " snapshots out of sync" : ""));
    let cmdT0 = 0;
    for (const c of parsed.commands) if (c.time > 0) { cmdT0 = c.time; break; }
    render(res, { fileName: file.name, rawCommands: parsed.commands, rawT0: cmdT0 });
    setTimeout(() => { progEl.hidden = true; }, 2500);
  } catch (e) {
    progEl.hidden = true;
    errEl.hidden = false;
    errEl.textContent = "Could not read this demo: " + (e && e.message ? e.message : e);
  }
}

$("#pick").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
const drop = $("#drop");
["dragenter", "dragover"].forEach(ev =>
  document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault();
  if (ev === "dragleave" && e.relatedTarget) return;
  drop.classList.remove("over");
}));
document.addEventListener("drop", e => {
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) handleFile(f);
});

/* ============================ map ============================ */

/* Grenade colours, deliberately fixed rather than taken from the theme: they
   have to stand apart from both team colours in light and dark alike. How long
   the marker stays after ignition is a display choice - how long a smoke cloud
   actually stands is not in the demo. */
/* color: marker colour. r: radius of the impact marker in pixels - purely a
   visual size, not an effect radius; how far a grenade reaches is not in the
   demo. hold: how long the marker stays, in seconds. */
const NADE = {
  frag:  { color: "#ff6a00", r: 10, hold: 2,  label: "frag" },
  smoke: { color: "#838383", r: 15, hold: 10, label: "smoke" },
  flash: { color: "#ffd21e", r: 10, hold: 2,  label: "flash" },
  other: { color: "#c08a4a", r: 10, hold: 2,  label: "other" }
};

/* ---- floor plan from the positions ---- */

const FLOOR_NOTE_IMAGE = "Floor plan: the map's own compass image, placed on the world rectangle from configstring 823.";
const FLOOR_NOTE_DERIVED = "No image for this map - the floor plan is built from every recorded position; cells nobody entered are drawn as walls.";

/** Edge length of a grid cell in game units. A player is about 30 wide; at 48
 *  doorways stay visible as gaps and corridors do not turn patchy. */
const CELL = 48;
/** Computed once per map - the floor plan depends only on the positions. */
const FLOOR_CACHE = new Map();
/** Drawn floor plans per map under web/maps/. If there is none for a map, the
 *  floor plan is built from the positions as before. */
const MAP_IMAGE_DIR = "maps/";
const MAP_IMAGES = new Map();
/** mp_backlot_x -> backlot: Promod variants carry a suffix, the map is the same. */
function mapImageName(map){
  return String(map || "").replace(/^mp_/, "").replace(/_(x|hq|sd|promod)$/, "");
}

/**
 * Build an occupancy grid: cells nobody ever stood in are wall.
 *
 * The map geometry is not in the demo. What is walkable, though, is given away
 * by the tracks themselves - over a whole match ten players cover the
 * accessible area almost completely.
 */
function buildFloor(key, tracks, minX, minY, maxX, maxY){
  const hit = FLOOR_CACHE.get(key);
  if (hit) return hit;
  const cols = Math.max(1, Math.ceil((maxX - minX) / CELL));
  const rows = Math.max(1, Math.ceil((maxY - minY) / CELL));
  const visits = new Uint32Array(cols * rows);
  for (const id of Object.keys(tracks)) {
    for (const p of tracks[id]) {
      const cx = ((p[1] - minX) / CELL) | 0, cy = ((p[2] - minY) / CELL) | 0;
      if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) visits[cy * cols + cx]++;
    }
  }
  let walk = new Uint8Array(cols * rows);
  for (let i = 0; i < visits.length; i++) walk[i] = visits[i] > 0 ? 1 : 0;
  // Close single holes: a cell in the middle of walkable area is not a pillar
  // but a spot where nobody happened to stand.
  const closed = walk.slice();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (walk[i]) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= rows || xx < 0 || xx >= cols) continue;
          n += walk[yy * cols + xx];
        }
      }
      if (n >= 6) closed[i] = 1;
    }
  }
  walk = closed;
  // The other way round: a walkable cell with no walkable neighbours is an
  // outlier (one player standing on a ledge for a moment), not an area.
  const cleaned = walk.slice();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!walk[i]) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= rows || xx < 0 || xx >= cols) continue;
          n += walk[yy * cols + xx];
        }
      }
      if (n <= 1) cleaned[i] = 0;
    }
  }
  walk = cleaned;
  let area = 0;
  for (let i = 0; i < walk.length; i++) area += walk[i];
  const floor = { cols, rows, minX, minY, walk, visits, area };
  FLOOR_CACHE.set(key, floor);
  return floor;
}

/* ---- user callouts ---- */

const calloutKey = map => "dm1.callouts." + map;

function loadCallouts(map){
  try {
    const raw = localStorage.getItem(calloutKey(map));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(c => c && typeof c.x === "number") : [];
  } catch (e) { return []; }
}

function saveCallouts(map, list){
  try { localStorage.setItem(calloutKey(map), JSON.stringify(list)); } catch (e) { /* never mind */ }
}

/* ---- lives ---- */

/**
 * Every round is exactly one life per player: it starts when the round starts
 * and ends with their own death or with the round. Search & Destroy has no
 * respawns, so this split is enough.
 */
function buildLives(res){
  const byClient = new Map();
  for (const p of res.players) byClient.set(p.client, []);
  for (let i = 0; i < res.rounds.length; i++) {
    const r = res.rounds[i];
    const end = r.startS + r.durS;
    for (const p of res.players) {
      const death = res.kills.find(k => k.victim === p.client && k.tS >= r.startS && k.tS <= end);
      const list = byClient.get(p.client);
      if (list) list.push({ round: r.n, roundIdx: i, start: r.startS,
                            end: death ? death.tS : end, death: death || null });
    }
  }
  return byClient;
}

/** Index into a track at a point in time (seconds); -1 if before it. */
function sampleAt(track, t){
  const ts = t * 100;
  let lo = 0, hi = track.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid][0] <= ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** Position of a player at a point in time, or null if not transmitted. */
function posAt(track, t, staleS){
  if (!track) return null;
  const i = sampleAt(track, t);
  if (i < 0) return null;
  const p = track[i];
  if (staleS && t - p[0] / 100 > staleS) return null;
  return p;
}

/* ---- routes and patterns ---- */

const ROUTE_S = 10;        // this many seconds after the spawn count as the opening
const ROUTE_N = 12;        // every route is resampled down to this many points
const ROUTE_T = 700;       // from this mean deviation on it counts as a different route

/** Resample a route onto fixed support points, so two become comparable. */
function resampleRoute(track, t0, t1, n){
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + (t1 - t0) * (i / (n - 1));
    const p = posAt(track, t, 3);
    if (!p) return null;
    out.push([p[1], p[2]]);
  }
  return out;
}

/** Mean distance between two routes across all support points. */
function routeDist(a, b){
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
  return s / a.length;
}

/** Group routes: the first of a group is its representative. */
function clusterRoutes(routes){
  const groups = [];
  for (const r of routes) {
    let best = null, bestD = Infinity;
    for (const g of groups) {
      const dist = routeDist(r.pts, g.rep);
      if (dist < bestD) { bestD = dist; best = g; }
    }
    if (best && bestD <= ROUTE_T) { best.members.push(r); best.dists.push(bestD); }
    else groups.push({ rep: r.pts, members: [r], dists: [0] });
  }
  groups.sort((a, b) => b.members.length - a.members.length);
  return groups;
}

const median = a => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Analysis of one player: opening routes, hotspots, deaths, distances, and a
 * measure of predictability derived from them.
 */
function analysePlayer(res, client, lives, weapons){
  const track = res.map.tracks[String(client)];
  const out = { lives: lives.length, runs: 0, routes: [], hotspots: [], deaths: [],
                killers: [], distances: [], killsSeen: 0, killsTotal: 0,
                score: null, why: "" };
  if (!track) return out;

  // --- opening routes ---
  const routes = [];
  for (const L of lives) {
    const t1 = Math.min(L.start + ROUTE_S, L.end);
    if (t1 - L.start < 3) continue;                  // died too early
    const pts = resampleRoute(track, L.start, t1, ROUTE_N);
    if (pts) routes.push({ life: L, pts });
  }
  const groups = clusterRoutes(routes);
  out.runs = routes.length;
  out.routes = groups.slice(0, 3).map(g => ({
    n: g.members.length, share: g.members.length / routes.length,
    spread: Math.round(median(g.dists.filter(d => d > 0))),
    rounds: g.members.map(m => m.life.round),
    pts: g.rep
  }));

  // --- hotspots: where does he linger ---
  const HS = 160;
  const cells = new Map();
  for (const p of track) {
    const k = ((p[1] / HS) | 0) + ":" + ((p[2] / HS) | 0);
    let c = cells.get(k);
    if (!c) { c = { n: 0, x: 0, y: 0 }; cells.set(k, c); }
    c.n++; c.x += p[1]; c.y += p[2];
  }
  out.hotspots = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 30)
    .map(c => ({ x: Math.round(c.x / c.n), y: Math.round(c.y / c.n),
                 secs: Math.round(c.n * 0.05), share: c.n / track.length }));

  // --- deaths: where and by whom ---
  const deaths = res.kills.filter(k => k.victim === client && !k.suicide);
  const dcells = new Map();
  for (const k of deaths) {
    const p = posAt(track, k.tS, 3);
    if (!p) continue;
    const key = ((p[1] / 300) | 0) + ":" + ((p[2] / 300) | 0);
    let c = dcells.get(key);
    if (!c) { c = { n: 0, x: 0, y: 0, by: new Map() }; dcells.set(key, c); }
    c.n++; c.x += p[1]; c.y += p[2];
    c.by.set(k.weaponLabel, (c.by.get(k.weaponLabel) || 0) + 1);
  }
  out.deaths = [...dcells.values()].sort((a, b) => b.n - a.n).slice(0, 3)
    .map(c => ({ x: Math.round(c.x / c.n), y: Math.round(c.y / c.n), n: c.n,
                 weapon: [...c.by.entries()].sort((a, b) => b[1] - a[1])[0][0] }));
  const byKiller = new Map();
  for (const k of deaths) byKiller.set(k.killer, (byKiller.get(k.killer) || 0) + 1);
  out.killers = [...byKiller.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([c, n]) => ({ client: c, n }));

  // --- distance per weapon on his own kills ---
  const perW = new Map();
  for (const k of res.kills) {
    if (k.killer !== client || k.suicide) continue;
    out.killsTotal++;
    const a = posAt(track, k.tS, 3);
    const b = posAt(res.map.tracks[String(k.victim)], k.tS, 3);
    if (!a || !b) continue;
    out.killsSeen++;
    const d = Math.hypot(a[1] - b[1], a[2] - b[2], a[3] - b[3]);
    if (!perW.has(k.weaponLabel)) perW.set(k.weaponLabel, []);
    perW.get(k.weaponLabel).push(d);
  }
  out.distances = [...perW.entries()].map(([w, ds]) => ({
    weapon: w, n: ds.length, median: Math.round(median(ds)),
    min: Math.round(Math.min(...ds)), max: Math.round(Math.max(...ds))
  })).sort((a, b) => b.n - a.n);

  // --- predictability ---
  if (routes.length < 3) {
    out.why = "too few opening runs recorded to judge (" + routes.length + ")";
  } else {
    const top = groups[0];
    const share = top.members.length / routes.length;
    const spread = median(top.dists.filter(d => d > 0));
    const tight = Math.max(0, Math.min(1, 1 - spread / ROUTE_T));
    out.score = Math.round(100 * (0.7 * share + 0.3 * tight));
    out.why = top.members.length + " of " + routes.length + " opening runs took the same route"
            + (spread ? ", deviating by " + Math.round(spread) + " units on average" : "")
            + " (" + groups.length + " distinct route" + (groups.length === 1 ? "" : "s") + ")";
  }
  return out;
}

/**
 * Map view: floor plan, every player on it, playable along a timeline.
 */
function mapPanel(res){
  const sec = el("section", "panel");
  const head = el("div", "phead");
  const m = res.map || {};
  const tracks = m.tracks || {};
  const weapons = m.weapons || [];
  const clients = Object.keys(tracks).map(Number).sort((a, b) => a - b);
  const total = clients.reduce((a, c) => a + tracks[String(c)].length, 0);

  head.append(el("h2", null, "Map"));
  if (!clients.length || !m.bounds || m.bounds.length !== 4) {
    head.append(el("span", "dim", "no position data"));
    sec.append(head, el("p", "dim",
      "This demo carries no player positions - it was parsed without snapshot decoding."));
    return sec;
  }
  const nadeCount = (m.grenades || []).length;
  head.append(el("span", "dim", res.info.map + " \u00b7 " + clients.length + " players \u00b7 " +
                                total.toLocaleString("en-US") + " positions" +
                                (nadeCount ? " \u00b7 " + nadeCount + " grenades" : "")));
  sec.append(head);

  // t1 is the impact, not the end of the transmitted path: for smokes the
  // transmission usually stops at the throw already, so the impact lies further
  // ahead, predicted.
  const nades = (m.grenades || []).map(g => ({
    kind: NADE[g.kind] ? g.kind : "other",
    weapon: g.weapon,
    t0: g.path[0][0] / 100,
    tLast: g.path[g.path.length - 1][0] / 100,
    t1: (g.impactS != null ? g.impactS : g.path[g.path.length - 1][0]) / 100,
    impact: g.impact || g.path[g.path.length - 1].slice(1),
    predicted: !!g.predicted,
    path: g.path
  }));
  const meta = new Map(res.players.map(p => [p.client, p]));
  const lives = buildLives(res);
  /** Is the player alive at this point in time?
   *
   * In Search & Destroy a life ends with the death from the kill feed. Whoever
   * is dead disappears from the map; whoever is alive stays put, even while the
   * server is not sending him. Outside any round (warmup, round break) there
   * are no lives - there everyone is shown. */
  function lifeAt(client, t){
    const list = lives.get(client);
    if (!list) return null;
    return list.find(L => t >= L.start && t <= L.end) || null;
  }
  function isAlive(client, t){
    if (lifeAt(client, t)) return true;
    return !res.rounds.some(r => t >= r.startS && t <= r.startS + r.durS);
  }
  /** Last known position - but only from the life currently running.
   *
   * Without that limit a player the server never sent during this round would
   * show up at his spot from an earlier round. Where he really stands is then
   * simply unknown. */
  function shownPos(client, t){
    const p = posAt(tracks[String(client)], t, 0);
    if (!p || !isAlive(client, t)) return null;
    const L = lifeAt(client, t);
    if (L && p[0] / 100 < L.start) return null;
    return p;
  }
  const analysis = new Map();          // client -> analysis, computed on demand
  let selected = null;

  /* ---- control bar ---- */
  const bar = el("div", "mapbar");
  const roundSel = el("select", "msel");
  roundSel.append(new Option("Whole match", "-1"));
  res.rounds.forEach((r, i) => roundSel.append(
    new Option("Round " + r.n + "  \u00b7  " + r.winner, String(i))));
  const playBtn = el("button", "btn ghost", "Play");
  playBtn.type = "button";
  const speedSel = el("select", "msel");
  [["0.5", "0.5\u00d7"], ["1", "1\u00d7"], ["2", "2\u00d7"], ["4", "4\u00d7"]]
    .forEach(([v, t]) => speedSel.append(new Option(t, v)));
  speedSel.value = "2";
  const modeSel = el("select", "msel");
  [["trail", "Recent trail"], ["heatp", "Heatmap: player"], ["heatt", "Heatmap: team"],
   ["plain", "No overlay"]].forEach(([v, t]) => modeSel.append(new Option(t, v)));
  const slider = el("input", "mslider");
  slider.type = "range";
  slider.min = "0";
  slider.step = "0.05";
  const clock = el("span", "mclock mono", "0:00");
  const nadeBox = el("label", "mtoggle");
  const nadeCb = el("input");
  nadeCb.type = "checkbox";
  nadeCb.checked = true;
  nadeBox.append(nadeCb, document.createTextNode(" grenades"));
  const labelBtn = el("button", "btn ghost", "+ label");
  labelBtn.type = "button";
  labelBtn.title = "click the map to place a label";
  bar.append(roundSel, playBtn, speedSel, modeSel, slider, clock, nadeBox, labelBtn);
  sec.append(bar);

  /* ---- player picker ---- */
  const chips = el("div", "mchips");
  for (const c of clients) {
    const p = meta.get(c);
    const b = el("button", "mchip t" + (p ? teamIndex(res, p.team) : 0));
    b.type = "button";
    b.append(cod4(p ? p.name : "client " + c));
    b.addEventListener("click", () => select(selected === c ? null : c));
    chips.append(b);
  }
  sec.append(chips);

  const box = el("div", "mapbox");
  const cv = el("canvas", "mapcanvas");
  const overlay = el("div", "mapoverlay");
  box.append(cv, overlay);
  sec.append(box);

  const legend = el("div", "maplegend");
  res.teams.forEach((t, i) => {
    const s = el("span", "mkey t" + i);
    s.append(el("i"), document.createTextNode(strip(t.name)));
    legend.append(s);
  });
  for (const k of ["frag", "smoke", "flash"]) {
    if (!nades.some(g => g.kind === k)) continue;
    const sp = el("span", "mkey");
    const dot = el("i");
    dot.style.background = NADE[k].color;
    sp.append(dot, document.createTextNode(NADE[k].label));
    legend.append(sp);
  }
  const floorNote = el("span", "dim", FLOOR_NOTE_DERIVED);
  legend.append(floorNote);
  legend.append(el("span", "dim",
    "A hollow marker means the server stopped sending that player - " +
    "the position shown is the last one known.")); 
  if (nades.some(n => n.predicted)) {
    legend.append(el("span", "dim",
      "A dashed grenade circle is a computed impact point: the server stops " +
      "sending the grenade in flight, so the rest of the arc is extrapolated."));
  }
  sec.append(legend);

  const info = el("div", "mstats");
  sec.append(info);

  /* ---- projection world -> image ---- */
  const [bx0, by0, bx1, by1] = m.bounds;
  const minX = Math.min(bx0, bx1), maxX = Math.max(bx0, bx1);
  const minY = Math.min(by0, by1), maxY = Math.max(by0, by1);
  const worldW = maxX - minX || 1, worldH = maxY - minY || 1;
  let W = 0, H = 0, scale = 1, offX = 0, offY = 0, dpr = 1;
  const px = x => (x - minX) * scale + offX;
  const py = y => H - ((y - minY) * scale + offY);
  const wx = sx => (sx - offX) / scale + minX;
  const wy = sy => (H - sy - offY) / scale + minY;

  const floor = buildFloor(res.info.map + "@" + CELL, tracks, minX, minY, maxX, maxY);
  let callouts = loadCallouts(res.info.map);
  let placing = false;

  let bg = null, heat = null;
  // The map image is loaded once and then kept per map. Until it is there -
  // and if there is none - the floor plan from the positions stays.
  const imgName = mapImageName(res.info.map);
  let mapImg = MAP_IMAGES.get(imgName) || null;
  if (imgName && !MAP_IMAGES.has(imgName)) {
    const im = new Image();
    im.addEventListener("load", () => {
      MAP_IMAGES.set(imgName, im);
      mapImg = im;
      bg = buildFloorImage();
      floorNote.textContent = FLOOR_NOTE_IMAGE;
      draw();
    });
    im.addEventListener("error", () => MAP_IMAGES.set(imgName, null));
    im.src = MAP_IMAGE_DIR + imgName + ".png";
  }
  let colors = new Map();
  function themeColor(name){ return getComputedStyle(cv).getPropertyValue(name).trim(); }
  function colorOf(client){
    const p = meta.get(client);
    return themeColor(p && teamIndex(res, p.team) === 1 ? "--t2" : "--t1");
  }

  function layout(){
    const rect = box.getBoundingClientRect();
    // Height follows not just the aspect ratio but the window as well: a
    // square map would otherwise be as tall as it is wide and you would scroll
    // all the time. When the height is capped the width shrinks along with it,
    // otherwise empty strips would be left on the left and right.
    const ratio = Math.min(1.15, Math.max(0.6, worldH / worldW));
    const room = Math.max(320, Math.min(560, (window.innerHeight || 800) * 0.62));
    let cssW = Math.max(240, Math.floor(rect.width));
    let cssH = Math.round(cssW * ratio);
    if (cssH > room) { cssH = Math.round(room); cssW = Math.round(cssH / ratio); }
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.round(cssW * dpr);
    H = Math.round(cssH * dpr);
    cv.width = W;
    cv.height = H;
    cv.style.width = cssW + "px";
    cv.style.height = cssH + "px";
    scale = Math.min(W / worldW, H / worldH);
    offX = (W - worldW * scale) / 2;
    offY = (H - worldH * scale) / 2;
    colors = new Map(clients.map(c => [c, colorOf(c)]));
    bg = buildFloorImage();
    heat = null;
    drawCallouts();
  }

  /** Draw the floor plan once onto its own canvas. */
  function buildFloorImage(){
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const g = off.getContext("2d");
    if (mapImg) {
      // The compass image covers exactly the world rectangle from config
      // string 823, so it can be placed into it without any conversion.
      const ix = px(minX), iy = py(maxY);
      g.drawImage(mapImg, ix, iy, px(maxX) - ix, py(minY) - iy);
      // Pull it slightly towards the background: the floor plan should stay
      // readable but not compete with the player markers for attention.
      g.globalAlpha = 0.34;
      g.fillStyle = themeColor("--surface") || "#fff";
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
      return off;
    }
    const { cols, rows, walk } = floor;
    const s = CELL * scale;
    g.fillStyle = themeColor("--surface2") || "#ddd";
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!walk[y * cols + x]) continue;
        const sx = px(minX + x * CELL), sy = py(minY + (y + 1) * CELL);
        g.fillRect(Math.floor(sx), Math.floor(sy), Math.ceil(s) + 1, Math.ceil(s) + 1);
      }
    }
    // Walls: only the edges between walkable and not walkable.
    g.strokeStyle = themeColor("--ink2") || "#666";
    g.globalAlpha = 0.85;
    g.lineWidth = Math.max(1, dpr);
    g.beginPath();
    const at = (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows) ? 0 : walk[y * cols + x];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!walk[y * cols + x]) continue;
        const l = px(minX + x * CELL), r = px(minX + (x + 1) * CELL);
        const b = py(minY + y * CELL), t = py(minY + (y + 1) * CELL);
        if (!at(x - 1, y)) { g.moveTo(l, t); g.lineTo(l, b); }
        if (!at(x + 1, y)) { g.moveTo(r, t); g.lineTo(r, b); }
        if (!at(x, y - 1)) { g.moveTo(l, b); g.lineTo(r, b); }
        if (!at(x, y + 1)) { g.moveTo(l, t); g.lineTo(r, t); }
      }
    }
    g.stroke();
    g.globalAlpha = 1;
    return off;
  }

  /** Density image for the heatmap mode. */
  function buildHeatImage(){
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const g = off.getContext("2d");
    const { cols, rows } = floor;
    const mode = modeSel.value;
    const sets = [];
    if (mode === "heatt") {
      res.teams.forEach((t, i) => sets.push({
        color: themeColor(i === 1 ? "--t2" : "--t1"),
        ids: clients.filter(c => meta.get(c) && meta.get(c).team === t.name)
      }));
    } else {
      const ids = selected !== null ? [selected] : clients;
      sets.push({ color: selected !== null ? colors.get(selected) : themeColor("--accent"), ids });
    }
    const s = CELL * scale;
    for (const set of sets) {
      const grid = new Uint32Array(cols * rows);
      let peak = 0;
      for (const c of set.ids) {
        const tr = tracks[String(c)];
        if (!tr) continue;
        for (const p of tr) {
          const cx = ((p[1] - minX) / CELL) | 0, cy = ((p[2] - minY) / CELL) | 0;
          if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
          const v = ++grid[cy * cols + cx];
          if (v > peak) peak = v;
        }
      }
      if (!peak) continue;
      g.fillStyle = set.color;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const v = grid[y * cols + x];
          if (!v) continue;
          // Square root instead of linear: otherwise the spawn swallows everything else.
          g.globalAlpha = Math.min(0.85, Math.sqrt(v / peak) * 0.85);
          const sx = px(minX + x * CELL), sy = py(minY + (y + 1) * CELL);
          g.fillRect(Math.floor(sx), Math.floor(sy), Math.ceil(s) + 1, Math.ceil(s) + 1);
        }
      }
    }
    g.globalAlpha = 1;
    return off;
  }

  /* ---- callouts ---- */
  function drawCallouts(){
    overlay.textContent = "";
    callouts.forEach((c, i) => {
      const n = el("div", "mcallout");
      const txt = el("span", "mctext", c.text);
      txt.contentEditable = "true";
      txt.spellcheck = false;
      txt.addEventListener("blur", () => {
        callouts[i].text = txt.textContent.trim() || "label";
        txt.textContent = callouts[i].text;
        saveCallouts(res.info.map, callouts);
      });
      txt.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); txt.blur(); } });
      const del = el("button", "mcdel", "\u00d7");
      del.type = "button";
      del.title = "remove label";
      del.addEventListener("click", () => {
        callouts.splice(i, 1);
        saveCallouts(res.info.map, callouts);
        drawCallouts();
      });
      n.append(txt, del);
      n.style.left = (px(c.x) / dpr) + "px";
      n.style.top = (py(c.y) / dpr) + "px";
      // Dragging: the handle is the label itself, as long as it is not being edited.
      n.addEventListener("pointerdown", e => {
        if (e.target === txt && document.activeElement === txt) return;
        if (e.target === del) return;
        e.preventDefault();
        const rect = box.getBoundingClientRect();
        const move = ev => {
          const sx = (ev.clientX - rect.left) * dpr, sy = (ev.clientY - rect.top) * dpr;
          callouts[i].x = Math.round(wx(sx));
          callouts[i].y = Math.round(wy(sy));
          n.style.left = (sx / dpr) + "px";
          n.style.top = (sy / dpr) + "px";
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          saveCallouts(res.info.map, callouts);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
      overlay.append(n);
    });
  }

  cv.addEventListener("click", e => {
    const rect = cv.getBoundingClientRect();
    const sx = (e.clientX - rect.left) * dpr, sy = (e.clientY - rect.top) * dpr;
    if (placing) {
      callouts.push({ x: Math.round(wx(sx)), y: Math.round(wy(sy)), text: "label" });
      saveCallouts(res.info.map, callouts);
      placing = false;
      labelBtn.classList.remove("on");
      cv.classList.remove("placing");
      drawCallouts();
      const last = overlay.lastChild;
      if (last) {
        const t = last.querySelector(".mctext");
        if (t) { t.focus(); document.getSelection().selectAllChildren(t); }
      }
      return;
    }
    // Otherwise: select the nearest player.
    let best = null, bestD = 22 * dpr;
    for (const c of clients) {
      const p = shownPos(c, now);
      if (!p) continue;
      const d = Math.hypot(px(p[1]) - sx, py(p[2]) - sy);
      if (d < bestD) { bestD = d; best = c; }
    }
    select(best === selected ? null : best);
  });
  labelBtn.addEventListener("click", () => {
    placing = !placing;
    labelBtn.classList.toggle("on", placing);
    cv.classList.toggle("placing", placing);
  });

  /* ---- timeline ---- */
  let t0 = 0, t1 = 0, now = 0, playing = false, raf = 0, last = 0;
  const TRAIL_S = 5;        // "recent trail": this far back
  const STALE_S = 1.5;      // after this a player counts as no longer transmitted

  function setRange(){
    const i = Number(roundSel.value);
    if (i < 0) { t0 = 0; t1 = res.info.durationS; }
    else { const r = res.rounds[i]; t0 = r.startS; t1 = r.startS + r.durS; }
    slider.min = String(t0);
    slider.max = String(t1);
    now = t0;
    slider.value = String(now);
    draw();
  }

  function weaponOf(p){
    const id = p[5];
    return (id > 0 && id <= weapons.length) ? weapons[id - 1] : "";
  }

  function draw(){
    const g = cv.getContext("2d");
    g.clearRect(0, 0, W, H);
    if (bg) g.drawImage(bg, 0, 0);
    if (modeSel.value === "heatp" || modeSel.value === "heatt") {
      if (!heat) heat = buildHeatImage();
      g.drawImage(heat, 0, 0);
    }

    const ink = themeColor("--ink");
    const faded = selected !== null;

    for (const c of clients) {
      const track = tracks[String(c)];
      const p = shownPos(c, now);
      if (!p) continue;
      const stale = now - p[0] / 100 > STALE_S;
      const isSel = selected === c;
      const col = colors.get(c) || "#888";
      const dim = faded && !isSel;
      g.globalAlpha = dim ? 0.28 : 1;

      if (modeSel.value === "trail" && !dim) {
        const i = sampleAt(track, now);
        g.strokeStyle = col;
        g.globalAlpha = 0.55;
        g.lineWidth = Math.max(1, (isSel ? 2.4 : 1.5) * dpr);
        g.beginPath();
        let started = false;
        for (let k = i; k >= 0 && now - track[k][0] / 100 <= TRAIL_S; k--) {
          const q = track[k];
          if (!started) { g.moveTo(px(q[1]), py(q[2])); started = true; }
          else g.lineTo(px(q[1]), py(q[2]));
        }
        g.stroke();
        g.globalAlpha = 1;
      }

      const x = px(p[1]), y = py(p[2]);
      const a = -p[4] * Math.PI / 180;
      const bgc = themeColor("--bg") || "#fff";
      const r = (isSel ? 6.5 : 5.2) * dpr;
      const tip = 15 * dpr;
      // Every marker gets an outline in the background colour first. That way
      // it stands out even where the floor plan happens to share its brightness.
      g.lineCap = "round";
      g.strokeStyle = bgc;
      g.lineWidth = Math.max(2, 4.5 * dpr);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * tip, y + Math.sin(a) * tip);
      g.stroke();
      g.strokeStyle = col;
      g.lineWidth = Math.max(1.5, 2.2 * dpr);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * tip, y + Math.sin(a) * tip);
      g.stroke();
      g.beginPath();
      g.arc(x, y, r, 0, 6.2832);
      if (stale) {
        // Hollow: the last known spot, not the current one.
        g.fillStyle = bgc;
        g.fill();
        g.strokeStyle = col;
        g.lineWidth = Math.max(1.5, 2.4 * dpr);
        g.stroke();
      } else {
        g.fillStyle = col;
        g.fill();
        g.strokeStyle = bgc;
        g.lineWidth = Math.max(1, 1.8 * dpr);
        g.stroke();
      }
      if (isSel) {
        g.strokeStyle = ink;
        g.lineWidth = Math.max(1, 1.5 * dpr);
        g.beginPath();
        g.arc(x, y, 9 * dpr, 0, 6.2832);
        g.stroke();
      }
      const pl = meta.get(c);
      if (pl && !dim) {
        const w = weaponOf(p);
        g.font = (10 * dpr) + "px ui-monospace, monospace";
        g.fillStyle = ink;
        g.globalAlpha = 0.85;
        // Flip to the left at the right edge, or the name runs off the image.
        const label = strip(pl.name) + (w ? "  " + w : "");
        const tw = g.measureText(label).width;
        const lx = x + 10 * dpr + tw > W ? x - 10 * dpr - tw : x + 10 * dpr;
        const ly = y - 8 * dpr;
        // A plate behind it, or the name disappears into the map's structures.
        g.globalAlpha = dim ? 0.2 : 0.7;
        g.fillStyle = themeColor("--bg") || "#fff";
        g.fillRect(lx - 2 * dpr, ly - 9 * dpr, tw + 4 * dpr, 12 * dpr);
        g.globalAlpha = dim ? 0.3 : 1;
        g.fillStyle = ink;
        g.fillText(label, lx, ly);
      }
      g.globalAlpha = 1;
    }

    if (nadeCb.checked) drawNades(g);
    drawKills(g, ink);
    if (selected !== null) drawSelectedExtras(g, ink);
    clock.textContent = mmss(now - t0) + " / " + mmss(t1 - t0);
  }

  /** Kills of the last few seconds: line from killer to victim, X on the victim. */
  function drawKills(g, ink){
    for (const k of res.kills) {
      const age = now - k.tS;
      if (age < 0 || age > 4) continue;
      if (selected !== null && k.killer !== selected && k.victim !== selected) continue;
      const vp = posAt(tracks[String(k.victim)], k.tS, 3);
      if (!vp) continue;
      const x = px(vp[1]), y = py(vp[2]);
      g.globalAlpha = Math.max(0, 1 - age / 4);
      if (!k.suicide) {
        const kp = posAt(tracks[String(k.killer)], k.tS, 3);
        if (kp) {
          g.strokeStyle = colors.get(k.killer) || ink;
          g.lineWidth = Math.max(1, 1.6 * dpr);
          g.setLineDash([5 * dpr, 4 * dpr]);
          g.beginPath();
          g.moveTo(px(kp[1]), py(kp[2]));
          g.lineTo(x, y);
          g.stroke();
          g.setLineDash([]);
          const mx = (px(kp[1]) + x) / 2, my = (py(kp[2]) + y) / 2;
          g.font = (10 * dpr) + "px ui-monospace, monospace";
          g.fillStyle = ink;
          g.fillText(k.weaponLabel, mx + 4 * dpr, my - 4 * dpr);
        }
      }
      g.strokeStyle = ink;
      g.lineWidth = Math.max(1, 2 * dpr);
      const r = 6 * dpr;
      g.beginPath();
      g.moveTo(x - r, y - r); g.lineTo(x + r, y + r);
      g.moveTo(x + r, y - r); g.lineTo(x - r, y + r);
      g.stroke();
      g.globalAlpha = 1;
    }
  }

  /** For the selected player: show the opening route and the places he dies. */
  function drawSelectedExtras(g, ink){
    const a = analysis.get(selected);
    if (!a) return;
    const col = colors.get(selected) || ink;
    if (a.routes.length) {
      const r = a.routes[0];
      g.strokeStyle = col;
      g.globalAlpha = 0.5;
      g.lineWidth = Math.max(1, 3 * dpr);
      g.setLineDash([2 * dpr, 6 * dpr]);
      g.beginPath();
      r.pts.forEach((q, i) => i ? g.lineTo(px(q[0]), py(q[1])) : g.moveTo(px(q[0]), py(q[1])));
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }
    for (const d of a.deaths) {
      g.strokeStyle = ink;
      g.globalAlpha = 0.45;
      g.lineWidth = Math.max(1, 1.2 * dpr);
      g.beginPath();
      g.arc(px(d.x), py(d.y), 12 * dpr, 0, 6.2832);
      g.stroke();
      g.globalAlpha = 1;
    }
  }

  /** Throws: the flight path while in the air, then a marker at the impact. */
  function drawNades(g){
    for (const n of nades) {
      if (now < n.t0) continue;
      const end = n.impact;
      const style = NADE[n.kind];
      if (now <= n.t1) {
        // While in the air only the path, no marker: the line shows where the
        // throw is going. The circle comes when the grenade goes off.
        g.globalAlpha = 0.95;
        g.setLineDash([4 * dpr, 3 * dpr]);
        g.beginPath();
        let drawn = false, prev = null;
        for (const q of n.path) {
          if (q[0] / 100 > now) break;
          const x = px(q[1]), y = py(q[2]);
          if (!drawn) { g.moveTo(x, y); drawn = true; } else g.lineTo(x, y);
          prev = q;
        }
        // Extend to the current spot. Without that the line would stay
        // invisible while only one point exists - and the server often sends a
        // flight path with just two or three points, for smokes with one.
        const nxt = n.path.find(q => q[0] / 100 > now);
        const tgt = nxt ? [nxt[0] / 100, nxt[1], nxt[2]]
                        : (prev && n.t1 > prev[0] / 100 ? [n.t1, end[0], end[1]] : null);
        if (prev && tgt) {
          const span = tgt[0] - prev[0] / 100;
          const f = span > 0 ? Math.min(1, (now - prev[0] / 100) / span) : 0;
          g.lineTo(px(prev[1] + (tgt[1] - prev[1]) * f),
                   py(prev[2] + (tgt[2] - prev[2]) * f));
        }
        // Stroke it twice: first wide in the background colour, then in the
        // marker colour. A neutral grey would otherwise sink into the plan.
        g.strokeStyle = themeColor("--bg") || "#fff";
        g.lineWidth = Math.max(3, 4.4 * dpr);
        g.stroke();
        g.strokeStyle = style.color;
        g.lineWidth = Math.max(1.5, 2.2 * dpr);
        g.stroke();
        g.setLineDash([]);
        g.globalAlpha = 1;
        continue;
      }
      const age = now - n.t1;
      if (age > style.hold) continue;
      const x = px(end[0]), y = py(end[1]);
      g.globalAlpha = Math.max(0, 1 - age / style.hold);
      g.strokeStyle = style.color;
      g.fillStyle = style.color;
      g.beginPath();
      g.arc(x, y, style.r * dpr, 0, 6.2832);
      g.globalAlpha *= 0.45;
      g.fill();
      g.globalAlpha /= 0.45;
      // Dashed when the spot is computed rather than transmitted.
      if (n.predicted) g.setLineDash([5 * dpr, 4 * dpr]);
      g.strokeStyle = themeColor("--bg") || "#fff";
      g.lineWidth = Math.max(3, 4.6 * dpr);
      g.stroke();
      g.strokeStyle = style.color;
      g.lineWidth = Math.max(1.5, 2.4 * dpr);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }
  }

  /* ---- selection and analysis ---- */
  function select(client){
    selected = client;
    [...chips.children].forEach((b, i) =>
      b.classList.toggle("on", clients[i] === selected));
    heat = null;
    renderStats();
    draw();
  }

  function renderStats(){
    info.textContent = "";
    if (selected === null) {
      info.append(el("p", "dim",
        "Click a player - on the map or in the list above - for their routes, hotspots and patterns."));
      return;
    }
    if (!analysis.has(selected))
      analysis.set(selected, analysePlayer(res, selected, lives.get(selected) || [], weapons));
    const a = analysis.get(selected);
    const p = meta.get(selected);

    const h = el("div", "mstathead");
    const nm = el("span", "mstatname");
    nm.append(cod4(p ? p.name : "client " + selected));
    h.append(nm);
    if (a.score !== null) {
      const sc = el("span", "mscore");
      sc.append(el("b", null, String(a.score)), document.createTextNode("/100 predictable"));
      h.append(sc);
    }
    h.append(el("span", "dim", a.why));
    info.append(h);

    const grid = el("div", "mstatgrid");
    const card = (title, rows, empty) => {
      const d = el("div", "mcard");
      d.append(el("h4", null, title));
      if (!rows.length) { d.append(el("p", "dim", empty)); return d; }
      const ul = el("ul");
      for (const r of rows) ul.append(el("li", null, r));
      d.append(ul);
      return d;
    };

    grid.append(card("Opening routes (first " + ROUTE_S + "s of each life)",
      a.routes.map(r => Math.round(r.share * 100) + "% \u00b7 " + r.n + " of " + a.runs +
        " runs \u00b7 rounds " + r.rounds.slice(0, 8).join(", ") +
        (r.rounds.length > 8 ? " \u2026" : "")),
      "no opening runs recorded"));

    // Neighbouring cells often carry the same callout - those belong together,
    // otherwise the same place shows up five times in the list.
    const spots = new Map();
    for (const hs of a.hotspots) {
      const key = nearestCallout(hs.x, hs.y);
      const cur = spots.get(key) || { secs: 0, share: 0 };
      cur.secs += hs.secs;
      cur.share += hs.share;
      spots.set(key, cur);
    }
    grid.append(card("Hotspots (where he lingers)",
      [...spots.entries()].sort((x, y) => y[1].secs - x[1].secs).slice(0, 5)
        .map(([name, v]) => v.secs + "s \u00b7 " + Math.round(v.share * 100) +
             "% of his time \u00b7 " + name),
      "no positions"));

    grid.append(card("Dies most here",
      a.deaths.map(d => d.n + "\u00d7 \u00b7 " + nearestCallout(d.x, d.y) + " \u00b7 mostly " + d.weapon)
        .concat(a.killers.map(k => "killed " + k.n + "\u00d7 by " +
          strip((meta.get(k.client) || {}).name || ("client " + k.client)))),
      "never died"));

    grid.append(card("Engagement distance per weapon",
      a.distances.map(d => d.weapon + ": median " + d.median + " units \u00b7 " +
        d.min + "\u2013" + d.max + " \u00b7 " + d.n + " kill" + (d.n === 1 ? "" : "s"))
        .concat(a.killsTotal > a.killsSeen
          ? ["(" + (a.killsTotal - a.killsSeen) + " of " + a.killsTotal +
             " kills had no position for both sides)"] : []),
      a.killsTotal ? "none of his " + a.killsTotal + " kills had a position for both sides"
                   : "no kills"));

    info.append(grid);
    info.append(el("p", "dim",
      "Predictability = 70% how often the most common opening route repeats, " +
      "30% how tightly those runs overlap. Routes count as the same below " +
      ROUTE_T + " units of average deviation."));
  }

  /** The nearest callout of your own, otherwise the coordinate. */
  function nearestCallout(x, y){
    let best = null, bestD = 700;
    for (const c of callouts) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best ? best.text : "(" + x + ", " + y + ")";
  }

  /* ---- playback ---- */
  function frame(ts){
    if (!playing) return;
    const dt = last ? (ts - last) / 1000 : 0;
    last = ts;
    now += dt * Number(speedSel.value);
    if (now >= t1) { now = t1; stop(); }
    slider.value = String(now);
    draw();
    if (playing) raf = requestAnimationFrame(frame);
  }
  function start(){
    if (now >= t1) now = t0;
    playing = true;
    playBtn.textContent = "Pause";
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop(){
    playing = false;
    playBtn.textContent = "Play";
    cancelAnimationFrame(raf);
  }

  playBtn.addEventListener("click", () => playing ? stop() : start());
  speedSel.addEventListener("change", () => { last = 0; });
  modeSel.addEventListener("change", () => { heat = null; draw(); });
  roundSel.addEventListener("change", () => { stop(); setRange(); });
  slider.addEventListener("input", () => { stop(); now = Number(slider.value); draw(); });
  nadeCb.addEventListener("change", draw);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { layout(); draw(); });
    ro.observe(box);
  }
  setTimeout(() => { layout(); renderStats(); setRange(); }, 0);
  return sec;
}


})();
