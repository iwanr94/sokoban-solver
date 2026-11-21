// rooms-bfs-1.0.0: a push-optimal Sokoban solver for sokoban-solver-01.
//
// Every level this set draws is a one-square hallway with rooms off it, each room a small level of its own that a box
// can never leave (a push through a door lands the box in the hallway, where nothing can push it back). A level's
// push-optimal count is therefore the sum of its rooms' optima, so the solver cuts the level into rooms and solves each
// room on its own with a breadth-first search over pushes, which is push-optimal by construction. Dead squares, frozen
// 2 x 2 blocks and boxes sealed against a wall run with no goal prune states no push could save, so the optimum stands.
// Every budget is a count of states, never the clock, so a run answers the same on every execution.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
/** The four directions: [dx, dy]. */
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STEP = ['u', 'd', 'l', 'r'];
const PUSH = ['U', 'D', 'L', 'R'];

/** A level: its width, walls (1 a wall), goals, boxes and player, all as square indices. */
type Level = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal), one row a line. */
function parse(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is a wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  if (player < 0) player = goals.length > 0 ? goals[0] : 0;
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares a box alone can still be pushed onto some goal from: pulled back from the goals over open floor. */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    if (!live[g]) {
      live[g] = 1;
      queue.push(g);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Mark every square the player reaches from `from` around walls and `occupied`, and return the lowest one. */
function reach(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** The shortest walk from `from` to `to` around walls and `occupied`, in lower LURD letters (direction order breaks ties). */
function walkTo(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: number[] = new Array(wall.length).fill(0);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = k;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return '';
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = STEP[how[p]!] + s;
  return s;
}

/**
 * Whether the box just pushed to `t` (not on a goal) is frozen in a 2 x 2 block of walls and boxes that holds a box off
 * its goal: the block can never move again, so the state is dead. A corner is caught earlier, as a dead square.
 */
function sealed(w: number, wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  for (let c = 0; c < 4; c++) {
    const a = t + ((c & 1) === 0 ? 0 : -1) + ((c & 2) === 0 ? 0 : -w);
    const b = a + 1;
    const d = a + w;
    const e = d + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[d] || occupied[d]) || !(wall[e] || occupied[e])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[d] && !goal[d]) || (occupied[e] && !goal[e])) return true;
  }
  return false;
}

/** The key of a state: the player region's lowest square, then the boxes' squares, in base `base`. */
function keyOf(boxes: number[], low: number, base: number): number {
  let k = low;
  for (const b of boxes) k = k * base + b;
  return k;
}

type Solved = { pushes: number; moves: string };

/**
 * The push-optimal solution of a (sub)level, breadth-first over pushes and their states (boxes plus the player's
 * reachable region), at most `maxStates` states kept: {pushes, moves} or null when it gives up or there is none.
 */
