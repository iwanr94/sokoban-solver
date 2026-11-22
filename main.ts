// Sokoban solver, round 2 — room-decomposed push-optimal A*.
//
// A level is a hallway with one to four rooms off it, and a box pushed
// through a door into the hallway can never be pushed back, so every box
// stays in its room and the level's push-optimum is the sum of its rooms'
// optima. This solver splits each level into its rooms, solves every room
// with A* over pushes (admissible assignment heuristic, dead-square /
// corner / 2x2 / freeze pruning), and stitches the rooms together with
// hallway walks. Node 22, standard library only, deterministic: no clock,
// no randomness, every search bounded by a node count, never by time.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// [dx, dy, letter] in a fixed order, so every BFS walk is deterministic.
const DIRS = [[0, -1, 'u'], [0, 1, 'd'], [-1, 0, 'l'], [1, 0, 'r']];

// Work budgets (node counts, never wall time, so runs are reproducible).
const ROOM_NODE_CAP = 1000000;
const LEVEL_NODE_CAP = 2000000;
let budgetLeft = 8000000;

// Scratch buffers reused across searches (single-threaded, synchronous;
// every caller uses them immediately, never across another search call).
let SCRATCH_SEEN = new Uint8Array(1024);
let SCRATCH_Q = new Int32Array(1024);
let SCRATCH_BOX_CUR = new Uint8Array(1024);
let SCRATCH_BOX_NEW = new Uint8Array(1024);
let SCRATCH_FROZEN = new Uint8Array(1024);
function ensureScratch(N) {
  if (SCRATCH_SEEN.length < N) {
    SCRATCH_SEEN = new Uint8Array(N);
    SCRATCH_Q = new Int32Array(N);
    SCRATCH_BOX_CUR = new Uint8Array(N);
    SCRATCH_BOX_NEW = new Uint8Array(N);
    SCRATCH_FROZEN = new Uint8Array(N);
  }
}

// All permutations of [0..n-1] for n = 1..4, for the assignment heuristic.
const PERMS = (() => {
  const out = {};
  for (let n = 1; n <= 4; n++) {
    const arr = [...Array(n).keys()];
    const res = [];
    const gen = (k) => {
      if (k === n) { res.push(arr.slice()); return; }
      for (let i = k; i < n; i++) {
        const t = arr[k]; arr[k] = arr[i]; arr[i] = t;
        gen(k + 1);
        arr[i] = arr[k]; arr[k] = t;
      }
    };
    gen(0);
    out[n] = res;
  }
  return out;
})();

function parseLevel(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const H = lines.length;
  let W = 0;
  for (const l of lines) if (l.length > W) W = l.length;
  const wall = new Uint8Array(W * H).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = lines[y][x] ?? '#';
      const p = y * W + x;
      if (c !== '#') wall[p] = 0;
      if (c === '.' || c === '*' || c === '+') goals.push(p);
      if (c === '$' || c === '*') boxes.push(p);
      if (c === '@' || c === '+') player = p;
    }
  }
  boxes.sort((a, b) => a - b);
  return { W, H, wall, goals, boxes, player };
}

// Breadth-first distances over walkable cells, ignoring boxes.
function bfsDist(W, H, walkable, src) {
  const N = W * H;
  const dist = new Int32Array(N).fill(-1);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  dist[src] = 0;
  q[qt++] = src;
  while (qh < qt) {
    const c = q[qh++];
    const d = dist[c] + 1;
    const x = c % W, y = (c / W) | 0;
    if (x > 0) { const n = c - 1; if (walkable[n] && dist[n] < 0) { dist[n] = d; q[qt++] = n; } }
    if (x + 1 < W) { const n = c + 1; if (walkable[n] && dist[n] < 0) { dist[n] = d; q[qt++] = n; } }
    if (y > 0) { const n = c - W; if (walkable[n] && dist[n] < 0) { dist[n] = d; q[qt++] = n; } }
    if (y + 1 < H) { const n = c + W; if (walkable[n] && dist[n] < 0) { dist[n] = d; q[qt++] = n; } }
  }
  return dist;
}

