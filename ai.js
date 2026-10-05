// コリドールの CPU（Web Worker）。反復深化の negamax（αβ）＋置換表。
// 壁は 'h:r:c' / 'v:r:c' の文字列ではなく、r*8+c で引ける Uint8Array 2本（水平・垂直）で持つ
// （main.js の盤表現とはここだけ違う。postMessage で文字列の配列として受け渡し、ここで変換する）。
//
// 評価値は「相手の最短距離 − 自分の最短距離」に残り壁の差を足したもの（手番側から見た値）。
// 壁の候補は 128 通り全部ではなく、両者の最短路のまわり（半径 WALL_RADIUS）だけに絞る
// （wallLegal の判定にも使う最短路 BFS をそのまま流用）。
//
// ponytail: 深い読み（ply > WALL_PLY_LIMIT）では壁を検討せず駒の動きだけを読む。
// 壁の読みはその場の 1〜2 手先まで、そこから先は駒の競争として読む簡略化。
// 弱点を感じたら WALL_PLY_LIMIT を上げる（探索コストは壁候補の分だけ重くなる）。

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const PERP = { '-1,0': [[0, -1], [0, 1]], '1,0': [[0, -1], [0, 1]], '0,-1': [[-1, 0], [1, 0]], '0,1': [[-1, 0], [1, 0]] };
const ORIENTS = ['h', 'v'];
const WIN = 10000;
const WALL_PLY_LIMIT = 2;
const WALL_RADIUS = 2;

function goalRow(p) { return p === 0 ? 0 : 8; }

// ---- 盤の状態（1 回の bestMove 呼び出しのあいだ使い回す） ----
let pos = [[8, 4], [0, 4]];      // [[r,c],[r,c]]
let wallsLeft = [10, 10];
let hWall = new Uint8Array(64);  // h:r:c → hWall[r*8+c]
let vWall = new Uint8Array(64);  // v:r:c → vWall[r*8+c]

function hAt(r, c) { return (r < 0 || r > 7 || c < 0 || c > 7) ? 0 : hWall[r * 8 + c]; }
function vAt(r, c) { return (r < 0 || r > 7 || c < 0 || c > 7) ? 0 : vWall[r * 8 + c]; }
function setWall(orient, r, c, v) { if (orient === 'h') hWall[r * 8 + c] = v; else vWall[r * 8 + c] = v; }

function blocked(i, j, ni, nj) {
  if (ni === i && nj === j + 1) return vAt(i, j) || vAt(i - 1, j);
  if (ni === i && nj === j - 1) return vAt(i, j - 1) || vAt(i - 1, j - 1);
  if (ni === i + 1 && nj === j) return hAt(i, j) || hAt(i, j - 1);
  if (ni === i - 1 && nj === j) return hAt(i - 1, j) || hAt(i - 1, j - 1);
  return true;
}

// ---- 最短距離・最短路（Uint8Array の BFS キュー。文字列キーを使わない） ----
const visited = new Uint8Array(81);
const queueBuf = new Int16Array(81);
const parentBuf = new Int16Array(81);

function bfsDist(sr, sc, goalRowN) {
  if (sr === goalRowN) return 0;
  visited.fill(0);
  let head = 0, tail = 0, dist = 0, thisLayer = 1, nextLayer = 0;
  queueBuf[tail++] = sr * 9 + sc;
  visited[sr * 9 + sc] = 1;
  while (head < tail) {
    const cur = queueBuf[head++]; thisLayer--;
    const i = (cur / 9) | 0, j = cur % 9;
    for (const [di, dj] of DIRS) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || ni > 8 || nj < 0 || nj > 8 || blocked(i, j, ni, nj)) continue;
      const k = ni * 9 + nj;
      if (visited[k]) continue;
      visited[k] = 1;
      if (ni === goalRowN) return dist + 1;
      queueBuf[tail++] = k;
      nextLayer++;
    }
    if (thisLayer === 0) { dist++; thisLayer = nextLayer; nextLayer = 0; }
  }
  return Infinity;
}

