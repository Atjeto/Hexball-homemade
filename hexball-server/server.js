// Hexball multiplayer server
// Authoritative simulation: clients send inputs, server runs physics, broadcasts state.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;

// ============== CONSTANTS ==============
const PLAYER_R = 22;
const BALL_R = 14;
const SUBSTEPS = 6;

const MATCH_TUNING = {
  fp: 0.90, fb: 0.992,           // tighter friction = less drift
  accel: 0.70, accelB: 1.15,     // bumped to compensate for higher friction
  max: 4.95, maxB: 8.0,
  kick: 7.0, bounce: 0.7,
  ballBounce: 0.85, ballMax: 11.5,
};
const GOLF_TUNING = {
  fp: 0.90, fb: 0.978,
  accel: 0.50, accelB: 0.85,
  max: 4.0, maxB: 6.5,
  kick: 6.0, bounce: 0.65,
  ballBounce: 0.82, ballMax: 9.5,
};

const TEAM_COLORS = ['#e54b4b', '#4b8bf5', '#5ec678', '#d44ba8', '#f5a623', '#7e57c2'];

// ============== ARENAS ==============
// Landscape orientation: wide field, goals on LEFT (red defends left, blue defends right)
// goalH is the vertical span of the goal opening on the side wall.
const arenas = {
  classic: { w: 900, h: 540, goalH: 200 },
  big:     { w: 1100, h: 600, goalH: 220 },
  tight:   { w: 720, h: 480, goalH: 170 },
  hex:     { w: 900, h: 540, goalH: 200, hex: true },
};

// ============== PROCEDURAL GOLF COURSE GENERATOR ==============
// Used when the room toggles "Random Holes". Generates a course with
// randomized walls, bumpers, sand, water, and (rarely) portals. Element
// placements respect a small "keep-out" radius around the start and the
// hole so the course is always playable. Names are pulled from a pool.
const RANDOM_NAMES = [
  'Crooked Creek','Foggy Glen','Tornado Alley','Whisper Hill','Lava Pit',
  'Maze Park','Twin Trees','Echo Valley','Iron Course','Last Light',
  'Winding Way','Storm Front','Sunken Garden','Bramble','Fork in the Road',
];
function rand(min, max) { return min + Math.random() * (max - min); }
function generateCourse() {
  const w = 540, h = 900;
  // Start in lower third, hole in upper third — long enough to be a real putt.
  const ballStart = { x: rand(120, w-120), y: rand(h-150, h-80) };
  const hole = { x: rand(120, w-120), y: rand(80, 180), r: 22 };
  const keepOut = (x, y, pad) => {
    if (Math.hypot(x - ballStart.x, y - ballStart.y) < 90 + pad) return false;
    if (Math.hypot(x - hole.x, y - hole.y) < 80 + pad) return false;
    return true;
  };

  // Bumpers
  const bumpers = [];
  const numBumpers = Math.floor(rand(0, 5));
  for (let attempt = 0; attempt < 30 && bumpers.length < numBumpers; attempt++) {
    const x = rand(80, w-80), y = rand(220, h-220);
    if (!keepOut(x, y, 30)) continue;
    if (bumpers.some(b => Math.hypot(b.x - x, b.y - y) < b.r + 50)) continue;
    bumpers.push({ x, y, r: rand(20, 32) });
  }

  // Walls (always horizontal or vertical rectangles for predictability)
  const walls = [];
  const numWalls = Math.floor(rand(0, 3));
  for (let attempt = 0; attempt < 20 && walls.length < numWalls; attempt++) {
    const horizontal = Math.random() < 0.5;
    const wx = horizontal ? rand(40, w-260) : rand(40, w-40);
    const wy = rand(220, h-260);
    const ww = horizontal ? rand(160, 240) : 16;
    const wh = horizontal ? 16 : rand(160, 240);
    const cx = wx + ww/2, cy = wy + wh/2;
    if (!keepOut(cx, cy, 40)) continue;
    walls.push({ x: wx, y: wy, w: ww, h: wh });
  }

  // Sand patches
  const sand = [];
  const numSand = Math.floor(rand(0, 3));
  for (let attempt = 0; attempt < 15 && sand.length < numSand; attempt++) {
    const x = rand(80, w-80), y = rand(220, h-220);
    if (!keepOut(x, y, 40)) continue;
    sand.push({ x, y, r: rand(50, 80) });
  }

  // Water (less likely + smaller, never crosses hole/start)
  const water = [];
  if (Math.random() < 0.45) {
    for (let attempt = 0; attempt < 10 && water.length < 1; attempt++) {
      const wx = rand(40, w-200), wy = rand(280, h-360);
      const ww = rand(120, 200), wh = rand(60, 110);
      // Avoid water that overlaps start or hole
      const corners = [[wx,wy],[wx+ww,wy],[wx,wy+wh],[wx+ww,wy+wh]];
      const blocks = corners.some(([cx,cy]) => !keepOut(cx, cy, 30));
      if (blocks) continue;
      water.push({ x: wx, y: wy, w: ww, h: wh });
    }
  }

  // Portals (paired) — rare, never close to start/hole
  const portals = [];
  if (Math.random() < 0.25) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const a = { x: rand(80, w-80), y: rand(280, h-280), r: 28 };
      const b = { x: rand(80, w-80), y: rand(280, h-280), r: 28 };
      if (Math.hypot(a.x-b.x, a.y-b.y) < 200) continue;
      if (!keepOut(a.x, a.y, 40) || !keepOut(b.x, b.y, 40)) continue;
      const palette = ['#d44ba8','#4bdcb5','#f5d76e','#9ab8ff'];
      const color = palette[Math.floor(Math.random()*palette.length)];
      portals.push({ x: a.x, y: a.y, r: a.r, target: { x: b.x, y: b.y }, color });
      portals.push({ x: b.x, y: b.y, r: b.r, target: { x: a.x, y: a.y }, color });
      break;
    }
  }

  // Wind (rarely)
  const wind = Math.random() < 0.18 ? { fx: rand(-0.06, 0.06), fy: 0 } : null;

  // Par scales loosely with obstacle count
  const obs = bumpers.length + walls.length + sand.length + water.length + portals.length;
  const par = clamp(2 + Math.floor(obs / 2) + Math.floor(rand(0, 2)), 2, 6);

  return {
    w, h, par,
    ballStart, hole,
    walls, bumpers, sand, water, portals,
    wind,
    name: RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)],
    randomized: true,
  };
}