// Cells the player can walk to from `from`, treating boxes as walls.
// Returns a reused scratch buffer: use it immediately, before any other
// search call.
function reachable(W, H, walkable, boxSet, from) {
  const N = W * H;
  ensureScratch(N);
  const seen = SCRATCH_SEEN;
  const q = SCRATCH_Q;
  seen.fill(0);
  let qh = 0, qt = 0;
  seen[from] = 1;
  q[qt++] = from;
  while (qh < qt) {
    const c = q[qh++];
    const x = c % W, y = (c / W) | 0;
    if (x > 0) { const n = c - 1; if (walkable[n] && !boxSet[n] && !seen[n]) { seen[n] = 1; q[qt++] = n; } }
    if (x + 1 < W) { const n = c + 1; if (walkable[n] && !boxSet[n] && !seen[n]) { seen[n] = 1; q[qt++] = n; } }
    if (y > 0) { const n = c - W; if (walkable[n] && !boxSet[n] && !seen[n]) { seen[n] = 1; q[qt++] = n; } }
    if (y + 1 < H) { const n = c + W; if (walkable[n] && !boxSet[n] && !seen[n]) { seen[n] = 1; q[qt++] = n; } }
  }
  return seen;
}

// Shortest walk from `from` to `to` (boxes are walls), as a move string.
function walkPath(W, H, walkable, boxSet, from, to) {
  if (from === to) return '';
  const N = W * H;
  const prev = new Int32Array(N).fill(-1);
  const prevCh = new Array(N).fill('');
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  prev[from] = from;
  q[qt++] = from;
  while (qh < qt) {
    const c = q[qh++];
    if (c === to) break;
    const x = c % W, y = (c / W) | 0;
    for (const [dx, dy, ch] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const n = ny * W + nx;
      if (!walkable[n] || boxSet[n] || prev[n] >= 0) continue;
      prev[n] = c;
      prevCh[n] = ch;
      q[qt++] = n;
    }
  }
  if (prev[to] < 0) return null;
  let s = '';
  let c = to;
  while (c !== from) { s = prevCh[c] + s; c = prev[c]; }
  return s;
}

// Cells a box can sit on and still be pushed to some goal (ignoring other
// boxes): reverse pull-reachability from the goals. A box anywhere else is
// dead, whatever the other boxes do.
function computeLive(W, H, walkable, goals) {
  const N = W * H;
  const live = new Uint8Array(N);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (const g of goals) { live[g] = 1; q[qt++] = g; }
  while (qh < qt) {
    const b = q[qh++];
    const bx = b % W, by = (b / W) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = bx + dx, ny = by + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const n = ny * W + nx;
      if (!walkable[n] || live[n]) continue;
      const px = nx + dx, py = ny + dy;
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      if (!walkable[py * W + px]) continue;
      live[n] = 1;
      q[qt++] = n;
    }
  }
  return live;
}

// Admissible push heuristic: cheapest assignment of boxes to goals by
// box-ignoring distance. Every push moves one box one cell, so the pushes
// still needed are at least this sum.
function heuristic(boxes, distFromGoal, goalCount) {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n === goalCount && n <= 4) {
    let best = Infinity;
    for (const perm of PERMS[n]) {
      let cost = 0;
      for (let i = 0; i < n; i++) {
        const d = distFromGoal[perm[i]][boxes[i]];
        if (d < 0) { cost = Infinity; break; }
        cost += d;
        if (cost >= best) break;
      }
      if (cost < best) best = cost;
    }
    return best;
  }
  let s = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (let g = 0; g < goalCount; g++) {
      const d = distFromGoal[g][b];
      if (d >= 0 && d < m) m = d;
    }
    if (m === Infinity) return Infinity;
    s += m;
  }
  return s;
}

// Whether a box can be pushed right now in any direction.
function canPushNow(W, H, walkable, boxSet, b) {
  const x = b % W, y = (b / W) | 0;
  for (const [dx, dy] of DIRS) {
    const nx = x + dx, ny = y + dy, fx = x - dx, fy = y - dy;
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
    if (fx < 0 || fx >= W || fy < 0 || fy >= H) continue;
    if (walkable[ny * W + nx] && !boxSet[ny * W + nx] && walkable[fy * W + fx] && !boxSet[fy * W + fx]) return true;
  }
  return false;
}

