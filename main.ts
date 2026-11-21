// Sokoban solver: push-optimal breadth-first search, one room at a time.
//
// The idea: a level is a hallway with one to four small rooms off it, and a box
// pushed out of its room can never come back, so each room is solved on its own
// and the rooms' push counts add up to the level's optimum. Inside a room the
// search walks over pushes, not steps: a state is the boxes' squares plus the
// player's reachable region (named by its lowest square), every push costs one,
// and the first solved state the queue meets is push-optimal.
//
// Deadlock pruning: a box on a square from which no sequence of pushes can
// reach a goal (found by pulling boxes backwards from the goals), and a box
// caught in a frozen 2x2 block of walls and boxes, are both cut at once.
//
// The budget is a count of states, never the clock, so two runs write the same
// bytes. Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search keeps before it gives up. Work, never the clock. */
const MAX_STATES = 250_000;

/** The four steps: dx, dy, the walk letter, the push letter. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

type Room = {
  boxes: number[];
  goals: number[];
  done: boolean;
};

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player). */
function parseBoard(text: string): Board {
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
  // The outer frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares a box can stand on and still be pushed onto some goal: pull the
 * boxes backwards from the goals, one push at a time. A box pulled from x to
 * y needs y open and the square behind it open, where the player would stand
 * to push it forward again. Other boxes are ignored, so this never calls a
 * solvable square dead.
 */
function liveCells(b: Board): Uint8Array {
  const { w, wall, goals } = b;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      const behind = y - d;
      if (y < 0 || y >= wall.length || behind < 0 || behind >= wall.length) continue;
      if (wall[y] || wall[behind] || live[y]) continue;
      live[y] = 1;
      queue.push(y);
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` with `occupied` in the way,
 * marked in `seen` with `stamp`; returns the lowest square of the region.
 */
function floodLow(b: Board, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = b;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const [dx, dy] = DIRS[k];
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || seen[q] === stamp) continue;
      seen[q] = stamp;
      stack[n++] = q;
    }
  }
  return low;
}

/** Whether the box just pushed onto `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(b: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = b;
  const filled = (i: number): boolean => i >= 0 && i < wall.length && (wall[i] === 1 || occupied[i] === 1);
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c = a + 1;
    const d = a + w;
    const e = d + 1;
    if (!filled(a) || !filled(c) || !filled(d) || !filled(e)) continue;
    if ((occupied[a] && !goal[a]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d]) || (occupied[e] && !goal[e])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (u first on ties). */
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = b;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal solution of one board: {pushes, moves} (moves in LURD, a
 * lower letter a step, an upper one a push), or null when the search gives up.
 * Breadth-first over pushes, so the first solved state met is optimal.
 */
function solveRoom(board: Board): { pushes: number; moves: string } | null {
  const { w, wall, goals } = board;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveCells(board);
  const solved = (bs: number[]): boolean => bs.every((x) => goal[x]);
  if (board.boxes.some((b) => !live[b])) return null;
  if (solved(board.boxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // A state's key: the region's lowest square and the boxes' squares.
  const keyOf = (bs: number[], low: number): number => {
    let k = low;
    for (const b of bs) k = k * size + b;
    return k;
  };

  // The states in the order found: their boxes, the player's square, and the push that made them.
  const boxesList: number[][] = [board.boxes.slice()];
  const playerList: number[] = [board.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushDir: number[] = [-1];
  const known = new Set<number>();
  for (const b of board.boxes) occupied[b] = 1;
  known.add(keyOf(board.boxes, floodLow(board, occupied, board.player, seen, ++stamp, stack)));
  for (const b of board.boxes) occupied[b] = 0;

  let found = -1;
  for (let head = 0; found < 0 && head < boxesList.length; head++) {
    const boxes = boxesList[head];
    for (const b of boxes) occupied[b] = 1;
    floodLow(board, occupied, playerList[head], seen, ++stamp, stack);
    const region = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let dir = 0; dir < 4; dir++) {
        const [dx, dy] = DIRS[dir];
        const d = dy * w + dx;
        const t = b + d;
        const stand = b - d;
        if (stand < 0 || stand >= size || seen[stand] !== region) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(board, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, x) => a - x);
          key = keyOf(next, floodLow(board, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || known.has(key)) continue;
        if (boxesList.length >= MAX_STATES) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        known.add(key);
        boxesList.push(next);
        playerList.push(b);
        parent.push(head);
        pushFrom.push(b);
        pushDir.push(dir);
        if (solved(next)) {
          found = boxesList.length - 1;
          break;
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes.slice();
  for (const s of path) {
    const nextBoxes = boxesList[s];
    const from = pushFrom[s];
    const dir = pushDir[s];
    const [dx, dy, , pushLetter] = DIRS[dir];
    const d = dy * w + dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(board, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += pushLetter;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/**
 * The board's rooms: cut the hallway squares of the player's row that no box
 * can be pushed from onto a goal, and each part left that holds a box is a
 * room, its boxes and goals. A room keeps its door square and the live
 * hallway squares outside it, so a box that starts on the door still belongs
 * to its room. Null when some part holds more or fewer boxes than goals, or
 * a box starts in the cut hallway: then the board is no set of rooms.
 */
function roomsOf(board: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = board;
  const live = liveCells(board);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The board solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the board's: {pushes,
 * moves}, or null when a room's search gives up, or the board is no set of
 * rooms and the search over the whole board gives up.
 */
function solveByRooms(board: Board): { pushes: number; moves: string } | null {
  const rooms = roomsOf(board);
  if (rooms === null) return solveRoom(board);
  let player = board.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = board.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Board = {
      w: board.w,
      h: board.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solveRoom(sub);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(board.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

function solve(text: string): string {
  const res = solveByRooms(parseBoard(text));
  return res === null ? '' : res.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