// 任意の 1 本の最短路（マス列、start を含む）。候補の壁を絞るのに使うだけなので最短なら何でもよい。
function bfsPath(sr, sc, goalRowN) {
  const start = sr * 9 + sc;
  if (sr === goalRowN) return [[sr, sc]];
  visited.fill(0); parentBuf.fill(-1);
  let head = 0, tail = 0;
  queueBuf[tail++] = start;
  visited[start] = 1;
  while (head < tail) {
    const cur = queueBuf[head++];
    const i = (cur / 9) | 0, j = cur % 9;
    for (const [di, dj] of DIRS) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || ni > 8 || nj < 0 || nj > 8 || blocked(i, j, ni, nj)) continue;
      const k = ni * 9 + nj;
      if (visited[k]) continue;
      visited[k] = 1; parentBuf[k] = cur;
      if (ni === goalRowN) {
        const path = [];
        let c2 = k;
        for (;;) { path.push([(c2 / 9) | 0, c2 % 9]); if (c2 === start) break; c2 = parentBuf[c2]; }
        return path;
      }
      queueBuf[tail++] = k;
    }
  }
  return [[sr, sc]]; // 到達不能（本来起きない）
}

// 駒を動かせる先（main.js の legalMoves と同じ規則：飛び越え・斜めを含む）
function legalMoves(pIdx) {
  const [i, j] = pos[pIdx];
  const [oi, oj] = pos[1 - pIdx];
  const out = [];
  const seen = new Set();
  const push = (r, c) => { const k = r * 9 + c; if (!seen.has(k)) { seen.add(k); out.push([r, c]); } };
  for (const [di, dj] of DIRS) {
    const ni = i + di, nj = j + dj;
    if (ni < 0 || ni > 8 || nj < 0 || nj > 8 || blocked(i, j, ni, nj)) continue;
    if (ni === oi && nj === oj) {
      const ji = ni + di, jj = nj + dj;
      if (ji >= 0 && ji < 9 && jj >= 0 && jj < 9 && !blocked(ni, nj, ji, jj)) {
        push(ji, jj);
      } else {
        for (const [pi, pj] of PERP[`${di},${dj}`]) {
          const si = ni + pi, sj = nj + pj;
          if (si >= 0 && si < 9 && sj >= 0 && sj < 9 && !(si === i && sj === j) && !blocked(ni, nj, si, sj)) push(si, sj);
        }
      }
    } else {
      push(ni, nj);
    }
  }
  return out;
}

// ---- 壁の候補（全 128 通りではなく、両者の最短路の近く） ----
function wallOverlap(orient, r, c) {
  return orient === 'h' ? (hAt(r, c - 1) || hAt(r, c) || hAt(r, c + 1)) : (vAt(r - 1, c) || vAt(r, c) || vAt(r + 1, c));
}
function wallCross(orient, r, c) { return orient === 'h' ? vAt(r, c) : hAt(r, c); }

// 置けるなら一時的に置いて両者の距離を測り、すぐ外す（legal 判定と距離の取得を 1 回の BFS ペアで済ませる）
function tryWall(orient, r, c, mover, other) {
  if (r < 0 || r > 7 || c < 0 || c > 7 || wallOverlap(orient, r, c) || wallCross(orient, r, c)) return null;
  setWall(orient, r, c, 1);
  const dMover = bfsDist(pos[mover][0], pos[mover][1], goalRow(mover));
  const dOther = bfsDist(pos[other][0], pos[other][1], goalRow(other));
  setWall(orient, r, c, 0);
  if (dMover === Infinity || dOther === Infinity) return null;
  return { dMover, dOther };
}

function addAnchors(set, path, radius) {
  for (const [i, j] of path) {
    for (let r = i - radius; r <= i + radius; r++) {
      if (r < 0 || r > 7) continue;
      for (let c = j - radius; c <= j + radius; c++) {
        if (c < 0 || c > 7) continue;
        set.add(r * 8 + c);
      }
    }
  }
}

// mover から見て得な順（相手を遠ざけ、自分はあまり遠くならない壁ほど上位）に並べる
function genWallMoves(mover) {
  const other = 1 - mover;
  const pathMover = bfsPath(pos[mover][0], pos[mover][1], goalRow(mover));
  const pathOther = bfsPath(pos[other][0], pos[other][1], goalRow(other));
  const preMover = pathMover.length - 1, preOther = pathOther.length - 1;
  const anchors = new Set();
  addAnchors(anchors, pathMover, WALL_RADIUS);
  addAnchors(anchors, pathOther, WALL_RADIUS);
  const out = [];
  for (const key of anchors) {
    const r = (key / 8) | 0, c = key % 8;
    for (const orient of ORIENTS) {
      const res = tryWall(orient, r, c, mover, other);
      if (!res) continue;
      const gain = (res.dOther - preOther) - (res.dMover - preMover);
      out.push({ type: 'w', orient, r, c, gain });
    }
  }
  out.sort((a, b) => b.gain - a.gain);
  return out;
}