// Deadlock tests on a box configuration: dead square, corner, 2x2 block,
// frozen box (a box that can never move again, by fixpoint). boxSet marks
// the boxes in a caller-owned scratch buffer.
function isDead(W, H, walkable, live, goalSet, boxes, boxSet) {
  for (const b of boxes) {
    if (goalSet.has(b)) continue;
    if (!live[b]) return true;
    const x = b % W, y = (b / W) | 0;
    const up = y > 0 && walkable[b - W];
    const down = y + 1 < H && walkable[b + W];
    const left = x > 0 && walkable[b - 1];
    const right = x + 1 < W && walkable[b + 1];
    if ((!up && !left) || (!up && !right) || (!down && !left) || (!down && !right)) return true;
  }
  // 2x2 blocks of wall-or-box with no goal inside.
  for (const b of boxes) {
    if (goalSet.has(b)) continue;
    const x = b % W, y = (b / W) | 0;
    for (const [tx, ty] of [[x, y], [x - 1, y], [x, y - 1], [x - 1, y - 1]]) {
      if (tx < 0 || tx + 1 >= W || ty < 0 || ty + 1 >= H) continue;
      let allBlocked = true;
      let hasGoal = false;
      for (const [cx, cy] of [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]]) {
        const c = cy * W + cx;
        if (goalSet.has(c)) hasGoal = true;
        if (walkable[c] && !boxSet[c]) { allBlocked = false; break; }
      }
      if (allBlocked && !hasGoal) return true;
    }
  }
  // Frozen boxes, by fixpoint: a box is frozen when every push direction
  // is blocked by a wall or by another frozen box (a box that may still
  // move does not count as blocking). Only boxes that cannot move right
  // now can be frozen, so the fixpoint is skipped when all boxes move.
  let anyImmobile = false;
  for (const b of boxes) {
    if (goalSet.has(b)) continue;
    if (!canPushNow(W, H, walkable, boxSet, b)) { anyImmobile = true; break; }
  }
  if (!anyImmobile) return false;
  const frozen = SCRATCH_FROZEN;
  frozen.fill(0);
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of boxes) {
      if (goalSet.has(b) || frozen[b]) continue;
      const x = b % W, y = (b / W) | 0;
      let canMove = false;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy, fx = x - dx, fy = y - dy;
        const destBlocked = nx < 0 || nx >= W || ny < 0 || ny >= H || !walkable[ny * W + nx] || frozen[ny * W + nx];
        const stanceBlocked = fx < 0 || fx >= W || fy < 0 || fy >= H || !walkable[fy * W + fx] || frozen[fy * W + fx];
        if (!destBlocked && !stanceBlocked) { canMove = true; break; }
      }
      if (!canMove) { frozen[b] = 1; changed = true; }
    }
  }
  for (const b of boxes) if (frozen[b] && !goalSet.has(b)) return true;
  return false;
}

