'use strict';

WebAppKit.init({ title: 'quoridor', text: '9x9マスの盤で駒を進めるか壁を置いて相手を妨げ、先に向こう側の端へ着いたら勝ちの陣取りゲーム。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
// この試作にはオン・オフの設定はなく、常にオン固定（RULES.md 5 の「設定」を参照）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

// ---- ここからアプリ本体 ----

const N = 9;                 // 盤は 9x9
const START_WALLS = 10;      // 1 人あたりの壁の枚数

// ---- 盤のルール（壁・経路） ----
// 壁は交点 (r,c)（r,c は 0..7）に置く。横壁 'h:r:c' は行 r/r+1 の、列 c と c+1 の間をふさぐ。
// 縦壁 'v:r:c' は列 c/c+1 の、行 r と r+1 の間をふさぐ。

function blocked(walls, i, j, ni, nj) {
  if (ni === i && nj === j + 1) return walls.has(`v:${i}:${j}`) || walls.has(`v:${i - 1}:${j}`);
  if (ni === i && nj === j - 1) return walls.has(`v:${i}:${j - 1}`) || walls.has(`v:${i - 1}:${j - 1}`);
  if (ni === i + 1 && nj === j) return walls.has(`h:${i}:${j}`) || walls.has(`h:${i}:${j - 1}`);
  if (ni === i - 1 && nj === j) return walls.has(`h:${i - 1}:${j}`) || walls.has(`h:${i - 1}:${j - 1}`);
  return true;
}

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const PERP = { '-1,0': [[0, -1], [0, 1]], '1,0': [[0, -1], [0, 1]], '0,-1': [[-1, 0], [1, 0]], '0,1': [[-1, 0], [1, 0]] };
const inBounds = (i, j) => i >= 0 && i < N && j >= 0 && j < N;

// 駒を動かせる先（飛び越え・斜めを含む）。pIdx のコマから見た合法手の一覧を返す。
function legalMoves(walls, pos, pIdx) {
  const [i, j] = pos[pIdx];
  const [oi, oj] = pos[1 - pIdx];
  const out = new Map();
  for (const [di, dj] of DIRS) {
    const ni = i + di, nj = j + dj;
    if (!inBounds(ni, nj) || blocked(walls, i, j, ni, nj)) continue;
    if (ni === oi && nj === oj) {
      const ji = ni + di, jj = nj + dj;
      if (inBounds(ji, jj) && !blocked(walls, ni, nj, ji, jj)) {
        out.set(`${ji},${jj}`, [ji, jj]);
      } else {
        for (const [pi, pj] of PERP[`${di},${dj}`]) {
          const si = ni + pi, sj = nj + pj;
          if (inBounds(si, sj) && !(si === i && sj === j) && !blocked(walls, ni, nj, si, sj)) {
            out.set(`${si},${sj}`, [si, sj]);
          }
        }
      }
    } else {
      out.set(`${ni},${nj}`, [ni, nj]);
    }
  }
  return [...out.values()];
}

// 壁だけを見た最短距離（相手のコマは無視する。駒はどかせるものなので経路判定には含めない）。
function bfsDist(walls, start, goalRow) {
  const seen = new Set([`${start[0]},${start[1]}`]);
  let frontier = [start];
  let dist = 0;
  while (frontier.length) {
    for (const [i, j] of frontier) if (i === goalRow) return dist;
    const next = [];
    for (const [i, j] of frontier) {
      for (const [di, dj] of DIRS) {
        const ni = i + di, nj = j + dj;
        if (!inBounds(ni, nj) || blocked(walls, i, j, ni, nj)) continue;
        const k = `${ni},${nj}`;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push([ni, nj]);
      }
    }
    frontier = next;
    dist += 1;
  }
  return Infinity;
}

function wallSpan(orient, r, c) {
  return orient === 'h' ? [`h:${r}:${c - 1}`, `h:${r}:${c}`, `h:${r}:${c + 1}`] : [`v:${r - 1}:${c}`, `v:${r}:${c}`, `v:${r + 1}:${c}`];
}

// 置けるか（枠・重なり・交差・両者の道が残るか）
function wallLegal(walls, pos, orient, r, c) {
  if (r < 0 || r > 7 || c < 0 || c > 7) return false;
  const [near, self, far] = wallSpan(orient, r, c);
  if (walls.has(self) || walls.has(near) || walls.has(far)) return false;
  if (walls.has(orient === 'h' ? `v:${r}:${c}` : `h:${r}:${c}`)) return false;
  const next = new Set(walls);
  next.add(self);
  return bfsDist(next, pos[0], 0) < Infinity && bfsDist(next, pos[1], 8) < Infinity;
}

function allLegalWalls(walls, pos) {
  const out = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      for (const orient of ['h', 'v']) {
        if (wallLegal(walls, pos, orient, r, c)) out.push({ orient, r, c });
      }
    }
  }
  return out;
}