// ============== GOLF COURSES ==============
const courses = [
  { w:540,h:900,par:2, ballStart:{x:270,y:760}, hole:{x:270,y:140,r:22}, walls:[], bumpers:[{x:270,y:450,r:28}], sand:[], water:[], portals:[], wind:null, name:'Welcome' },
  { w:540,h:900,par:3, ballStart:{x:130,y:780}, hole:{x:410,y:140,r:22}, walls:[], bumpers:[], sand:[{x:350,y:700,r:70}], water:[{x:170,y:430,w:200,h:100}], portals:[], wind:null, name:'River Bend' },
  { w:540,h:900,par:4, ballStart:{x:270,y:800}, hole:{x:270,y:100,r:24}, walls:[], bumpers:[{x:180,y:600,r:26},{x:360,y:540,r:26},{x:270,y:460,r:26},{x:150,y:380,r:26},{x:390,y:320,r:26}], sand:[], water:[], portals:[], wind:null, name:'Pinball Alley' },
  { w:540,h:900,par:3, ballStart:{x:100,y:800}, hole:{x:440,y:120,r:22}, walls:[{x:0,y:450,w:380,h:16}], bumpers:[], sand:[], water:[], portals:[{x:100,y:560,r:30,target:{x:440,y:380},color:'#d44ba8'},{x:440,y:380,r:30,target:{x:100,y:560},color:'#d44ba8'}], wind:null, name:'Wormhole' },
  { w:540,h:900,par:4, ballStart:{x:270,y:820}, hole:{x:270,y:100,r:22}, walls:[{x:100,y:700,w:16,h:140},{x:424,y:700,w:16,h:140},{x:100,y:350,w:240,h:16},{x:200,y:200,w:240,h:16}], bumpers:[], sand:[{x:270,y:580,r:80},{x:150,y:280,r:60},{x:400,y:460,r:50}], water:[], portals:[], wind:null, name:'Dunes' },
  { w:540,h:900,par:3, ballStart:{x:270,y:800}, hole:{x:270,y:120,r:24}, walls:[], bumpers:[{x:270,y:460,r:32}], sand:[], water:[], portals:[], wind:{fx:0.05,fy:0}, name:'Crosswind' },
  { w:540,h:900,par:4, ballStart:{x:270,y:800}, hole:{x:270,y:200,r:22}, walls:[], bumpers:[], sand:[], water:[{x:60,y:100,w:130,h:250},{x:350,y:100,w:130,h:250},{x:60,y:380,w:420,h:30}], portals:[], wind:null, name:'Island Green' },
  { w:540,h:900,par:5, ballStart:{x:270,y:820}, hole:{x:470,y:120,r:22}, walls:[{x:0,y:600,w:380,h:16},{x:200,y:350,w:340,h:16}], bumpers:[{x:130,y:500,r:24},{x:410,y:500,r:24},{x:130,y:220,r:24}], sand:[{x:350,y:700,r:60}], water:[], portals:[{x:60,y:760,r:26,target:{x:60,y:200},color:'#4bdcb5'},{x:60,y:200,r:26,target:{x:60,y:760},color:'#4bdcb5'}], wind:null, name:'Shortcut?' },
  { w:540,h:900,par:5, ballStart:{x:90,y:820}, hole:{x:450,y:100,r:24}, walls:[{x:200,y:700,w:16,h:140},{x:200,y:400,w:240,h:16}], bumpers:[{x:300,y:580,r:24},{x:100,y:480,r:24},{x:380,y:280,r:24}], sand:[{x:360,y:600,r:60}], water:[{x:220,y:200,w:140,h:100}], portals:[{x:480,y:800,r:26,target:{x:60,y:460},color:'#f5d76e'},{x:60,y:460,r:26,target:{x:480,y:800},color:'#f5d76e'}], wind:{fx:-0.04,fy:0}, name:'The Cauldron' },
];