// A* over pushes. doorCell >= 0 means the goal also requires the player to
// be able to walk back to that cell afterwards. Returns the push-optimal
// solution, or null when none is found inside the node cap.
function searchPush(W, H, walkable, goals, startPlayer, startBoxes, nodeCap, doorCell, numeric) {
  const N = W * H;
  ensureScratch(N);
  const goalSet = new Set(goals);
  const distFromGoal = goals.map((g) => bfsDist(W, H, walkable, g));
  const live = computeLive(W, H, walkable, goals);
  const h0 = heuristic(startBoxes, distFromGoal, goals.length);
  if (h0 === Infinity) return null;
  // Tie-break inside an f plateau: smaller h first (closer to a goal
  // state by the heuristic); insertion order after that.
  const cmp = (a, b) => (a.f - b.f) || (a.h - b.h) || (a.cnt - b.cnt);
  const heap = [];
  const heapPush = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmp(heap[p], heap[i]) <= 0) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && cmp(heap[l], heap[m]) < 0) m = l;
        if (r < heap.length && cmp(heap[r], heap[m]) < 0) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
        i = m;
      }
    }
    return top;
  };
  // State key: a base-N number when the state space fits in a safe
  // integer (rooms: <= 4 boxes), a string otherwise (whole level).
  const keyOf = numeric
    ? (player, boxes) => { let k = player; for (const b of boxes) k = k * N + b; return k; }
    : (player, boxes) => player + '|' + boxes.join(',');
  const startKey = keyOf(startPlayer, startBoxes);
  const bestG = new Map();
  const parent = new Map();
  bestG.set(startKey, 0);
  let counter = 0;
  heapPush({ f: h0, h: h0, cnt: counter++, key: startKey, player: startPlayer, boxes: startBoxes.slice(), g: 0 });
  let expansions = 0;
  while (heap.length) {
    const cur = heapPop();
    if (cur.g !== bestG.get(cur.key)) continue;
    const solved = cur.boxes.every((b) => goalSet.has(b));
    if (solved) {
      let doorOk = true;
      if (doorCell >= 0) {
        const bs = SCRATCH_BOX_CUR;
        bs.fill(0);
        for (const b of cur.boxes) bs[b] = 1;
        doorOk = reachable(W, H, walkable, bs, cur.player)[doorCell] === 1;
      }
      if (doorOk) {
        const pushes = [];
        let k = cur.key;
        while (parent.has(k)) {
          const e = parent.get(k);
          pushes.push({ box: e.box, dir: e.dir });
          k = e.pk;
        }
        pushes.reverse();
        let moves = '';
        let player = startPlayer;
        const boxes = startBoxes.slice();
        for (const { box, dir } of pushes) {
          const [dx, dy, ch] = DIRS[dir];
          const from = box - dy * W - dx;
          const bs = SCRATCH_BOX_CUR;
          bs.fill(0);
          for (const b of boxes) bs[b] = 1;
          const w = walkPath(W, H, walkable, bs, player, from);
          if (w === null) return null;
          moves += w + ch;
          player = box;
          boxes[boxes.indexOf(box)] = box + dy * W + dx;
          boxes.sort((a, b) => a - b);
        }
        return { pushes: pushes.length, moves, endPlayer: player, endBoxes: boxes };
      }
    }
    if (expansions >= nodeCap || budgetLeft <= 0) return null;
    expansions++;
    budgetLeft--;
    const boxSet = SCRATCH_BOX_CUR;
    boxSet.fill(0);
    for (const b of cur.boxes) boxSet[b] = 1;
    const reach = reachable(W, H, walkable, boxSet, cur.player);
    for (let bi = 0; bi < cur.boxes.length; bi++) {
      const b = cur.boxes[bi];
      const bx = b % W, by = (b / W) | 0;
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = DIRS[d];
        const fx = bx - dx, fy = by - dy;
        const nx = bx + dx, ny = by + dy;
        if (fx < 0 || fx >= W || fy < 0 || fy >= H) continue;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const from = fy * W + fx, dest = ny * W + nx;
        if (!walkable[dest] || boxSet[dest]) continue;
        if (!reach[from]) continue;
        const nb = cur.boxes.slice();
        nb[bi] = dest;
        nb.sort((a, c) => a - c);
        const g = cur.g + 1;
        const key = keyOf(b, nb);
        if (bestG.has(key) && bestG.get(key) <= g) continue;
        const nbs = SCRATCH_BOX_NEW;
        nbs.fill(0);
        for (const x of nb) nbs[x] = 1;
        if (isDead(W, H, walkable, live, goalSet, nb, nbs)) continue;
        const h = heuristic(nb, distFromGoal, goals.length);
        if (h === Infinity) continue;
        bestG.set(key, g);
        parent.set(key, { pk: cur.key, box: b, dir: d });
        heapPush({ f: g + h, h, cnt: counter++, key, player: b, boxes: nb, g });
      }
    }
  }
  return null;
}

// Split a level into rooms: connected floor off the hallway row (the row
// the player starts on). Each room opens onto the hallway through one door.
function findRooms(L) {
  const { W, H, wall, player } = L;
  const hy = (player / W) | 0;
  const seen = new Uint8Array(W * H);
  const rooms = [];
  const stack = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (y === hy || wall[p] || seen[p]) continue;
      const cells = [];
      stack.length = 0;
      stack.push(p);
      seen[p] = 1;
      while (stack.length) {
        const c = stack.pop();
        cells.push(c);
        const cx = c % W, cy = (c / W) | 0;
        if (cx > 0) { const n = c - 1; if (!wall[n] && ((n / W) | 0) !== hy && !seen[n]) { seen[n] = 1; stack.push(n); } }
        if (cx + 1 < W) { const n = c + 1; if (!wall[n] && ((n / W) | 0) !== hy && !seen[n]) { seen[n] = 1; stack.push(n); } }
        if (cy > 0) { const n = c - W; if (!wall[n] && ((n / W) | 0) !== hy && !seen[n]) { seen[n] = 1; stack.push(n); } }
        if (cy + 1 < H) { const n = c + W; if (!wall[n] && ((n / W) | 0) !== hy && !seen[n]) { seen[n] = 1; stack.push(n); } }
      }
      let door = -1;
      for (const c of cells) {
        const cy = (c / W) | 0, cx = c % W;
        if (Math.abs(cy - hy) === 1 && !wall[hy * W + cx]) { door = c; break; }
      }
      rooms.push({ cells, set: new Set(cells), door, approach: door >= 0 ? hy * W + (door % W) : -1 });
    }
  }
  return rooms;
}

