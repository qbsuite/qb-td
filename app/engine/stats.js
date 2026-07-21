// stats.js — standings + individual leaderboard from parsed matches
// (qbj.js parseMatch output) and an optional roster (parseRoster output).
//
// The aggregation is the standard tossup/bonus model YellowFruit and SQBS
// compute: team W/L/T, points for/against, tossups heard, per-value buzz
// counts, bonuses heard (= positive buzzes), PPB, PP20TUH.

function round2(x) {
  return Math.round(x * 100) / 100;
}

// A re-uploaded game (a mod re-exporting after a fix, or two mods covering
// the same room) must not double-count: keep only the latest upload per
// (round, team pair). "Latest" = higher fileId when both carry one (file
// ids are upload-ordered), else the later entry in input order. Exported
// so the .yft path applies the same rule; aggregate() applies it itself.
export function dedupeMatches(matches) {
  const byGame = new Map();
  for (const m of matches) {
    const key = m.round + '\n' + m.teams.map((t) => t.name).sort().join('\n');
    const prev = byGame.get(key);
    const older = prev && Number.isFinite(prev.fileId) && Number.isFinite(m.fileId)
      && m.fileId < prev.fileId;
    if (!older) byGame.set(key, m);
  }
  return [...byGame.values()];
}

/**
 * @param matches parsed matches; each may carry extra metadata (e.g.
 *   `room`, `fileId`) which is passed through to the per-round game list.
 * @param roster optional [{name, players}] — seeds team/player order and
 *   flags unrostered names.
 * @returns {values, teams, players, games, errors}
 */
export function aggregate(matches, roster = null) {
  matches = dedupeMatches(matches);
  const teams = new Map();   // name -> team row
  const players = new Map(); // team + '\n' + name -> player row
  const valueSet = new Set();

  const teamRow = (name) => {
    let t = teams.get(name);
    if (!t) {
      t = {
        name, gp: 0, w: 0, l: 0, t: 0,
        points: 0, pointsAgainst: 0, tuh: 0,
        counts: {}, bonusesHeard: 0, bonusPoints: 0,
        rostered: !roster,
      };
      teams.set(name, t);
    }
    return t;
  };
  const playerRow = (team, name) => {
    const key = team + '\n' + name;
    let p = players.get(key);
    if (!p) {
      p = { name, team, gp: 0, tuh: 0, counts: {}, points: 0, rostered: !roster };
      players.set(key, p);
    }
    return p;
  };

  if (roster) {
    for (const r of roster) {
      teamRow(r.name).rostered = true;
      for (const pn of r.players) playerRow(r.name, pn).rostered = true;
    }
  }

  const games = [];
  for (const m of matches) {
    const [a, b] = m.teams;
    const rows = [teamRow(a.name), teamRow(b.name)];
    const opp = [b, a];
    m.teams.forEach((mt, i) => {
      const row = rows[i];
      row.gp += 1;
      row.points += mt.points;
      row.pointsAgainst += opp[i].points;
      row.tuh += m.tossupsRead;
      row.bonusPoints += mt.bonusPoints;
      if (mt.points > opp[i].points) row.w += 1;
      else if (mt.points < opp[i].points) row.l += 1;
      else row.t += 1;

      for (const p of mt.players) {
        const pr = playerRow(mt.name, p.name);
        if (p.tossupsHeard > 0) {
          pr.gp += 1;
          pr.tuh += p.tossupsHeard;
        }
        for (const c of p.counts) {
          if (!c.n) continue;
          valueSet.add(c.value);
          pr.counts[c.value] = (pr.counts[c.value] || 0) + c.n;
          row.counts[c.value] = (row.counts[c.value] || 0) + c.n;
          pr.points += c.value * c.n;
          if (c.value > 0) row.bonusesHeard += c.n;
        }
      }
    });
    games.push({
      round: m.round,
      tossupsRead: m.tossupsRead,
      // full parsed teams (players, counts, bonus) so views can render a
      // per-game box score without going back to the raw qbj
      teams: m.teams,
      room: m.room, fileId: m.fileId, packets: m.packets, notes: m.notes,
    });
  }

  const values = [...valueSet].sort((x, y) => y - x);

  const teamList = [...teams.values()].map((t) => ({
    ...t,
    ppg: t.gp ? round2(t.points / t.gp) : 0,
    pp20tuh: t.tuh ? round2((t.points / t.tuh) * 20) : 0,
    ppb: t.bonusesHeard ? round2(t.bonusPoints / t.bonusesHeard) : 0,
  }));
  teamList.sort((x, y) =>
    (y.w - y.l) - (x.w - x.l) || y.pp20tuh - x.pp20tuh || x.name.localeCompare(y.name));

  const playerList = [...players.values()].map((p) => ({
    ...p,
    ppg: p.gp ? round2(p.points / p.gp) : 0,
    pp20tuh: p.tuh ? round2((p.points / p.tuh) * 20) : 0,
  }));
  playerList.sort((x, y) => y.pp20tuh - x.pp20tuh || x.name.localeCompare(y.name));

  games.sort((x, y) => x.round - y.round);

  return { values, teams: teamList, players: playerList, games };
}