// ============== UTIL ==============
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function clampSpeed(o, max){
  const sp = Math.hypot(o.vx, o.vy);
  if (sp > max){ o.vx = o.vx/sp*max; o.vy = o.vy/sp*max; }
}
function genRoomCode(){
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let s = '';
  for (let i = 0; i < 4; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}

// ============== ROOM ==============
class Room {
  constructor(code, hostId, mode, opts) {
    this.code = code;
    this.hostId = hostId;
    this.mode = mode; // 'match' or 'golf'
    this.players = new Map(); // id -> player object
    this.state = 'lobby'; // lobby | playing | finished
    this.lastActivity = Date.now();

    // Match-specific
    this.matchOpts = {
      arena: opts.arena || 'classic',
      goalsToWin: opts.goalsToWin || 3,
      timeLimit: opts.timeLimit || 0, // seconds; 0 = first-to-goalsToWin
      botDifficulty: opts.botDifficulty || 'normal', // easy | normal | hard
      ballStyle: opts.ballStyle || 'normal',         // normal | bouncy | ice
      numBalls: clamp(opts.numBalls || 1, 1, 3),     // 1, 2, or 3 balls in play
    };
    this.scoreRed = 0;
    this.scoreBlue = 0;
    this.matchBall = null;

    // Golf-specific
    this.golfOpts = {
      courseLength: opts.courseLength || 6,
      randomCourses: !!opts.randomCourses,
    };
    this.activeCourses = []; // resolved course list for this match (random or fixed)
    this.currentHole = 0;
    this.holeStartTime = 0;
    this.scorecards = new Map(); // playerId -> [{par, strokes, name}]
    this.holeCompletePlayers = new Set(); // who's already sunk this hole

    this.matchTime = 0;
    this.lastTick = Date.now();
    this.tickInterval = null;
    this.goalCelebration = 0; // ticks remaining for goal pause
    this.kickoffCountdown = 0; // ticks remaining for "3-2-1-GO" pre-kickoff freeze
    this.lastScorer = null; // 'red' | 'blue' | null
    this.lastBallTouch = null; // { id, name, team } — last player to touch the match ball
    this.touchHistory = []; // last several distinct touches (for assists)
    this.goalLog = []; // [{minute, scorerName, ownGoal, assistName, scorer}]
  }

  recordBallTouch(p) {
    if (this.mode !== 'match') return;
    this.lastBallTouch = { id: p.id, name: p.name, team: p.team };
    const last = this.touchHistory[this.touchHistory.length - 1];
    if (!last || last.id !== p.id) {
      this.touchHistory.push({ id: p.id, name: p.name, team: p.team, t: Date.now() });
      if (this.touchHistory.length > 6) this.touchHistory.shift();
    }
  }

  uniqueName(rawName) {
    const base = (rawName || '').toString().trim().slice(0, 20) || ('Player ' + (this.players.size + 1));
    const taken = new Set([...this.players.values()].map(p => p.name));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(base + ' (' + n + ')')) n++;
    return base + ' (' + n + ')';
  }

  pickJoinTeam() {
    if (this.mode !== 'match') return 'self';
    let red = 0, blue = 0;
    for (const p of this.players.values()) {
      if (p.team === 'red') red++;
      else if (p.team === 'blue') blue++;
    }
    return red <= blue ? 'red' : 'blue';
  }

  addPlayer(id, ws, name) {
    const teamColor = TEAM_COLORS[this.players.size % TEAM_COLORS.length];
    const team = this.pickJoinTeam();
    const p = {
      id, ws, name: this.uniqueName(name),
      team, color: teamColor,
      x: 0, y: 0, vx: 0, vy: 0, r: PLAYER_R,
      boost: 100,
      input: { ax: 0, ay: 0, kicking: false, boosting: false },
      ball: null,
      strokes: 0,
      lastKickPos: null,
      ready: false,
      isBot: false,
    };
    this.players.set(id, p);
    return p;
  }

  addBot() {
    if (this.mode !== 'match') return null;
    if (this.players.size >= 6) return null;
    const id = 'bot_' + Math.random().toString(36).slice(2, 7);
    const team = this.pickJoinTeam();
    const teamColor = team === 'red' ? '#e54b4b' : '#4b8bf5';
    const names = ['Botley','Mecha','Robo','Cog','Pixel','Quark','Vector','Glitch'];
    const baseName = '🤖 ' + names[Math.floor(Math.random() * names.length)];
    const p = {
      id, ws: null, name: this.uniqueName(baseName),
      team, color: teamColor,
      x: 0, y: 0, vx: 0, vy: 0, r: PLAYER_R,
      boost: 100,
      input: { ax: 0, ay: 0, kicking: false, boosting: false },
      ball: null, strokes: 0, lastKickPos: null, ready: false,
      isBot: true,
    };
    this.players.set(id, p);
    return p;
  }

  removeBot(id) {
    const p = this.players.get(id);
    if (!p || !p.isBot) return false;
    this.players.delete(id);
    return true;
  }

  // Role-based bot AI for landscape field.
  //   * Each bot is assigned a stable role (striker / mid / defender) based on
  //     a hash of its id, so multiple bots on the same team SPREAD across the
  //     field rather than clumping on the ball.
  //   * Only the bot closest to the ball actively chases — others "hold position"
  //     at their lane (assigned y-band) on a depth (x-band) defined by their role.
  //   * If the ball reaches a defender's third, they switch to active defense.
  tickBots() {
    if (this.mode !== 'match' || !this.matchBall) return;
    const arena = arenas[this.matchOpts.arena];
    const W = arena.w, H = arena.h;
    const ball = this.matchBall;
    const diff = this.matchOpts.botDifficulty || 'normal';
    const PROF = {
      easy:   { reactionSkip: 0.45, leadFactor: 0,  jitterAmp: 0.30, kickRange: 36, boostThresh: 320 },
      normal: { reactionSkip: 0.10, leadFactor: 4,  jitterAmp: 0.15, kickRange: 42, boostThresh: 220 },
      hard:   { reactionSkip: 0.00, leadFactor: 9,  jitterAmp: 0.05, kickRange: 50, boostThresh: 140 },
    }[diff] || { reactionSkip: 0.10, leadFactor: 4, jitterAmp: 0.15, kickRange: 42, boostThresh: 220 };

    // Group bots by team (ordered by id so role assignment is stable across ticks).
    const teamGroups = { red: [], blue: [] };
    for (const p of this.players.values()) {
      if (p.isBot && (p.team === 'red' || p.team === 'blue')) teamGroups[p.team].push(p);
    }
    teamGroups.red.sort((a, b) => a.id.localeCompare(b.id));
    teamGroups.blue.sort((a, b) => a.id.localeCompare(b.id));

    for (const team of ['red', 'blue']) {
      const mates = teamGroups[team];
      if (!mates.length) continue;
      // Identify the mate physically closest to the ball — they're the chaser.
      let chaserIdx = 0, chaserDist = Infinity;
      for (let i = 0; i < mates.length; i++) {
        const m = mates[i];
        const d = Math.hypot(ball.x - m.x, ball.y - m.y);
        if (d < chaserDist) { chaserDist = d; chaserIdx = i; }
      }
      // Lane assignment: spread along the y axis (top → bottom slots).
      // For 1 mate → centered. 2 → 0.33 / 0.66. 3 → 0.25 / 0.5 / 0.75. 4 → 0.2 / 0.4 / 0.6 / 0.8.
      const N = mates.length;
      mates.forEach((p, i) => {
        const laneFrac = N === 1 ? 0.5 : (i + 0.5) / N;
        p._botLaneY = H * (0.20 + 0.60 * laneFrac); // band 20%–80% of arena height
      });
      // Role by index: the slot closest to median is the "mid" / striker; outer slots are defenders.
      // For simplicity: front half = attackers (closer to opp goal), back half = defenders.
      mates.forEach((p, i) => {
        const role = (i < N / 2) ? 'def' : 'atk'; // arbitrary stable split (id-sorted)
        p._botRole = role;
      });

      // Each bot's HOME x-position depends on team + role.
      // Red defends LEFT (x≈0): defenders sit at x≈W*0.18, attackers at x≈W*0.45.
      // Blue defends RIGHT (x≈W): defenders sit at x≈W*0.82, attackers at x≈W*0.55.
      const homeXDef = team === 'red' ? W * 0.18 : W * 0.82;
      const homeXAtk = team === 'red' ? W * 0.45 : W * 0.55;

      mates.forEach((p, i) => {
        if (Math.random() < PROF.reactionSkip) return;
        const isChaser = (i === chaserIdx);

        const predX = ball.x + (ball.vx || 0) * PROF.leadFactor;
        const predY = ball.y + (ball.vy || 0) * PROF.leadFactor;
        const dBall = Math.hypot(ball.x - p.x, ball.y - p.y) || 1;

        // Defender takes over if the ball is in our defensive third.
        const inOurThird = team === 'red' ? ball.x < W * 0.33 : ball.x > W * 0.67;
        const role = p._botRole;
        const homeX = (role === 'def' ? homeXDef : homeXAtk);
        const homeY = p._botLaneY;

        let tx, ty;
        if (isChaser || (role === 'def' && inOurThird) || dBall < 90) {
          // Active engagement — try to hit ball toward opponent goal.
          // Stand on the side of the ball OPPOSITE the target goal so we push it forward.
          const targetGoalX = team === 'red' ? W : 0;
          const sideOffset = team === 'red' ? -28 : 28; // stand a bit "behind" the ball
          if (dBall < 70) {
            tx = predX + sideOffset;
            ty = predY + Math.sign(ball.y - H * 0.5) * 16;
          } else {
            // Approach: head toward predicted ball with slight angle to push it goalward.
            tx = predX;
            ty = predY;
          }
        } else {
          // Hold lane: drift toward home (homeX, homeY), with mild ball tracking on the y-axis only.
          // This keeps mates SPREAD instead of all converging on the ball.
          const ballPullY = clamp((ball.y - homeY) * 0.35, -80, 80);
          tx = homeX;
          ty = homeY + ballPullY;
        }

        // Steering toward (tx, ty)
        const dx = tx - p.x, dy = ty - p.y;
        const d = Math.hypot(dx, dy) || 1;
        const jitter = Math.sin((Date.now() / 800) + p.x * 0.01 + i) * PROF.jitterAmp;
        p.input.ax = clamp(dx / d + jitter, -1, 1);
        p.input.ay = clamp(dy / d, -1, 1);
        // Kick when actually adjacent to ball
        p.input.kicking = dBall < PROF.kickRange;
        // Boost only when chasing or sprinting back to position
        p.input.boosting = (isChaser && d > PROF.boostThresh && p.boost > 35) ||
                           (!isChaser && d > 280 && p.boost > 50);
      });
    }
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.players.size === 0) return true; // room empty
    if (this.hostId === id) {
      // promote next non-bot player as host (bots can't be host)
      let chosen = null;
      for (const p of this.players.values()) {
        if (!p.isBot) { chosen = p.id; break; }
      }
      if (chosen) {
        this.hostId = chosen;
      } else {
        // Only bots remain — clear the room.
        this.players.clear();
        return true;
      }
    }
    return false;
  }

  start() {
    if (this.state !== 'lobby') return;
    if (this.players.size < 1) return;
    this.state = 'playing';
    if (this.mode === 'match') this.initMatch();
    else {
      // Resolve the course set for this round (random or fixed slice).
      const len = this.golfOpts.courseLength;
      if (this.golfOpts.randomCourses) {
        this.activeCourses = [];
        for (let i = 0; i < len; i++) this.activeCourses.push(generateCourse());
      } else {
        this.activeCourses = courses.slice(0, len);
      }
      this.currentHole = 0;
      this.scorecards = new Map();
      this.holeCompletePlayers = new Set();
      this.initGolfHole();
    }
    this.lastTick = Date.now();
    if (this.tickInterval) { clearInterval(this.tickInterval); }
    this.tickInterval = setInterval(() => this.tick(), TICK_MS);
  }

  initMatch() {
    this.scoreRed = 0;
    this.scoreBlue = 0;
    this.matchTime = 0;
    this.goalCelebration = 0;
    this.lastScorer = null;
    this.lastBallTouch = null;
    this.touchHistory = [];
    this.goalLog = [];
    // Reset per-match player stats
    for (const p of this.players.values()) {
      p.goals = 0; p.ownGoals = 0; p.assists = 0;
    }
    this.resetPositions();
    this.kickoffCountdown = TICK_HZ * 3; // 3-second countdown on first kickoff
  }

  // Reset positions only (used after goals) so scores persist.
  // Landscape layout: red defends LEFT goal, blue defends RIGHT goal.
  // Players spawn vertically staggered on their own half.
  resetPositions() {
    const W = arenas[this.matchOpts.arena].w;
    const H = arenas[this.matchOpts.arena].h;
    let redCount = 0, blueCount = 0;
    for (const p of this.players.values()) {
      if (p.team === 'red') {
        const slot = redCount++;
        p.x = W * 0.22;
        p.y = H * 0.5 + (slot - 0.5) * 70;
      } else {
        const slot = blueCount++;
        p.x = W * 0.78;
        p.y = H * 0.5 + (slot - 0.5) * 70;
      }
      p.vx = 0; p.vy = 0;
      p.boost = 100;
      p.input.kicking = false;
      p.input.boosting = false;
      p.input.ax = 0; p.input.ay = 0;
    }
    this.matchBall = { x: W/2, y: H/2, vx: 0, vy: 0, r: BALL_R };
    // Multi-ball: spawn extras around the center with a tiny outward push.
    this.extraBalls = [];
    const N = Math.max(1, Math.min(3, this.matchOpts.numBalls || 1));
    for (let i = 1; i < N; i++) {
      const ang = (i - 1) * Math.PI + Math.PI / 2; // alternate above/below center
      const dx = Math.cos(ang) * 70, dy = Math.sin(ang) * 70;
      this.extraBalls.push({ x: W/2 + dx, y: H/2 + dy, vx: 0, vy: 0, r: BALL_R });
    }
  }

  initGolfHole() {
    const h = this.activeCourses[this.currentHole];
    const angleStep = (Math.PI * 2) / Math.max(this.players.size, 1);
    let i = 0;
    for (const p of this.players.values()) {
      // arrange players around the ball start in a circle
      const ang = i * angleStep;
      p.x = h.ballStart.x + Math.cos(ang) * 70;
      p.y = h.ballStart.y + 70 + Math.sin(ang) * 30;
      p.vx = 0; p.vy = 0;
      p.boost = 100;
      // each player gets their own ball, slightly offset
      p.ball = {
        x: h.ballStart.x + Math.cos(ang) * 28,
        y: h.ballStart.y + Math.sin(ang) * 28,
        vx: 0, vy: 0, r: BALL_R, portalCool: 0,
      };
      p.strokes = 0;
      p.lastKickPos = { x: p.ball.x, y: p.ball.y };
      i++;
    }
    this.holeCompletePlayers.clear();
    this.holeStartTime = Date.now();
    this.goalCelebration = 0;
  }

  setInput(playerId, input) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.input.ax = clamp(Number(input.ax) || 0, -1, 1);
    p.input.ay = clamp(Number(input.ay) || 0, -1, 1);
    const m = Math.hypot(p.input.ax, p.input.ay);
    if (m > 1) { p.input.ax /= m; p.input.ay /= m; }
    p.input.kicking = !!input.kicking;
    p.input.boosting = !!input.boosting;
  }

  tick() {
    const now = Date.now();
    this.lastTick = now;
    this.lastActivity = now;

    if (this.goalCelebration > 0) {
      this.goalCelebration--;
      this.broadcastState();
      return;
    }

    if (this.kickoffCountdown > 0) {
      this.kickoffCountdown--;
      // Freeze players: zero out velocities and inputs so nothing moves during the count.
      if (this.mode === 'match') {
        for (const p of this.players.values()) { p.vx = 0; p.vy = 0; }
        if (this.matchBall) { this.matchBall.vx = 0; this.matchBall.vy = 0; }
      }
      this.broadcastState();
      return;
    }

    if (this.mode === 'match') this.tickMatch();
    else this.tickGolf();

    this.broadcastState();

    // Auto-cleanup empty rooms
    if (this.players.size === 0) this.stop();
  }

  // ---------- MATCH MODE ----------
  // Compose the live tuning, applying ball-style modifiers if any.
  effectiveMatchTuning() {
    const style = this.matchOpts.ballStyle || 'normal';
    if (style === 'bouncy') {
      // Energy-GAIN bounces: ball gets faster off walls. Capped via clampSpeed
      // inside substeps so it doesn't go to infinity.
      return { ...MATCH_TUNING, ballBounce: 1.05, ballMax: 14.5, fb: 0.997 };
    }
    if (style === 'ice') {
      // Almost frictionless ball — slides forever, glassy feel.
      return { ...MATCH_TUNING, fb: 0.999, ballBounce: 0.92, ballMax: 12 };
    }
    return MATCH_TUNING;
  }

  tickMatch() {
    const T = this.effectiveMatchTuning();
    const arena = arenas[this.matchOpts.arena];

    this.tickBots();
    for (const p of this.players.values()) this.updatePlayer(p, T, arena, null);
    this.updateMatchBall(T, arena);
    // Update extra balls (multi-ball mode)
    if (this.extraBalls && this.extraBalls.length) {
      for (const eb of this.extraBalls) this.updateExtraBall(eb, T, arena);
      // Ball-ball collisions amongst all the match balls
      const all = [this.matchBall, ...this.extraBalls];
      for (let i = 0; i < all.length; i++) {
        for (let j = i+1; j < all.length; j++) this.collideCircles(all[i], all[j]);
      }
      // Players should also collide with extra balls
      for (const p of this.players.values()) {
        for (const eb of this.extraBalls) this.collidePlayerBall(p, eb, T);
      }
    }

    // player-player collisions
    const arr = [...this.players.values()];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i+1; j < arr.length; j++) {
        this.collideCircles(arr[i], arr[j]);
      }
    }

    this.matchTime += 1 / TICK_HZ;
    if (this.matchOpts.timeLimit > 0 && this.matchTime >= this.matchOpts.timeLimit) {
      this.endMatch();
    }
  }

  // Multi-ball mode: extras follow the same wall physics, but a goal awards a
  // score AND immediately respawns just that ball at center (no full match pause).
  updateExtraBall(ball, T, arena) {
    const W = arena.w, H = arena.h, gh = arena.goalH;
    const gT = (H - gh) / 2, gB = (H + gh) / 2;
    ball.vx *= T.fb; ball.vy *= T.fb;
    clampSpeed(ball, T.ballMax);
    for (let i = 0; i < SUBSTEPS; i++) {
      ball.x += ball.vx / SUBSTEPS;
      ball.y += ball.vy / SUBSTEPS;
      if (ball.y - ball.r < 0) { ball.y = ball.r; ball.vy *= -T.ballBounce; }
      if (ball.y + ball.r > H) { ball.y = H - ball.r; ball.vy *= -T.ballBounce; }
      if (arena.hex) this.hexCornerCollide(ball, arena, T.ballBounce);
      if (ball.x - ball.r < -ball.r) {
        if (ball.y > gT && ball.y < gB) { this.onMultiGoal('blue', ball, W, H); return; }
        else { ball.x = ball.r; ball.vx *= -T.ballBounce; }
      }
      if (ball.x + ball.r > W + ball.r) {
        if (ball.y > gT && ball.y < gB) { this.onMultiGoal('red', ball, W, H); return; }
        else { ball.x = W - ball.r; ball.vx *= -T.ballBounce; }
      }
      if (ball.x - ball.r < 0 && (ball.y < gT || ball.y > gB)) { ball.x = ball.r; ball.vx *= -T.ballBounce; }
      if (ball.x + ball.r > W && (ball.y < gT || ball.y > gB)) { ball.x = W - ball.r; ball.vx *= -T.ballBounce; }
      if (T.ballBounce >= 1) clampSpeed(ball, T.ballMax);
    }
  }

  // Goal scored on an EXTRA ball — award the team but keep the match running.
  onMultiGoal(scorer, ball, W, H) {
    if (scorer === 'red') this.scoreRed++; else this.scoreBlue++;
    this.lastScorer = scorer;
    const lt = this.lastBallTouch;
    const ownGoal = !!(lt && lt.team && lt.team !== scorer);
    if (lt && !ownGoal) {
      const sp = this.players.get(lt.id); if (sp) sp.goals = (sp.goals||0) + 1;
    } else if (lt && ownGoal) {
      const sp = this.players.get(lt.id); if (sp) sp.ownGoals = (sp.ownGoals||0) + 1;
    }
    this.goalLog.push({
      minute: Math.round(this.matchTime),
      scorer, scorerName: lt ? lt.name : null, ownGoal, assistName: null,
    });
    this.broadcast({
      type: 'goal', scorer,
      scoreRed: this.scoreRed, scoreBlue: this.scoreBlue,
      scorerName: lt ? lt.name : null, ownGoal, assistName: null,
    });
    this.lastBallTouch = null;
    if (this.scoreRed >= this.matchOpts.goalsToWin || this.scoreBlue >= this.matchOpts.goalsToWin) {
      this.endMatch();
      return;
    }
    // Respawn this single ball at center
    ball.x = W / 2; ball.y = H / 2; ball.vx = 0; ball.vy = 0;
  }

  // Landscape ball physics:
  //   Left wall = red goal opening (vertical span gT..gB) → blue scores when ball exits left
  //   Right wall = blue goal opening → red scores when ball exits right
  //   Top/bottom walls always bounce.
  updateMatchBall(T, arena) {
    const ball = this.matchBall;
    const W = arena.w, H = arena.h, gh = arena.goalH;
    const gT = (H - gh) / 2, gB = (H + gh) / 2;
    ball.vx *= T.fb; ball.vy *= T.fb;
    clampSpeed(ball, T.ballMax);
    for (let i = 0; i < SUBSTEPS; i++) {
      ball.x += ball.vx / SUBSTEPS;
      ball.y += ball.vy / SUBSTEPS;
      // Top/bottom walls
      if (ball.y - ball.r < 0) { ball.y = ball.r; ball.vy *= -T.ballBounce; }
      if (ball.y + ball.r > H) { ball.y = H - ball.r; ball.vy *= -T.ballBounce; }
      if (arena.hex) this.hexCornerCollide(ball, arena, T.ballBounce);
      // Left wall (red goal opening)
      if (ball.x - ball.r < -ball.r) {
        if (ball.y > gT && ball.y < gB) { this.onMatchGoal('blue'); return; }
        else { ball.x = ball.r; ball.vx *= -T.ballBounce; }
      }
      // Right wall (blue goal opening)
      if (ball.x + ball.r > W + ball.r) {
        if (ball.y > gT && ball.y < gB) { this.onMatchGoal('red'); return; }
        else { ball.x = W - ball.r; ball.vx *= -T.ballBounce; }
      }
      // Solid wall outside goal-mouth y-range
      if (ball.x - ball.r < 0 && (ball.y < gT || ball.y > gB)) { ball.x = ball.r; ball.vx *= -T.ballBounce; }
      if (ball.x + ball.r > W && (ball.y < gT || ball.y > gB)) { ball.x = W - ball.r; ball.vx *= -T.ballBounce; }
      // Re-clamp inside substep so bouncy mode (ballBounce > 1) can't blow up
      if (T.ballBounce >= 1) clampSpeed(ball, T.ballMax);
    }
  }

  onMatchGoal(scorer) {
    if (scorer === 'red') this.scoreRed++; else this.scoreBlue++;
    this.lastScorer = scorer;
    const lt = this.lastBallTouch;
    const ownGoal = !!(lt && lt.team && lt.team !== scorer);

    // Tally per-player stats and find an assister.
    let assistName = null;
    if (lt) {
      const scorerPlayer = this.players.get(lt.id);
      if (scorerPlayer) {
        if (ownGoal) scorerPlayer.ownGoals = (scorerPlayer.ownGoals || 0) + 1;
        else scorerPlayer.goals = (scorerPlayer.goals || 0) + 1;
      }
      if (!ownGoal) {
        // Look back through touch history for the most recent OTHER same-team touch within 5s.
        const now = Date.now();
        for (let i = this.touchHistory.length - 2; i >= 0; i--) {
          const h = this.touchHistory[i];
          if (h.id === lt.id) continue;
          if (h.team !== scorer) break; // opposing touch broke the play
          if (now - h.t > 5000) break;
          const ap = this.players.get(h.id);
          if (ap) { ap.assists = (ap.assists || 0) + 1; assistName = ap.name; }
          break;
        }
      }
    }

    this.goalLog.push({
      minute: Math.round(this.matchTime),
      scorer,
      scorerName: lt ? lt.name : null,
      ownGoal,
      assistName,
    });

    this.broadcast({
      type: 'goal',
      scorer,
      scoreRed: this.scoreRed,
      scoreBlue: this.scoreBlue,
      scorerName: lt ? lt.name : null,
      ownGoal,
      assistName,
    });
    this.lastBallTouch = null;
    this.goalCelebration = TICK_HZ * 2;
    if (this.scoreRed >= this.matchOpts.goalsToWin || this.scoreBlue >= this.matchOpts.goalsToWin) {
      this.endMatch();
    } else {
      setTimeout(() => {
        if (this.state !== 'playing') return;
        this.resetPositions();
        this.kickoffCountdown = TICK_HZ * 3;
      }, 1800);
    }
  }

  endMatch() {
    this.state = 'finished';
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
    const winner = this.scoreRed === this.scoreBlue ? 'draw' : (this.scoreRed > this.scoreBlue ? 'red' : 'blue');
    const playerStats = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, team: p.team, isBot: !!p.isBot,
      goals: p.goals || 0, ownGoals: p.ownGoals || 0, assists: p.assists || 0,
    }));
    this.broadcast({
      type: 'matchEnd',
      winner,
      scoreRed: this.scoreRed,
      scoreBlue: this.scoreBlue,
      playerStats,
      goalLog: this.goalLog,
    });
    setTimeout(() => {
      // Skip if a rematch was already started.
      if (this.state !== 'finished') return;
      this.state = 'lobby';
      this.broadcast({ type: 'roomState', state: 'lobby' });
    }, 6000);
  }

  // ---------- GOLF MODE ----------
  tickGolf() {
    const T = GOLF_TUNING;
    const h = this.activeCourses[this.currentHole];

    for (const p of this.players.values()) {
      if (this.holeCompletePlayers.has(p.id)) continue;
      this.updatePlayer(p, T, null, h);
      this.updateGolfBall(p, T, h);
    }

    // player-player collisions
    const arr = [...this.players.values()].filter(p => !this.holeCompletePlayers.has(p.id));
    for (let i = 0; i < arr.length; i++) {
      for (let j = i+1; j < arr.length; j++) {
        this.collideCircles(arr[i], arr[j]);
      }
    }
    // ball-ball collisions (the chaos)
    const balls = arr.map(p => p.ball);
    for (let i = 0; i < balls.length; i++) {
      for (let j = i+1; j < balls.length; j++) {
        this.collideCircles(balls[i], balls[j]);
      }
    }
  }

  updateGolfBall(p, T, h) {
    const ball = p.ball;
    if (h.wind) { ball.vx += h.wind.fx; ball.vy += h.wind.fy; }
    let onSand = false;
    for (const s of h.sand) if (Math.hypot(ball.x - s.x, ball.y - s.y) < s.r) { onSand = true; break; }
    ball.vx *= onSand ? 0.93 : T.fb;
    ball.vy *= onSand ? 0.93 : T.fb;
    clampSpeed(ball, T.ballMax);

    for (let i = 0; i < SUBSTEPS; i++) {
      ball.x += ball.vx / SUBSTEPS;
      ball.y += ball.vy / SUBSTEPS;
      if (ball.x - ball.r < 0) { ball.x = ball.r; ball.vx *= -T.ballBounce; }
      if (ball.x + ball.r > h.w) { ball.x = h.w - ball.r; ball.vx *= -T.ballBounce; }
      if (ball.y - ball.r < 0) { ball.y = ball.r; ball.vy *= -T.ballBounce; }
      if (ball.y + ball.r > h.h) { ball.y = h.h - ball.r; ball.vy *= -T.ballBounce; }
      for (const w of h.walls) this.collideRectCircle(ball, w, T.ballBounce);
      for (const b of h.bumpers) {
        const dd = Math.hypot(ball.x - b.x, ball.y - b.y);
        if (dd < ball.r + b.r) {
          this.collideCircleObstacle(ball, b, 1.1);
          const nx = (ball.x - b.x) / (dd || 0.001);
          const ny = (ball.y - b.y) / (dd || 0.001);
          ball.vx += nx * 1.2; ball.vy += ny * 1.2;
          clampSpeed(ball, T.ballMax);
        }
      }
    }

    // water = +1 stroke + reset
    for (const w of h.water) {
      if (ball.x > w.x && ball.x < w.x + w.w && ball.y > w.y && ball.y < w.y + w.h) {
        p.strokes++;
        ball.x = p.lastKickPos.x; ball.y = p.lastKickPos.y;
        ball.vx = 0; ball.vy = 0;
        this.broadcast({ type: 'splash', playerId: p.id, name: p.name });
        return;
      }
    }

    // portals
    if (ball.portalCool > 0) ball.portalCool--;
    if (ball.portalCool === 0) {
      for (const portal of h.portals) {
        if (Math.hypot(ball.x - portal.x, ball.y - portal.y) < portal.r) {
          ball.x = portal.target.x;
          ball.y = portal.target.y;
          ball.portalCool = TICK_HZ; // 1 second cooldown
          break;
        }
      }
    }

    // Cup absorption — slowed-down ball drops in. Threshold raised significantly
    // so fast putts can still sink (was 4.5, now ~80% of max ball speed).
    // We also apply a strong "drag" inside the cup zone to brake fast balls
    // toward the threshold rather than rejecting them outright.
    const dHole = Math.hypot(ball.x - h.hole.x, ball.y - h.hole.y);
    if (dHole < h.hole.r) {
      const sp = Math.hypot(ball.vx, ball.vy);
      const dropThreshold = T.ballMax * 0.85; // 8.075 for golf
      if (sp < dropThreshold) {
        this.onPlayerHoledOut(p);
      } else {
        // Strong braking once over the cup, plus a small inward pull so the ball
        // doesn't sail straight across — helps it sink on the next pass.
        ball.vx *= 0.78; ball.vy *= 0.78;
        const nx = (h.hole.x - ball.x) / (dHole || 0.001);
        const ny = (h.hole.y - ball.y) / (dHole || 0.001);
        ball.vx += nx * 0.6; ball.vy += ny * 0.6;
      }
    }
  }

  onPlayerHoledOut(p) {
    if (this.holeCompletePlayers.has(p.id)) return;
    this.holeCompletePlayers.add(p.id);
    const h = this.activeCourses[this.currentHole];
    const card = this.scorecards.get(p.id) || [];
    card.push({ par: h.par, strokes: p.strokes, name: h.name });
    this.scorecards.set(p.id, card);

    this.broadcast({
      type: 'holed',
      playerId: p.id,
      name: p.name,
      strokes: p.strokes,
      par: h.par,
      finishOrder: this.holeCompletePlayers.size,
    });

    // If everyone done, advance hole
    if (this.holeCompletePlayers.size === this.players.size) {
      this.goalCelebration = TICK_HZ * 2; // brief pause
      setTimeout(() => {
        if (this.state !== 'playing') return;
        this.currentHole++;
        if (this.currentHole >= this.golfOpts.courseLength) {
          this.endGolf();
        } else {
          this.initGolfHole();
          this.broadcast({ type: 'newHole', hole: this.currentHole, holeData: this.activeCourses[this.currentHole] });
        }
      }, 2200);
    } else {
      // Auto-advance after 30s if some players are stuck
      setTimeout(() => {
        if (this.state !== 'playing') return;
        if (this.holeCompletePlayers.size === this.players.size) return;
        if (Date.now() - this.holeStartTime > 90000) {
          // give stragglers max-strokes
          for (const pp of this.players.values()) {
            if (!this.holeCompletePlayers.has(pp.id)) {
              pp.strokes = Math.max(pp.strokes, h.par + 4);
              this.onPlayerHoledOut(pp);
            }
          }
        }
      }, 30000);
    }
  }

  endGolf() {
    this.state = 'finished';
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
    // compile final scores
    const results = [];
    for (const p of this.players.values()) {
      const card = this.scorecards.get(p.id) || [];
      let total = 0, totalPar = 0;
      for (const s of card) { total += s.strokes; totalPar += s.par; }
      results.push({
        playerId: p.id, name: p.name, color: p.color,
        total, totalPar, diff: total - totalPar, card,
      });
    }
    results.sort((a, b) => a.total - b.total);
    this.broadcast({ type: 'golfEnd', results });

    setTimeout(() => {
      if (this.state !== 'finished') return;
      this.state = 'lobby';
      this.broadcast({ type: 'roomState', state: 'lobby' });
    }, 6000);
  }

  // ---------- SHARED PHYSICS ----------
  updatePlayer(p, T, arena, hole) {
    const ax = p.input.ax, ay = p.input.ay;
    const boosting = p.input.boosting && p.boost > 0;
    const accel = boosting ? T.accelB : T.accel;
    const max = boosting ? T.maxB : T.max;

    p.vx += ax * accel;
    p.vy += ay * accel;
    clampSpeed(p, max);
    p.vx *= T.fp; p.vy *= T.fp;

    for (let i = 0; i < SUBSTEPS; i++) {
      p.x += p.vx / SUBSTEPS;
      p.y += p.vy / SUBSTEPS;
      // walls (landscape: goals on LEFT and RIGHT)
      if (arena) {
        const W = arena.w, H = arena.h, gh = arena.goalH;
        const gT = (H - gh) / 2, gB = (H + gh) / 2;
        if (p.y - p.r < 0) { p.y = p.r; p.vy *= -T.bounce; }
        if (p.y + p.r > H) { p.y = H - p.r; p.vy *= -T.bounce; }
        if (p.x - p.r < 0 && (p.y < gT || p.y > gB)) { p.x = p.r; p.vx *= -T.bounce; }
        if (p.x + p.r > W && (p.y < gT || p.y > gB)) { p.x = W - p.r; p.vx *= -T.bounce; }
        if (arena.hex) this.hexCornerCollide(p, arena, T.bounce);
      } else if (hole) {
        if (p.x - p.r < 0) { p.x = p.r; p.vx *= -T.bounce; }
        if (p.x + p.r > hole.w) { p.x = hole.w - p.r; p.vx *= -T.bounce; }
        if (p.y - p.r < 0) { p.y = p.r; p.vy *= -T.bounce; }
        if (p.y + p.r > hole.h) { p.y = hole.h - p.r; p.vy *= -T.bounce; }
        for (const w of hole.walls) this.collideRectCircle(p, w, T.bounce);
        for (const b of hole.bumpers) this.collideCircleObstacle(p, b, T.bounce);
      }
      // player vs ball(s)
      if (this.mode === 'match') {
        this.collidePlayerBall(p, this.matchBall, T);
      } else {
        // Golf: skip the player↔ball collision when the ball is over the cup so
        // a player standing on the hole can't body-block the putt. The hole's
        // own absorption logic in updateGolfBall takes over from there.
        const overCup = (b) => Math.hypot(b.x - hole.hole.x, b.y - hole.hole.y) < hole.hole.r + 8;
        if (p.ball && !overCup(p.ball)) this.collidePlayerBall(p, p.ball, T);
        for (const other of this.players.values()) {
          if (other.id !== p.id && other.ball && !this.holeCompletePlayers.has(other.id) && !overCup(other.ball)) {
            this.collidePlayerBall(p, other.ball, T);
          }
        }
      }
    }

    // boost regen
    if (p.input.boosting && (ax !== 0 || ay !== 0)) p.boost = Math.max(0, p.boost - 2.4);
    else p.boost = Math.min(100, p.boost + 0.7);

    // kick
    if (p.input.kicking) {
      const target = (this.mode === 'match') ? this.matchBall : p.ball;
      // for golf, can also kick adjacent balls (own or others)
      const kickables = (this.mode === 'match') ? [this.matchBall] : (
        [...this.players.values()].filter(o => o.ball && !this.holeCompletePlayers.has(o.id)).map(o => o.ball)
      );
      let kicked = false;
      for (const b of kickables) {
        const d = dist(p, b);
        if (d < p.r + b.r + 12) {
          const dx = b.x - p.x, dy = b.y - p.y;
          const dn = Math.hypot(dx, dy) || 1;
          b.vx += (dx / dn) * T.kick;
          b.vy += (dy / dn) * T.kick;
          clampSpeed(b, T.ballMax);
          // strokes only count for OWN ball in golf
          if (this.mode === 'golf' && b === p.ball && !kicked) {
            p.strokes++;
            p.lastKickPos = { x: b.x, y: b.y };
          }
          if (this.mode === 'match') this.recordBallTouch(p);
          kicked = true;
        }
      }
    }
  }

  collidePlayerBall(p, ball, T) {
    if (!ball) return;
    const d = dist(p, ball);
    const minD = p.r + ball.r;
    if (d < minD) {
      const dx = ball.x - p.x, dy = ball.y - p.y;
      const dn = d || 0.001;
      const nx = dx / dn, ny = dy / dn;
      const overlap = minD - d;
      ball.x += nx * overlap; ball.y += ny * overlap;
      const relVx = ball.vx - p.vx, relVy = ball.vy - p.vy;
      const dot = relVx * nx + relVy * ny;
      if (dot < 0) {
        const restitution = 1.1;
        ball.vx -= (1 + restitution) * dot * nx;
        ball.vy -= (1 + restitution) * dot * ny;
        clampSpeed(ball, T.ballMax);
        if (this.mode === 'match' && ball === this.matchBall) {
          this.recordBallTouch(p);
        }
      }
    }
  }

  collideCircles(a, b) {
    const d = dist(a, b);
    const minD = (a.r || 0) + (b.r || 0);
    if (d < minD) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const dn = d || 0.001;
      const nx = dx / dn, ny = dy / dn;
      const overlap = minD - d;
      a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
      b.x += nx * overlap / 2; b.y += ny * overlap / 2;
      const va = a.vx * nx + a.vy * ny;
      const vb = b.vx * nx + b.vy * ny;
      const diff = vb - va;
      a.vx += diff * nx; a.vy += diff * ny;
      b.vx -= diff * nx; b.vy -= diff * ny;
    }
  }

  collideRectCircle(c, rect, bounce) {
    const rx = clamp(c.x, rect.x, rect.x + rect.w);
    const ry = clamp(c.y, rect.y, rect.y + rect.h);
    const dx = c.x - rx, dy = c.y - ry;
    const d2 = dx * dx + dy * dy;
    if (d2 < c.r * c.r) {
      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d, ny = dy / d;
      const overlap = c.r - d;
      c.x += nx * overlap; c.y += ny * overlap;
      const dot = c.vx * nx + c.vy * ny;
      if (dot < 0) {
        c.vx -= (1 + bounce) * dot * nx;
        c.vy -= (1 + bounce) * dot * ny;
      }
    }
  }
  collideCircleObstacle(c, obs, bounce) {
    const dx = c.x - obs.x, dy = c.y - obs.y;
    const d = Math.hypot(dx, dy);
    const minD = c.r + obs.r;
    if (d < minD) {
      const dn = d || 0.001;
      const nx = dx / dn, ny = dy / dn;
      const overlap = minD - d;
      c.x += nx * overlap; c.y += ny * overlap;
      const dot = c.vx * nx + c.vy * ny;
      if (dot < 0) {
        c.vx -= (1 + bounce) * dot * nx;
        c.vy -= (1 + bounce) * dot * ny;
      }
    }
  }
  hexCornerCollide(o, arena, bounce) {
    const W = arena.w, H = arena.h, cut = 90, r = o.r;
    const corners = [
      { fn:(x,y)=>x+y-cut,         nx:-1/Math.SQRT2, ny:-1/Math.SQRT2 },
      { fn:(x,y)=>(W-x)+y-cut,     nx: 1/Math.SQRT2, ny:-1/Math.SQRT2 },
      { fn:(x,y)=>x+(H-y)-cut,     nx:-1/Math.SQRT2, ny: 1/Math.SQRT2 },
      { fn:(x,y)=>(W-x)+(H-y)-cut, nx: 1/Math.SQRT2, ny: 1/Math.SQRT2 },
    ];
    for (const c of corners) {
      const v = c.fn(o.x, o.y);
      if (v < r) {
        const push = r - v;
        o.x += c.nx * push; o.y += c.ny * push;
        const dot = o.vx * c.nx + o.vy * c.ny;
        if (dot < 0) {
          o.vx -= (1 + bounce) * dot * c.nx;
          o.vy -= (1 + bounce) * dot * c.ny;
        }
      }
    }
  }

  // ---------- NETWORKING ----------
  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (!p.ws) continue;
      try { p.ws.send(data); } catch (e) {}
    }
  }

  broadcastState() {
    const players = [];
    for (const p of this.players.values()) {
      const o = {
        id: p.id, name: p.name, color: p.color, team: p.team,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        boost: Math.round(p.boost),
        boosting: p.input.boosting,
        strokes: p.strokes,
        holed: this.holeCompletePlayers.has(p.id),
      };
      if (this.mode === 'golf' && p.ball) {
        o.ball = {
          x: Math.round(p.ball.x * 10) / 10,
          y: Math.round(p.ball.y * 10) / 10,
        };
      }
      players.push(o);
    }
    const msg = {
      type: 'state',
      mode: this.mode,
      state: this.state,
      players,
      goalCelebration: this.goalCelebration > 0,
      lastScorer: this.lastScorer,
      kickoff: this.kickoffCountdown > 0 ? Math.ceil(this.kickoffCountdown / TICK_HZ) : 0,
    };
    if (this.mode === 'match') {
      msg.ball = {
        x: Math.round(this.matchBall.x * 10) / 10,
        y: Math.round(this.matchBall.y * 10) / 10,
      };
      msg.scoreRed = this.scoreRed;
      msg.scoreBlue = this.scoreBlue;
      msg.matchTime = Math.round(this.matchTime);
      msg.arena = this.matchOpts.arena;
      msg.goalsToWin = this.matchOpts.goalsToWin;
      msg.timeLimit = this.matchOpts.timeLimit || 0;
      msg.ballStyle = this.matchOpts.ballStyle || 'normal';
      msg.numBalls = this.matchOpts.numBalls || 1;
      // Multi-ball: include extra balls
      if (this.extraBalls && this.extraBalls.length) {
        msg.extraBalls = this.extraBalls.map(b => ({ x: Math.round(b.x*10)/10, y: Math.round(b.y*10)/10 }));
      }
    } else {
      msg.currentHole = this.currentHole;
      msg.totalHoles = this.golfOpts.courseLength;
    }
    this.broadcast(msg);
  }

  sendLobbyState() {
    const playerList = [];
    for (const p of this.players.values()) {
      playerList.push({
        id: p.id, name: p.name, color: p.color, team: p.team,
        isHost: p.id === this.hostId, isBot: !!p.isBot,
      });
    }
    this.broadcast({
      type: 'lobby',
      code: this.code,
      mode: this.mode,
      players: playerList,
      hostId: this.hostId,
      matchOpts: this.matchOpts,
      golfOpts: this.golfOpts,
    });
  }

  stop() {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
    this.state = 'finished';
  }
}