// Whole-level fallback: one A* over the entire level.
function solveWholeLevel(L) {
  const { W, H, wall, goals, boxes, player } = L;
  const walkable = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) walkable[i] = wall[i] ? 0 : 1;
  const sol = searchPush(W, H, walkable, goals, player, boxes, LEVEL_NODE_CAP, -1, false);
  return sol ? sol.moves : '';
}

function solveLevel(text) {
  const L = parseLevel(text);
  const { W, H, wall, goals, boxes, player } = L;
  if (boxes.length === 0) return '';
  const rooms = findRooms(L);
  const inRoom = new Uint8Array(W * H);
  let ok = rooms.length > 0;
  for (const r of rooms) {
    if (r.door < 0) { ok = false; break; }
    for (const c of r.cells) inRoom[c] = 1;
  }
  if (ok) {
    for (const b of boxes) if (!inRoom[b]) { ok = false; break; }
    for (const g of goals) if (!inRoom[g]) { ok = false; break; }
  }
  if (!ok) return solveWholeLevel(L);
  const fullWalkable = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) fullWalkable[i] = wall[i] ? 0 : 1;
  const solved = [];
  for (const r of rooms) {
    const walkable = new Uint8Array(W * H);
    for (const c of r.cells) walkable[c] = 1;
    walkable[r.door] = 1;
    walkable[r.approach] = 1;
    const rBoxes = boxes.filter((b) => r.set.has(b)).sort((a, b) => a - b);
    const rGoals = goals.filter((g) => r.set.has(g));
    if (rBoxes.length !== rGoals.length) return solveWholeLevel(L);
    const sol0 = searchPush(W, H, walkable, rGoals, r.approach, rBoxes, ROOM_NODE_CAP, -1, true);
    if (!sol0) return solveWholeLevel(L);
    const endSet = new Uint8Array(W * H);
    for (const b of sol0.endBoxes) endSet[b] = 1;
    const canExit = reachable(W, H, walkable, endSet, sol0.endPlayer)[r.door] === 1;
    if (canExit) {
      solved.push({ room: r, free: sol0, loose: sol0, gap: 0 });
      continue;
    }
    const sol1 = searchPush(W, H, walkable, rGoals, r.approach, rBoxes, ROOM_NODE_CAP, r.door, true);
    if (!sol1) {
      solved.push({ room: r, free: null, loose: sol0, gap: Infinity });
    } else {
      solved.push({ room: r, free: sol1, loose: sol0, gap: sol1.pushes - sol0.pushes });
    }
  }
  const mustLast = solved.filter((s) => s.free === null);
  if (mustLast.length > 1) return solveWholeLevel(L);
  // The room solved last may use its unconstrained (possibly trapped)
  // solution: pick the one whose door-constrained cost is highest.
  let lastRoom = mustLast.length === 1 ? mustLast[0] : null;
  if (!lastRoom) {
    let bestGap = 0;
    for (const s of solved) if (s.gap > bestGap) { bestGap = s.gap; lastRoom = s; }
  }
  const order = solved
    .filter((s) => s !== lastRoom)
    .sort((a, b) => (a.room.door % W) - (b.room.door % W) || ((a.room.door / W) | 0) - ((b.room.door / W) | 0));
  if (lastRoom) order.push(lastRoom);
  let moves = '';
  let curPlayer = player;
  const curBoxes = boxes.slice();
  for (const s of order) {
    const use = s === lastRoom ? s.loose : s.free;
    const bs = new Uint8Array(W * H);
    for (const b of curBoxes) bs[b] = 1;
    const walk = walkPath(W, H, fullWalkable, bs, curPlayer, s.room.approach);
    if (walk === null) return solveWholeLevel(L);
    moves += walk + use.moves;
    curPlayer = use.endPlayer;
    // The room's boxes are now at their final spots; every other box is
    // untouched. Rebuild the box list from those two parts.
    const kept = curBoxes.filter((b) => !s.room.set.has(b));
    curBoxes.length = 0;
    for (const b of kept) curBoxes.push(b);
    for (const b of use.endBoxes) curBoxes.push(b);
    curBoxes.sort((a, b) => a - b);
  }
  return moves;
}

for (const id of readdirSync(INPUT).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
