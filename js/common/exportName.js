/* File names for exports: YYYYMMDD_TeamA_vs_TeamB_map.json
 * (e.g. 20260924_infinity_vs_TeamXY_crash.json). Shared by every export that
 * should follow this scheme. DOM-free. */
C4.define('exportName', function (C4) {
  'use strict';
  const { stripColors } = C4.text;
  const UNKNOWN = 'unknown';

  /** one part of a file name: no colour codes, brackets or special characters (so also none of
   * \ / : * ? " < > |), spaces and "_" -> "-" ("_" is reserved as separator: mp_backlot_x ->
   * backlot-x); letters of any script, digits and "-" stay. Empty -> "unknown". */
  function fileNamePart(text, maxLength = 40) {
    const s = stripColors(text)
      .normalize('NFC')
      .replace(/[\s_]+/g, '-')
      .replace(/[^\p{L}\p{N}-]/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength)
      .replace(/-+$/, '');
    return s || UNKNOWN;
  }

  /**
   * data: DemoData. opts.suffix: optional extra part before the extension (e.g. "full"),
   * opts.ext: extension without dot (default "json").
   * - date: record date of the demo (map start time on the server), else the file date - the
   *   date the quick overview shows; "unknown" if there is none
   * - teams: team names as in the scoreboard (the clan tag when one was found, otherwise
   *   "Team A" / "Team B"), upper team first
   * - map: map name without "mp_", lower case
   */
  function buildExportFileName(data, opts = {}) {
    const m = data.meta || {};
    const stamp = m.recordDate && m.recordDate.stamp;
    const date = /^\d{8}/.test(stamp || '') ? stamp.slice(0, 8) : UNKNOWN;
    // teams in scoreboard order (only teams with players are shown there)
    const shown = (data.teams || []).filter(t => (data.players || []).some(p => p.team === t.key));
    const teamA = fileNamePart(shown[0] ? shown[0].name : '');
    const teamB = fileNamePart(shown[1] ? shown[1].name : '');
    const map = fileNamePart(String(m.map || '').toLowerCase().replace(/^mp_/, ''));
    const parts = [date, teamA, 'vs', teamB, map];
    if (opts.suffix) parts.push(fileNamePart(opts.suffix));
    return parts.join('_') + '.' + (opts.ext || 'json');
  }

  C4.exportName = { buildExportFileName, fileNamePart };
});