// ---- Zobrist ハッシュ（2 本の 32bit を合わせて Map のキーにする。quarto の ai.js と同じやり方） ----
const rnd = () => (Math.random() * 2 ** 32) >>> 0;
const Z1_POS = [Array.from({ length: 81 }, rnd), Array.from({ length: 81 }, rnd)];
const Z2_POS = [Array.from({ length: 81 }, rnd), Array.from({ length: 81 }, rnd)];
const Z1_H = Array.from({ length: 64 }, rnd), Z2_H = Array.from({ length: 64 }, rnd);
const Z1_V = Array.from({ length: 64 }, rnd), Z2_V = Array.from({ length: 64 }, rnd);
const Z1_WLEFT = [Array.from({ length: 11 }, rnd), Array.from({ length: 11 }, rnd)];
const Z2_WLEFT = [Array.from({ length: 11 }, rnd), Array.from({ length: 11 }, rnd)];
const Z1_TURN = rnd(), Z2_TURN = rnd();

let h1 = 0, h2 = 0;
function togglePos(p, r, c) { const i = r * 9 + c; h1 ^= Z1_POS[p][i]; h2 ^= Z2_POS[p][i]; }
function toggleWall(orient, idx) {
  if (orient === 'h') { h1 ^= Z1_H[idx]; h2 ^= Z2_H[idx]; } else { h1 ^= Z1_V[idx]; h2 ^= Z2_V[idx]; }
}
function toggleWLeft(p, n) { h1 ^= Z1_WLEFT[p][n]; h2 ^= Z2_WLEFT[p][n]; }
function keyFor(turn) {
  const k1 = turn ? (h1 ^ Z1_TURN) : h1;
  const k2 = turn ? (h2 ^ Z2_TURN) : h2;
  return (k1 >>> 0) * 2097152 + (k2 >>> 11);
}

function movePawn(mover, nr, nc) {
  const or = pos[mover][0], oc = pos[mover][1];
  togglePos(mover, or, oc);
  pos[mover][0] = nr; pos[mover][1] = nc;
  togglePos(mover, nr, nc);
  return [or, oc];
}
function undoMovePawn(mover, old) {
  togglePos(mover, pos[mover][0], pos[mover][1]);
  pos[mover][0] = old[0]; pos[mover][1] = old[1];
  togglePos(mover, old[0], old[1]);
}
function placeWall(orient, r, c, mover) {
  setWall(orient, r, c, 1);
  toggleWall(orient, r * 8 + c);
  toggleWLeft(mover, wallsLeft[mover]);
  wallsLeft[mover]--;
  toggleWLeft(mover, wallsLeft[mover]);
}
function removeWall(orient, r, c, mover) {
  toggleWLeft(mover, wallsLeft[mover]);
  wallsLeft[mover]++;
  toggleWLeft(mover, wallsLeft[mover]);
  toggleWall(orient, r * 8 + c);
  setWall(orient, r, c, 0);
}

function sameMove(m, tm) {
  if (!tm || m.type !== tm.type) return false;
  return m.type === 'm' ? (m.r === tm.r && m.c === tm.c) : (m.orient === tm.orient && m.r === tm.r && m.c === tm.c);
}

// ---- 探索 ----
function evaluate() {
  const d0 = bfsDist(pos[0][0], pos[0][1], 0);
  const d1 = bfsDist(pos[1][0], pos[1][1], 8);
  return (d1 - d0) * 10 + (wallsLeft[0] - wallsLeft[1]) * 2;
}

const tt = new Map(); // key → [depth, value, flag(0 正確/1 下限/2 上限), bestMove]
let nodes = 0, deadline = 0;
const TIMEOUT = Symbol('timeout');