// ============== ROOM REGISTRY ==============
const rooms = new Map();
const playerRooms = new Map(); // playerId -> roomCode

function createRoom(hostId, mode, opts) {
  let code;
  do { code = genRoomCode(); } while (rooms.has(code));
  const room = new Room(code, hostId, mode, opts);
  rooms.set(code, room);
  return room;
}

// Cleanup empty/dead rooms periodically
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.players.size === 0 || (Date.now() - room.lastActivity) > 30 * 60 * 1000) {
      room.stop();
      rooms.delete(code);
    }
  }
}, 60000);

// ============== HTTP SERVER (static files) ==============
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const httpServer = http.createServer((req, res) => {
  // Handle non-GET cleanly
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }

  // Health check (Render uses this; also useful for debugging)
  if (url.pathname === '/health' || url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (p.includes('..')) { res.writeHead(400); return res.end(); }
  const filePath = path.join(PUBLIC, p);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
    } else {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(data);
    }
  });
});

httpServer.on('error', (err) => {
  console.error('HTTP server error:', err);
  process.exit(1);
});

// ============== WEBSOCKET SERVER ==============
const wss = new WebSocketServer({ server: httpServer });
let nextPlayerId = 1;

wss.on('connection', (ws) => {
  const playerId = String(nextPlayerId++);
  let currentRoom = null;
  let alive = true;

  ws.on('pong', () => { alive = true; });
  const pingInterval = setInterval(() => {
    if (!alive) { try { ws.terminate(); } catch(e){} return; }
    alive = false;
    try { ws.ping(); } catch(e){}
  }, 30000);

  ws.send(JSON.stringify({ type: 'welcome', playerId }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
      case 'createRoom': {
        if (currentRoom) leaveRoom();
        const room = createRoom(playerId, msg.mode || 'match', msg.opts || {});
        room.addPlayer(playerId, ws, msg.name);
        playerRooms.set(playerId, room.code);
        currentRoom = room;
        ws.send(JSON.stringify({ type: 'roomCreated', code: room.code }));
        room.sendLobbyState();
        break;
      }
      case 'joinRoom': {
        if (currentRoom) leaveRoom();
        const code = (msg.code || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          break;
        }
        if (room.state !== 'lobby') {
          ws.send(JSON.stringify({ type: 'error', message: 'Game already in progress' }));
          break;
        }
        if (room.players.size >= 6) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
          break;
        }
        room.addPlayer(playerId, ws, msg.name);
        playerRooms.set(playerId, room.code);
        currentRoom = room;
        ws.send(JSON.stringify({ type: 'roomJoined', code: room.code }));
        room.sendLobbyState();
        break;
      }
      case 'updateOpts': {
        if (!currentRoom || currentRoom.hostId !== playerId) break;
        if (currentRoom.mode === 'match' && msg.matchOpts) {
          if (msg.matchOpts.arena && arenas[msg.matchOpts.arena]) currentRoom.matchOpts.arena = msg.matchOpts.arena;
          if (msg.matchOpts.goalsToWin) currentRoom.matchOpts.goalsToWin = clamp(parseInt(msg.matchOpts.goalsToWin), 1, 20);
          if (msg.matchOpts.timeLimit !== undefined) currentRoom.matchOpts.timeLimit = clamp(parseInt(msg.matchOpts.timeLimit) || 0, 0, 1800);
          if (msg.matchOpts.botDifficulty && ['easy','normal','hard'].includes(msg.matchOpts.botDifficulty)) {
            currentRoom.matchOpts.botDifficulty = msg.matchOpts.botDifficulty;
          }
          if (msg.matchOpts.ballStyle && ['normal','bouncy','ice'].includes(msg.matchOpts.ballStyle)) {
            currentRoom.matchOpts.ballStyle = msg.matchOpts.ballStyle;
          }
          if (msg.matchOpts.numBalls !== undefined) {
            currentRoom.matchOpts.numBalls = clamp(parseInt(msg.matchOpts.numBalls) || 1, 1, 3);
          }
        }
        if (currentRoom.mode === 'golf' && msg.golfOpts) {
          // Cap to existing fixed-course count when in fixed mode; allow up to 18 for random.
          if (msg.golfOpts.courseLength) {
            const max = currentRoom.golfOpts.randomCourses ? 18 : courses.length;
            currentRoom.golfOpts.courseLength = clamp(parseInt(msg.golfOpts.courseLength), 1, max);
          }
          if (msg.golfOpts.randomCourses !== undefined) currentRoom.golfOpts.randomCourses = !!msg.golfOpts.randomCourses;
        }
        currentRoom.sendLobbyState();
        break;
      }
      case 'startGame': {
        if (!currentRoom || currentRoom.hostId !== playerId) break;
        currentRoom.start();
        currentRoom.broadcast({ type: 'gameStart', mode: currentRoom.mode });
        if (currentRoom.mode === 'golf') {
          currentRoom.broadcast({ type: 'newHole', hole: 0, holeData: currentRoom.activeCourses[0] });
        }
        break;
      }
      case 'setTeam': {
        if (!currentRoom || currentRoom.mode !== 'match' || currentRoom.state !== 'lobby') break;
        const p = currentRoom.players.get(playerId);
        if (!p) break;
        const t = msg.team === 'blue' ? 'blue' : (msg.team === 'red' ? 'red' : null);
        if (!t) break;
        p.team = t;
        currentRoom.sendLobbyState();
        break;
      }
      case 'autoBalance': {
        if (!currentRoom || currentRoom.hostId !== playerId) break;
        if (currentRoom.mode !== 'match' || currentRoom.state !== 'lobby') break;
        const ids = [...currentRoom.players.keys()].sort();
        ids.forEach((id, i) => {
          const p = currentRoom.players.get(id);
          if (p) p.team = i % 2 === 0 ? 'red' : 'blue';
        });
        currentRoom.sendLobbyState();
        break;
      }
      case 'addBot': {
        if (!currentRoom || currentRoom.hostId !== playerId) break;
        if (currentRoom.state !== 'lobby') break;
        currentRoom.addBot();
        currentRoom.sendLobbyState();
        break;
      }
      case 'removeBot': {
        if (!currentRoom || currentRoom.hostId !== playerId) break;
        if (currentRoom.state !== 'lobby') break;
        currentRoom.removeBot(String(msg.id || ''));
        currentRoom.sendLobbyState();
        break;
      }
      case 'transferHost': {
        if (!currentRoom || currentRoom.hostId !== playerId) break;
        const targetId = String(msg.toId || '');
        if (!currentRoom.players.has(targetId)) break;
        currentRoom.hostId = targetId;
        currentRoom.sendLobbyState();
        break;
      }
      case 'rematch': {
        if (!currentRoom || currentRoom.hostId !== playerId) break;
        if (currentRoom.mode !== 'match') break;
        // Allow rematch from finished or lobby state.
        if (currentRoom.state === 'playing') break;
        currentRoom.stop();
        currentRoom.state = 'lobby';
        currentRoom.start();
        currentRoom.broadcast({ type: 'gameStart', mode: currentRoom.mode });
        break;
      }
      case 'input': {
        if (!currentRoom || currentRoom.state !== 'playing') break;
        currentRoom.setInput(playerId, msg.input || {});
        break;
      }
      case 'leaveRoom': {
        leaveRoom();
        break;
      }
      case 'chat': {
        if (!currentRoom) break;
        const text = String(msg.text || '').slice(0, 200);
        if (!text) break;
        const p = currentRoom.players.get(playerId);
        if (!p) break;
        currentRoom.broadcast({ type: 'chat', name: p.name, color: p.color, text });
        break;
      }
    }
  });

  function leaveRoom() {
    if (!currentRoom) return;
    const leaver = currentRoom.players.get(playerId);
    const wasPlaying = currentRoom.state === 'playing';
    const leaverName = leaver ? leaver.name : null;
    const empty = currentRoom.removePlayer(playerId);
    if (empty) {
      currentRoom.stop();
      rooms.delete(currentRoom.code);
    } else {
      if (wasPlaying && leaverName) {
        currentRoom.broadcast({ type: 'playerLeft', name: leaverName });
      }
      currentRoom.sendLobbyState();
    }
    playerRooms.delete(playerId);
    currentRoom = null;
  }

  ws.on('close', () => {
    clearInterval(pingInterval);
    leaveRoom();
  });
  ws.on('error', () => {});
});

// Global crash handlers so failures show up in logs instead of silent exits
process.on('uncaughtException', (err) => {
  console.error('FATAL: uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('FATAL: unhandledRejection', err);
  process.exit(1);
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Hexball server listening on 0.0.0.0:${PORT}`);
  console.log(`Node ${process.version}, public dir: ${PUBLIC}`);
  // Sanity: can we read index.html at boot?
  fs.access(path.join(PUBLIC, 'index.html'), fs.constants.R_OK, (err) => {
    if (err) console.error('WARN: cannot read public/index.html ->', err.message);
    else console.log('public/index.html is readable');
  });
});
