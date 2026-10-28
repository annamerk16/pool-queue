// Pool table queue API — one Vercel serverless function.
// GET  /api/queue            -> current state
// GET  /api/queue?view=stats -> permanent player records
// POST /api/queue {action..} -> perform an action, returns new state
//
// Storage: Upstash Redis via its REST API (added from Vercel's Storage tab).
// With no Redis env vars set, falls back to in-memory storage (local testing only).

const KEY = "poolqueue:state";
const LOCK = "poolqueue:lock";
const PLAYERS = "poolqueue:players"; // permanent records, never touched by "Clear everything"

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_CODE = process.env.ADMIN_CODE || "";

// ---------- storage ----------
const mem = new Map();

async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    // in-memory fallback
    const [op, key, val, ...rest] = cmd;
    if (op === "GET") return mem.has(key) ? mem.get(key) : null;
    if (op === "SET") {
      if (rest.includes("NX") && mem.has(key)) return null;
      mem.set(key, val);
      return "OK";
    }
    if (op === "DEL") { mem.delete(key); return 1; }
    if (op === "MGET") return [key, val, ...rest].map((k) => (mem.has(k) ? mem.get(k) : null));
    throw new Error("unsupported op " + op);
  }
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

const emptyState = () => ({ mode: "singles", table: [null, null], queue: [], log: [], lastGame: null, updatedAt: Date.now() });

// Each player keeps separate singles and doubles records.
const MODES = ["singles", "doubles"];
const blankRecord = () => ({ wins: 0, losses: 0, bestStreak: 0, form: "", vs: {}, partners: {} });

// Records saved before doubles existed kept singles stats at the top level; move them under "singles".
function upgrade(players) {
  for (const p of Object.values(players)) {
    if (!p.singles) {
      p.singles = { ...blankRecord(), wins: p.wins || 0, losses: p.losses || 0, bestStreak: p.bestStreak || 0, form: p.form || "", vs: p.vs || {} };
      for (const k of ["wins", "losses", "bestStreak", "form", "vs"]) delete p[k];
    }
    p.doubles ||= blankRecord();
  }
  return players;
}