function negamax(turn, depth, alpha, beta, ply) {
  if ((++nodes & 1023) === 0 && performance.now() > deadline) throw TIMEOUT;
  if (pos[0][0] === 0) return turn === 0 ? (WIN - ply) : -(WIN - ply);
  if (pos[1][0] === 8) return turn === 1 ? (WIN - ply) : -(WIN - ply);
  if (depth === 0) return (turn === 0 ? 1 : -1) * evaluate();

  const key = keyFor(turn);
  const e = tt.get(key);
  let ttMove = null;
  if (e) {
    if (e[0] >= depth) {
      if (e[2] === 0) return e[1];
      if (e[2] === 1 && e[1] >= beta) return e[1];
      if (e[2] === 2 && e[1] <= alpha) return e[1];
    }
    ttMove = e[3];
  }

  const other = 1 - turn;
  const moves = [];
  if (wallsLeft[turn] > 0 && ply <= WALL_PLY_LIMIT) moves.push(...genWallMoves(turn));
  const pawnMoves = legalMoves(turn).map(([r, c]) => ({ type: 'm', r, c, dist: bfsDist(r, c, goalRow(turn)) }));
  pawnMoves.sort((a, b) => a.dist - b.dist);
  moves.push(...pawnMoves);
  if (ttMove) {
    const i = moves.findIndex((m) => sameMove(m, ttMove));
    if (i > 0) { const [m] = moves.splice(i, 1); moves.unshift(m); }
  }

  const a0 = alpha;
  let best = -Infinity, bestMove = moves[0] || null;
  for (const m of moves) {
    const undo = m.type === 'm' ? movePawn(turn, m.r, m.c) : (placeWall(m.orient, m.r, m.c, turn), null);
    const v = -negamax(other, depth - 1, -beta, -alpha, ply + 1);
    if (m.type === 'm') undoMovePawn(turn, undo); else removeWall(m.orient, m.r, m.c, turn);
    if (v > best) { best = v; bestMove = m; }
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  tt.set(key, [depth, best, best <= a0 ? 2 : best >= beta ? 1 : 0, bestMove]);
  return best;
}

// input: { pos: [[r,c],[r,c]], wallsLeft: [n,n], walls: ['h:r:c', ...], turn: 0|1 }
export function bestMove(input, timeMs = 1500) {
  pos = [[input.pos[0][0], input.pos[0][1]], [input.pos[1][0], input.pos[1][1]]];
  wallsLeft = [input.wallsLeft[0], input.wallsLeft[1]];
  hWall = new Uint8Array(64); vWall = new Uint8Array(64);
  for (const edge of input.walls) {
    const [o, r, c] = edge.split(':');
    setWall(o, Number(r), Number(c), 1);
  }
  h1 = 0; h2 = 0;
  togglePos(0, pos[0][0], pos[0][1]);
  togglePos(1, pos[1][0], pos[1][1]);
  for (let idx = 0; idx < 64; idx++) {
    if (hWall[idx]) toggleWall('h', idx);
    if (vWall[idx]) toggleWall('v', idx);
  }
  toggleWLeft(0, wallsLeft[0]);
  toggleWLeft(1, wallsLeft[1]);

  tt.clear();
  nodes = 0;
  deadline = performance.now() + timeMs;
  const turn = input.turn;

  let result = null;
  for (let depth = 1; depth <= 81; depth++) {
    try {
      const v = negamax(turn, depth, -Infinity, Infinity, 0);
      const e = tt.get(keyFor(turn));
      if (e && e[3]) result = { move: e[3], value: v, depth };
      if (Math.abs(v) >= WIN - 80) break;
    } catch (err) {
      if (err !== TIMEOUT) throw err;
      break;
    }
  }
  if (!result) {
    // 時間切れで深さ 1 すら終わらなかったときの保険：自分の最短路を進む
    const moves = legalMoves(turn);
    let best = moves[0], bestDist = Infinity;
    for (const [r, c] of moves) { const d = bfsDist(r, c, goalRow(turn)); if (d < bestDist) { bestDist = d; best = [r, c]; } }
    result = { move: { type: 'm', r: best[0], c: best[1] } };
  }
  const m = result.move;
  return m.type === 'm' ? { type: 'move', r: m.r, c: m.c } : { type: 'wall', orient: m.orient, r: m.r, c: m.c };
}

if (typeof WorkerGlobalScope !== 'undefined') {
  self.onmessage = (e) => {
    const { id, pos: p, wallsLeft: wl, walls, turn, timeMs } = e.data;
    const action = bestMove({ pos: p, wallsLeft: wl, walls, turn }, timeMs);
    self.postMessage({ id, action });
  };
}