// ---- 対局の状態 ----

let state = null;

function newGame(vsCpu) {
  state = {
    vsCpu,
    pos: [[8, 4], [0, 4]],         // 0: 自分（下端中央、ゴールは行 0）／1: 相手（上端中央、ゴールは行 8）
    wallsLeft: [START_WALLS, START_WALLS],
    walls: new Set(),
    turn: 0,
    preview: null,                 // { orient, r, c }
    over: false,
    winner: null,
  };
}

function goalRow(pIdx) { return pIdx === 0 ? 0 : 8; }

function doMove(pIdx, to) {
  state.pos[pIdx] = to;
  if (to[0] === goalRow(pIdx)) {
    state.over = true;
    state.winner = pIdx;
    playWin();
  } else {
    playTone(440, 0.05);
    state.turn = 1 - state.turn;
  }
  state.preview = null;
}

function doWall(pIdx, orient, r, c) {
  state.walls.add(wallSpan(orient, r, c)[1]);
  state.wallsLeft[pIdx] -= 1;
  state.turn = 1 - state.turn;
  state.preview = null;
  playTone(220, 0.07);
}

// ---- CPU（簡単: 相手が自分より近ければ、相手の最短路を一番伸ばす壁。なければ自分の最短路を進む） ----

function cpuTurn() {
  if (state.over) return;
  const cpuDist = bfsDist(state.walls, state.pos[1], 8);
  const playerDist = bfsDist(state.walls, state.pos[0], 0);
  if (state.wallsLeft[1] > 0 && playerDist < cpuDist) {
    const candidates = allLegalWalls(state.walls, state.pos);
    let best = null, bestGain = 0;
    for (const w of candidates) {
      const next = new Set(state.walls);
      next.add(wallSpan(w.orient, w.r, w.c)[1]);
      const gain = bfsDist(next, state.pos[0], 0) - playerDist;
      if (gain > bestGain || (gain === bestGain && gain > 0 && Math.random() < 0.3)) { best = w; bestGain = gain; }
    }
    if (best && bestGain > 0) {
      doWall(1, best.orient, best.r, best.c);
      render();
      return;
    }
  }
  const moves = legalMoves(state.walls, state.pos, 1);
  let best = moves[0], bestDist = Infinity;
  for (const m of moves) {
    const d = bfsDist(state.walls, m, 8);
    if (d < bestDist || (d === bestDist && Math.random() < 0.4)) { best = m; bestDist = d; }
  }
  doMove(1, best);
  render();
}

function afterTurn() {
  if (!state.over && state.vsCpu && state.turn === 1) {
    setTimeout(cpuTurn, 450);
  }
}

// ---- 描画 ----

const $start = document.getElementById('start');
const $game = document.getElementById('game');
const $result = document.getElementById('result');
const $board = document.getElementById('board');
const $wallsTop = document.getElementById('wallsTop');
const $wallsBottom = document.getElementById('wallsBottom');
const $turnLabel = document.getElementById('turnLabel');
const $resultText = document.getElementById('resultText');

function track(i) { return i * 2 + 1; } // 0 始まりの盤目盛り i → グリッドの何本目か（1 始まり）

function render() {
  $wallsTop.textContent = state.wallsLeft[1];
  $wallsBottom.textContent = state.wallsLeft[0];
  const myTurn = !state.vsCpu || state.turn === 0;
  $turnLabel.textContent = state.over ? '' : (state.vsCpu ? (state.turn === 0 ? 'あなたの番' : 'CPU の番') : (state.turn === 0 ? 'プレイヤー1の番' : 'プレイヤー2の番'));

  const legal = (myTurn && !state.over) ? legalMoves(state.walls, state.pos, state.turn) : [];
  const legalKeys = new Set(legal.map(([i, j]) => `${i},${j}`));

  let html = '';
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const classes = ['cell'];
      if (i === 0) classes.push('goal0');
      if (i === N - 1) classes.push('goal1');
      if (legalKeys.has(`${i},${j}`)) classes.push('legal');
      let inner = '';
      if (state.pos[0][0] === i && state.pos[0][1] === j) inner = '<span class="piece p0"></span>';
      else if (state.pos[1][0] === i && state.pos[1][1] === j) inner = '<span class="piece p1"></span>';
      html += `<div class="${classes.join(' ')}" style="grid-row:${track(i)};grid-column:${track(j)}" data-r="${i}" data-c="${j}">${inner}</div>`;
    }
  }
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 8; c++) { // 縦の溝（壁は横向きにここを埋める）
      const has = state.walls.has(`v:${i}:${c}`) || state.walls.has(`v:${i - 1}:${c}`);
      const prev = previewCovers('v', i, c, 'col');
      html += `<div class="gap${has ? ' wall' : prev}" style="grid-row:${track(i)};grid-column:${track(c) + 1}"></div>`;
    }
  }
  for (let r = 0; r < 8; r++) {
    for (let j = 0; j < N; j++) { // 横の溝
      const has = state.walls.has(`h:${r}:${j}`) || state.walls.has(`h:${r}:${j - 1}`);
      const prev = previewCovers('h', r, j, 'row');
      html += `<div class="gap${has ? ' wall' : prev}" style="grid-row:${track(r) + 1};grid-column:${track(j)}"></div>`;
    }
  }
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) { // 交点（壁を置くタップ対象）
      html += `<div class="gap xpt" style="grid-row:${track(r) + 1};grid-column:${track(c) + 1}" data-x="${r},${c}"></div>`;
    }
  }
  $board.innerHTML = html;

  if (state.over) {
    $resultText.textContent = state.vsCpu
      ? (state.winner === 0 ? 'あなたの勝ち！' : 'CPU の勝ち')
      : `プレイヤー${state.winner + 1}の勝ち！`;
    $result.hidden = false;
  } else {
    $result.hidden = true;
  }
}