async function load() {
  const [raw, rawPlayers] = await redis(["MGET", KEY, PLAYERS]);
  return { s: raw ? JSON.parse(raw) : emptyState(), players: upgrade(rawPlayers ? JSON.parse(rawPlayers) : {}) };
}
async function save(s) {
  s.updatedAt = Date.now();
  await redis(["SET", KEY, JSON.stringify(s)]);
}
async function savePlayers(players) {
  await redis(["SET", PLAYERS, JSON.stringify(players)]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simple lock so two taps at the same moment can't corrupt the queue.
async function withLock(fn) {
  for (let i = 0; i < 40; i++) {
    const ok = await redis(["SET", LOCK, "1", "NX", "PX", "5000"]);
    if (ok === "OK") {
      try { return await fn(); }
      finally { await redis(["DEL", LOCK]); }
    }
    await sleep(75);
  }
  throw new Error("Busy, try again");
}

// ---------- game logic ----------
const uid = () => Math.random().toString(36).slice(2, 10);
const clean = (n) => String(n || "").replace(/[<>]/g, "").trim().slice(0, 24);
// "Anna", "anna" and " ANNA " all map to the same record
const nameKey = (n) => clean(n).toLowerCase().replace(/\s+/g, " ");

// Look up (or create) the permanent record for a name. The latest spelling becomes the display name.
function register(players, name) {
  const key = nameKey(name);
  const rec = players[key] || (players[key] = { name, firstSeen: Date.now(), lastPlayed: null, singles: blankRecord(), doubles: blankRecord() });
  rec.name = name;
  return rec;
}

// A queue entry is one player (singles) or a team of two (doubles).
const namesOf = (p) => p.names || [p.name];
const modeOf = (p) => (namesOf(p).length > 1 ? "doubles" : "singles");

// vs[opponent] and partners[teammate] are [wins, losses]
function recordGame(players, winners, losers, streak) {
  const mode = winners.length > 1 ? "doubles" : "singles";
  const now = Date.now();
  const side = (team, opps, won) => {
    for (const n of team) {
      const rec = register(players, n), r = rec[mode], i = won ? 0 : 1;
      if (won) { r.wins++; r.bestStreak = Math.max(r.bestStreak, streak); } else r.losses++;
      r.form = ((won ? "W" : "L") + r.form).slice(0, 10); // newest first
      for (const o of opps) (r.vs[nameKey(o)] ||= [0, 0])[i]++;
      for (const m of team) if (m !== n) (r.partners[nameKey(m)] ||= [0, 0])[i]++;
      rec.lastPlayed = now;
    }
  };
  side(winners, losers, true);
  side(losers, winners, false);
}

// Why these names can't be added (or null if they can).
// Singles: a name can only be in line once. Doubles: one person can queue with several partners,
// but the exact same pair can't be in line twice. Singles and doubles entries don't clash with each other.
function conflict(s, names, exceptId) {
  const others = [...s.queue, ...s.table].filter((p) => p && p.id !== exceptId && namesOf(p).length === names.length);
  if (names.length === 1) {
    const key = nameKey(names[0]);
    return others.some((p) => namesOf(p).some((n) => nameKey(n) === key)) ? `${names[0]} is already in line` : null;
  }
  const pair = names.map(nameKey).sort().join("|");
  return others.some((p) => namesOf(p).map(nameKey).sort().join("|") === pair) ? `${names.join(" & ")} are already in line together` : null;
}

// Names for a queue entry: just one in singles, a pair in doubles.
function entryNames(s, body) {
  const name = clean(body.name);
  if (!name) throw new UserError("Enter a name");
  if (s.mode !== "doubles") return [name];
  const partner = clean(body.partner);
  if (!partner) throw new UserError("Enter a partner's name");
  if (nameKey(partner) === nameKey(name)) throw new UserError("Partner needs a different name");
  return [name, partner];
}

function newEntry(names, extra) {
  return { id: uid(), name: names.join(" & "), names, ...extra };
}

// Fill open seats from the front of the line. Only entries for the current mode can play; the others
// keep their place until the mode switches back. Anyone already on the table is skipped too
// (in doubles one person can be in line with more than one partner).
function fillTable(s) {
  const mode = s.mode || "singles";
  // a game from before a mode switch gets to finish; after that, whoever is left waits at the front of the line
  if (!(s.table[0] && s.table[1])) {
    for (let i = 1; i >= 0; i--) {
      const p = s.table[i];
      if (p && modeOf(p) !== mode) { const { streak, ...back } = p; s.queue.unshift(back); s.table[i] = null; }
    }
  }
  for (let i = 0; i < 2; i++) {
    if (s.table[i]) continue;
    const playing = new Set(s.table.filter(Boolean).flatMap(namesOf).map(nameKey));
    const j = s.queue.findIndex((p) => modeOf(p) === mode && !namesOf(p).some((n) => playing.has(nameKey(n))));
    if (j >= 0) s.table[i] = { ...s.queue.splice(j, 1)[0], streak: 0 };
  }
}

function findClient(s, clientId) {
  if (s.table.some((p) => p && p.clientId === clientId)) return "table";
  if (s.queue.some((p) => p.clientId === clientId)) return "queue";
  return null;
}

function findEntry(s, id) {
  const p = s.queue.find((p) => p.id === id) || s.table.find((p) => p && p.id === id);
  if (!p) throw new UserError("They're not in line anymore");
  return p;
}

// Recent activity: games plus edits, so everyone can see who changed what.
function note(s, text) {
  s.log.unshift({ id: uid(), kind: "note", text, at: Date.now() });
  s.log = s.log.slice(0, 25);
}

// A change to someone involved in the last game means it can no longer be undone cleanly.
function touch(s, id) {
  const g = s.lastGame;
  if (g && [g.winner.id, g.loser.id, g.requeuedId, ...g.steppedUp.map((u) => u.id)].includes(id)) s.lastGame = null;
}

const UNDO_MINUTES = 15;

class UserError extends Error {}

function apply(s, players, body) {
  const { action, clientId } = body;
  const isAdmin = ADMIN_CODE && body.adminCode === ADMIN_CODE;
  // who did it, for the activity list (honour system: it's the name saved on their phone)
  const mine = [...s.table, ...s.queue].find((p) => p && p.clientId === clientId);
  const by = clean(body.by) || (mine && namesOf(mine)[0]) || "Someone";

  switch (action) {
    case "join": {
      const names = entryNames(s, body);
      if (!clientId) throw new UserError("Missing device id");
      if (findClient(s, clientId)) throw new UserError("You're already in line or on the table");
      const why = conflict(s, names);
      if (why) throw new UserError(why);
      names.forEach((n) => register(players, n));
      s.queue.push(newEntry(names, { clientId, requeue: !!body.requeue }));
      fillTable(s);
      return;
    }

    case "leave": {
      for (const p of [...s.queue, ...s.table]) if (p && p.clientId === clientId) touch(s, p.id);
      s.queue = s.queue.filter((p) => p.clientId !== clientId);
      s.table = s.table.map((p) => (p && p.clientId === clientId ? null : p));
      fillTable(s);
      return;
    }

    case "setRequeue": {
      for (const p of [...s.queue, ...s.table]) if (p && p.clientId === clientId) p.requeue = !!body.requeue;
      return;
    }

    // Anyone can report a result. Mistakes are fixed with "undoWin".
    case "win": {
      const [a, b] = s.table;
      if (!a || !b) throw new UserError("Need two players on the table");
      const winner = s.table.find((p) => p.id === body.winnerId);
      if (!winner) throw new UserError("That player isn't on the table");
      const loser = winner === a ? b : a;
      const loserSeat = s.table.indexOf(loser);
      const involved = [...namesOf(winner), ...namesOf(loser)].map(nameKey);
      const game = {
        winner: { ...winner }, loser: { ...loser }, loserSeat,
        records: Object.fromEntries(involved.filter((k) => players[k]).map((k) => [k, JSON.parse(JSON.stringify(players[k]))])),
        logId: uid(), at: Date.now(),
      };

      winner.streak = (winner.streak || 0) + 1;
      recordGame(players, namesOf(winner), namesOf(loser), winner.streak);
      s.log.unshift({ id: game.logId, kind: "game", winner: winner.name, loser: loser.name, by, at: game.at });
      s.log = s.log.slice(0, 25);

      s.table[loserSeat] = null;
      if (loser.requeue && !conflict(s, namesOf(loser))) {
        const back = newEntry(namesOf(loser), { clientId: loser.clientId, requeue: true });
        s.queue.push(back);
        game.requeuedId = back.id;
      }
      const lineBefore = s.queue.map((p) => p.id).filter((id) => id !== game.requeuedId);
      // winner keeps their seat and the next in line steps up — unless the mode was switched during
      // this game, in which case the winner goes to the front of the line and the new mode takes the table
      fillTable(s);
      game.tableAfter = s.table.map((p) => (p ? p.id : null));
      game.steppedUp = s.table.filter((p) => p && p.id !== winner.id).map((p) => ({ id: p.id, index: lineBefore.indexOf(p.id) }));
      s.lastGame = game;
      return;
    }

    case "undoWin": {
      // put the table, line and records back exactly as they were before the last result
      const g = s.lastGame;
      if (!g || Date.now() - g.at > UNDO_MINUTES * 60000) throw new UserError("Nothing to undo");
      if (s.table.map((p) => (p ? p.id : null)).join() !== g.tableAfter.join())
        throw new UserError("Too much has changed to undo that");
      // take the requeued loser (and a winner sent to the front of the line) back out of the line,
      // and return whoever stepped up to their old spots
      const seated = s.table;
      s.queue = s.queue.filter((p) => p.id !== g.requeuedId && p.id !== g.winner.id);
      for (const { id, index } of [...g.steppedUp].sort((x, y) => x.index - y.index)) {
        if (id === g.requeuedId || index < 0) continue;
        const { streak, ...back } = seated.find((p) => p && p.id === id);
        s.queue.splice(Math.min(index, s.queue.length), 0, back);
      }
      s.table = [null, null];
      s.table[1 - g.loserSeat] = g.winner;
      s.table[g.loserSeat] = g.loser;
      Object.assign(players, g.records);
      s.log = s.log.filter((e) => e.id !== g.logId);
      note(s, `${by} undid “${g.winner.name} beat ${g.loser.name}”`);
      s.lastGame = null;
      return;
    }

    // ---- anyone can tidy up the line, so it works without an admin around ----
    case "addPlayer": {
      const names = entryNames(s, body);
      const why = conflict(s, names);
      if (why) throw new UserError(why);
      names.forEach((n) => register(players, n));
      // people added by someone else aren't tied to any phone
      const p = newEntry(names, { clientId: "added-" + uid(), requeue: body.requeue !== false, addedBy: by });
      if (body.front && isAdmin) s.queue.unshift(p); else s.queue.push(p);
      note(s, `${by} added ${p.name}`);
      fillTable(s);
      return;
    }

    case "editEntry": {
      // fix a name, swap a partner, or add/drop a partner to move between singles and doubles,
      // keeping their place in line
      const p = findEntry(s, body.playerId);
      const names = entryNames({ mode: clean(body.partner) ? "doubles" : "singles" }, body);
      const why = conflict(s, names, p.id);
      if (why) throw new UserError(why);
      const onTable = s.table.includes(p);
      if (onTable && names.length !== namesOf(p).length) throw new UserError("Finish this game before switching between singles and doubles");
      if (onTable) {
        const other = s.table.find((o) => o && o !== p);
        const clash = other && names.find((n) => namesOf(other).some((m) => nameKey(m) === nameKey(n)));
        if (clash) throw new UserError(`${clash} is on the other side of the table`);
      }
      if ("requeue" in body) p.requeue = !!body.requeue;
      const oldName = p.name;
      const newName = names.join(" & ");
      if (newName === oldName) return;
      names.forEach((n) => register(players, n));
      p.names = names; p.name = newName;
      if (onTable) p.streak = 0; // a different team starts a fresh streak
      touch(s, p.id);
      note(s, `${by} changed ${oldName} to ${newName}`);
      fillTable(s);
      return;
    }

    case "remove": {
      const p = findEntry(s, body.playerId);
      touch(s, p.id);
      s.queue = s.queue.filter((q) => q !== p);
      s.table = s.table.map((q) => (q === p ? null : q));
      if (p.clientId !== clientId) note(s, `${by} removed ${p.name}`);
      fillTable(s);
      return;
    }

    case "setMode": {
      // nobody loses their spot: a game in progress finishes first, and entries for the other mode
      // wait in line until it switches back
      const mode = body.mode === "doubles" ? "doubles" : "singles";
      if (mode === (s.mode || "singles")) return;
      const [a, b] = s.table;
      const finishing = a && b && modeOf(a) !== mode;
      s.mode = mode;
      fillTable(s);
      note(s, `${by} switched to ${mode}${finishing ? " (starts after this game)" : ""}`);
      return;
    }

    // ---- admin-only ----
    case "move": {
      if (!isAdmin) throw new UserError("Admin code required");
      const i = s.queue.findIndex((p) => p.id === body.playerId);
      if (i < 0) throw new UserError("Player not in line");
      const j = body.to === "front" ? 0 : i + (body.dir > 0 ? 1 : -1);
      if (j < 0 || j >= s.queue.length) return;
      const [p] = s.queue.splice(i, 1);
      s.queue.splice(j, 0, p);
      return;
    }

    case "reset": {
      if (!isAdmin) throw new UserError("Admin code required");
      Object.assign(s, emptyState(), { mode: s.mode });
      return;
    }

    // ---- admin record tools (stats page) ----
    case "deleteRecord": {
      if (!isAdmin) throw new UserError("Admin code required");
      if (!players[body.key]) throw new UserError("No such player");
      delete players[body.key];
      s.lastGame = null;
      for (const p of Object.values(players)) for (const m of MODES) { delete p[m].vs[body.key]; delete p[m].partners[body.key]; }
      return;
    }

    case "mergeRecord": {
      // fold a typo'd name (from) into the real one (into)
      if (!isAdmin) throw new UserError("Admin code required");
      const { from, into } = body;
      const a = players[from], b = players[into];
      if (!a || !b || from === into) throw new UserError("Pick two different players");
      const addTo = (map, key, [w, l]) => { const r = (map[key] ||= [0, 0]); r[0] += w; r[1] += l; };
      const aIsNewer = (a.lastPlayed || 0) > (b.lastPlayed || 0);
      for (const m of MODES) {
        const ra = a[m], rb = b[m];
        rb.wins += ra.wins; rb.losses += ra.losses;
        rb.bestStreak = Math.max(rb.bestStreak, ra.bestStreak);
        if (aIsNewer && ra.form) rb.form = ra.form;
        for (const map of ["vs", "partners"]) {
          for (const [k, wl] of Object.entries(ra[map])) if (k !== into) addTo(rb[map], k, wl);
          delete rb[map][from];
        }
      }
      b.firstSeen = Math.min(b.firstSeen, a.firstSeen);
      if (aIsNewer) b.lastPlayed = a.lastPlayed;
      delete players[from];
      s.lastGame = null;
      // everyone else's vs/partner entries for the old name now point at the real one
      for (const [k, p] of Object.entries(players)) {
        for (const m of MODES) for (const map of ["vs", "partners"]) {
          const old = p[m][map][from];
          if (!old) continue;
          if (k !== into) addTo(p[m][map], into, old);
          delete p[m][map][from];
        }
      }
      return;
    }

    case "checkAdmin": {
      if (!isAdmin) throw new UserError("Wrong admin code");
      return;
    }

    default:
      throw new UserError("Unknown action");
  }
}

// Win–loss for whoever is on the table or in line, so the main page can show it.
// For a doubles team it's the pair's record together.
function withRecords(s, players) {
  const records = {};
  for (const p of [...s.table, ...s.queue]) {
    if (!p) continue;
    const [a, b] = namesOf(p);
    const r = players[nameKey(a)];
    if (!r) continue;
    if (modeOf(p) === "singles") records[p.id] = [r.singles.wins, r.singles.losses];
    else records[p.id] = r.doubles.partners[nameKey(b)] || [0, 0];
  }
  const { lastGame, ...pub } = s;
  const canUndo = !!lastGame && Date.now() - lastGame.at < UNDO_MINUTES * 60000;
  return { ...pub, mode: s.mode || "singles", records, undo: canUndo ? { winner: lastGame.winner.name, loser: lastGame.loser.name, at: lastGame.at } : null, adminEnabled: !!ADMIN_CODE };
}

function statsView(players) {
  return { players: Object.entries(players).map(([key, p]) => ({ key, ...p })), adminEnabled: !!ADMIN_CODE };
}

// ---------- handler ----------
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const { s, players } = await load();
      if (req.query && req.query.view === "stats") return res.status(200).json(statsView(players));
      return res.status(200).json(withRecords(s, players));
    }
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const { s, players } = await withLock(async () => {
        const { s, players } = await load();
        const before = JSON.stringify(players);
        apply(s, players, body);
        await save(s);
        if (JSON.stringify(players) !== before) await savePlayers(players);
        return { s, players };
      });
      if (body.view === "stats") return res.status(200).json(statsView(players));
      return res.status(200).json(withRecords(s, players));
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    const status = e instanceof UserError ? 400 : 500;
    return res.status(status).json({ error: e.message || "Server error" });
  }
}