function solvePushOptimal(wall: Uint8Array, w: number, h: number, goals: number[], boxes: number[], player: number, maxStates: number): Solved | null {
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, wall, goals);
  if (boxes.some((b) => !live[b])) return null;
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const done = (bs: number[]): boolean => {
    for (const b of bs) if (!goal[b]) return false;
    return true;
  };
  const sBoxes: number[][] = [boxes.slice()];
  const sPlayer: number[] = [player];
  const parent: number[] = [-1];
  const index = new Map<number, number>();
  for (const b of boxes) occupied[b] = 1;
  index.set(keyOf(boxes, reach(w, wall, occupied, player, seen, ++stamp, stack), size), 0);
  for (const b of boxes) occupied[b] = 0;
  let found = done(boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < sBoxes.length; head++) {
    const bs = sBoxes[head]!;
    for (const b of bs) occupied[b] = 1;
    reach(w, wall, occupied, sPlayer[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < bs.length && found < 0; bi++) {
      const b = bs[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = DY[k]! * w + DX[k]!;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const dead = goal[t] ? false : sealed(w, wall, occupied, goal, t);
        let next: number[] | null = null;
        if (!dead) {
          next = bs.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
        }
        if (!dead && next !== null) {
          const key = keyOf(next, reach(w, wall, occupied, b, mark, ++stamp, stack), size);
          occupied[t] = 0;
          occupied[b] = 1;
          if (index.has(key)) continue;
          if (sBoxes.length >= maxStates) return null;
          index.set(key, sBoxes.length);
          sBoxes.push(next);
          sPlayer.push(b);
          parent.push(head);
          if (done(next)) found = sBoxes.length - 1;
        } else {
          occupied[t] = 0;
          occupied[b] = 1;
        }
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (found < 0) return null;
  // The states on the path, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let playerAt = player;
  let cur = boxes;
  for (const s of path) {
    const nextBoxes = sBoxes[s]!;
    let from = -1;
    let to = -1;
    for (const b of cur) if (!nextBoxes.includes(b)) from = b;
    for (const b of nextBoxes) if (!cur.includes(b)) to = b;
    const d = to - from;
    let k = 0;
    for (let q = 0; q < 4; q++) if (DY[q]! * w + DX[q]! === d) k = q;
    for (const b of cur) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, playerAt, from - d);
    for (const b of cur) occupied[b] = 0;
    moves += PUSH[k]!;
    playerAt = from;
    cur = nextBoxes;
  }
  return { pushes: path.length, moves };
}

type Room = { squares: number[]; boxes: number[]; goals: number[]; done?: boolean };

/**
 * The level cut into rooms: the hallway (the player's row, where no box can reach a goal) is cut out of the floor, and
 * each part left that holds a box is a room with its boxes and goals. Null when the level is not such a set of rooms, or
 * some part holds a different number of boxes and goals.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  for (const b of boxes) if (cut[b]) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let qi = 0; qi < squares.length; qi++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[qi]! + DY[k]! * w + DX[k]!;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]!]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  for (const r of rooms) if (r.boxes.length !== r.goals.length) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The square the player stands on after `moves` (LURD, any case) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' || ch === 'U' ? -w : ch === 'd' || ch === 'D' ? w : ch === 'l' || ch === 'L' ? -1 : 1;
  return p;
}

/** The pushes in `moves` and whether they leave every box on a goal; null when a step is illegal. */
function replay(level: Level, moves: string): { pushes: number; solved: boolean } | null {
  const { w, wall, goals } = level;
  const goal = new Uint8Array(wall.length);
  for (const g of goals) goal[g] = 1;
  const box = new Uint8Array(wall.length);
  let n = 0;
  for (const b of level.boxes) {
    box[b] = 1;
    n++;
  }
  let p = level.player;
  let pushes = 0;
  for (const ch of moves.toLowerCase()) {
    const k = ch === 'u' ? 0 : ch === 'd' ? 1 : ch === 'l' ? 2 : ch === 'r' ? 3 : -1;
    if (k < 0) return null;
    const d = DY[k]! * w + DX[k]!;
    const q = p + d;
    if (wall[q]) return null;
    if (box[q]) {
      const t = q + d;
      if (wall[t] || box[t]) return null;
      box[q] = 0;
      box[t] = 1;
      pushes++;
    }
    p = q;
  }
  let solved = true;
  for (let i = 0; i < wall.length; i++) if (box[i] && !goal[i]) solved = false;
  return { pushes, solved };
}

/**
 * The level solved room by room, each room push-optimally with the other rooms' boxes standing as walls, the player
 * walking on from where the last room left it. Every budget is a count of states; `budget` is the set's shared one.
 */
function solveLevel(level: Level, budget: { left: number }): Solved | null {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const mine = Math.min(budget.left, 900_000);
    const one = solvePushOptimal(level.wall, level.w, level.h, level.goals, level.boxes, level.player, mine);
    budget.left -= mine;
    return one;
  }
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done === true ? other.goals : other.boxes) wall[b] = 1;
    }
    const goals = room.goals.slice().sort((a, b) => a - b);
    const boxes = room.boxes.slice().sort((a, b) => a - b);
    let one = solvePushOptimal(wall, level.w, level.h, goals, boxes, player, Math.min(budget.left, 400_000));
    if (one === null) one = solvePushOptimal(wall, level.w, level.h, goals, boxes, player, Math.min(budget.left, 2_000_000));
    if (one === null) return null;
    pushes += one.pushes;
    moves += one.moves;
    player = endOf(level.w, player, one.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** Answer one level: its moves when they replay to every box on a goal, else an empty answer. */
function solve(text: string, budget: { left: number }): { moves: string; pushes: number } {
  const level = parse(text);
  const got = solveLevel(level, budget);
  if (got === null) return { moves: '', pushes: -1 };
  const check = replay(level, got.moves);
  if (check === null || !check.solved) return { moves: '', pushes: -1 };
  return { moves: got.moves, pushes: check.pushes };
}

const budget = { left: 6_000_000 };
for (const id of readdirSync(I).sort()) {
  const text = readFileSync(join(I, id, 'level.txt'), 'utf8');
  const answer = solve(text, budget);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), answer.moves.length > 0 ? `${answer.moves}\n` : '\n');
  process.stdout.write(`${id} ${answer.pushes}\n`);
}