// 壁のプレビュー（その溝がプレビュー中の壁に含まれるかどうかの表示クラス）
function previewCovers(orient, idx, pos, axis) {
  if (!state.preview || state.preview.orient !== orient) return '';
  const { r, c } = state.preview;
  const covered = orient === 'v'
    ? (axis === 'col' && pos === c && (idx === r || idx === r + 1))
    : (axis === 'row' && idx === r && (pos === c || pos === c + 1));
  if (!covered) return '';
  const ok = wallLegal(state.walls, state.pos, orient, r, c);
  return ok ? ' preview-ok' : ' preview';
}

// ---- 操作 ----

// マスをタップ → 進む。交点をタップ → 壁の仮置き、同じ交点をもう一度 → 向きを変える、すばやく 2 回 → 置く。
// dblclick は iOS で来ないことがあるので、同じ交点への 350ms 以内の 2 回目を自分で見る。
let lastTap = null; // { key, at, before }（before: 1 回目のタップの前に出ていた仮置き）

$board.addEventListener('click', (e) => {
  if (state.over) return;
  const myTurn = !state.vsCpu || state.turn === 0;
  if (!myTurn) return;
  const cellEl = e.target.closest('[data-r]');
  const xEl = e.target.closest('[data-x]');
  if (xEl) {
    if (state.wallsLeft[state.turn] <= 0) return;
    const [r, c] = xEl.dataset.x.split(',').map(Number);
    const key = xEl.dataset.x;
    const now = performance.now();
    if (lastTap && lastTap.key === key && now - lastTap.at < 350) {
      // 2 回目のタップ: 1 回目で向きを変えていたら戻してから置く
      const orient = lastTap.before && lastTap.before.r === r && lastTap.before.c === c ? lastTap.before.orient : state.preview.orient;
      lastTap = null;
      if (wallLegal(state.walls, state.pos, orient, r, c)) {
        doWall(state.turn, orient, r, c);
        render();
        afterTurn();
      } else {
        state.preview = { orient, r, c };
        render();
      }
      return;
    }
    lastTap = { key, at: now, before: state.preview };
    if (state.preview && state.preview.r === r && state.preview.c === c) {
      state.preview = { orient: state.preview.orient === 'v' ? 'h' : 'v', r, c };
    } else {
      // 新しい交点: 縦が置けなければ横を出す
      const orient = !wallLegal(state.walls, state.pos, 'v', r, c) && wallLegal(state.walls, state.pos, 'h', r, c) ? 'h' : 'v';
      state.preview = { orient, r, c };
    }
    render();
  } else if (cellEl) {
    const r = Number(cellEl.dataset.r), c = Number(cellEl.dataset.c);
    const ok = legalMoves(state.walls, state.pos, state.turn).some(([i, j]) => i === r && j === c);
    if (ok) {
      doMove(state.turn, [r, c]);
      render();
      afterTurn();
    } else if (state.preview) {
      state.preview = null;
      render();
    }
  }
});

document.querySelectorAll('[data-start]').forEach((btn) => {
  btn.addEventListener('click', () => {
    newGame(btn.dataset.start === 'cpu');
    $start.hidden = true;
    $game.hidden = false;
    $result.hidden = true;
    render();
  });
});

document.getElementById('againBtn').addEventListener('click', () => {
  newGame(state.vsCpu);
  render();
});

// ---- 効果音（Web Audio。マナーモードでも鳴らす） ----

let audioCtx = null;
function ensureAudio() {
  if (audioCtx) return audioCtx;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    setAudioSession(true);
  } catch { /* 対応していない */ }
  return audioCtx;
}
document.addEventListener('pointerdown', ensureAudio, { once: true });

function playTone(freq, dur) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  gain.gain.value = 0.08;
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + dur);
}
function playWin() {
  playTone(440, 0.12);
  setTimeout(() => playTone(660, 0.18), 120);
}
