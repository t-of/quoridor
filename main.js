import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

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

// mode: 'cpu'（CPU と対戦）/ 'pvp'（2人）/ 'watch'（CPU 同士）/ 'demo'（ホームに飾る盤。触れない）
function newGame(mode) {
  state = {
    mode,
    pos: [[8, 4], [0, 4]],         // 0: 自分（下端中央、ゴールは行 0）／1: 相手（上端中央、ゴールは行 8）
    wallsLeft: [START_WALLS, START_WALLS],
    walls: new Set(),
    turn: 0,
    sel: null,                     // 選んだ溝 { o, a, b }（壁置きの 1 つ目）
    over: false,
    winner: null,
  };
}

// ホームに飾る、対局の途中の盤
function demoGame() {
  newGame('demo');
  state.pos = [[5, 3], [3, 5]];
  state.walls = new Set(['h:4:2', 'h:5:5', 'v:6:1', 'h:2:3', 'v:2:5']);
  state.wallsLeft = [7, 8];
}

function isCpu(p) { return state.mode === 'watch' || (state.mode === 'cpu' && p === 1); }

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
  state.sel = null;
}

function doWall(pIdx, orient, r, c) {
  state.walls.add(wallSpan(orient, r, c)[1]);
  state.wallsLeft[pIdx] -= 1;
  state.turn = 1 - state.turn;
  state.sel = null;
  playTone(220, 0.07);
}

// ---- CPU（ai.js を Worker で動かす。反復深化のαβ探索＋置換表。UI を止めないよう別スレッドで考える） ----

const cpu = new Worker('./ai.js', { type: 'module' });
let cpuAsk = 0; // 対局をやり直したあとに、前の局の答えが届いても使わない

function cpuTurn() {
  if (state.over) return;
  const game = state;
  const id = ++cpuAsk;
  cpu.onmessage = (e) => {
    if (e.data.id !== cpuAsk || state !== game) return;
    const a = e.data.action;
    if (a.type === 'move') doMove(game.turn, [a.r, a.c]);
    else doWall(game.turn, a.orient, a.r, a.c);
    render();
    afterTurn();
  };
  cpu.postMessage({
    id,
    pos: state.pos,
    wallsLeft: state.wallsLeft,
    walls: [...state.walls],
    turn: state.turn,
    timeMs: state.mode === 'watch' ? 900 : 1500,
  });
}

function afterTurn() {
  const game = state;
  if (!state.over && isCpu(state.turn)) {
    setTimeout(() => { if (state === game) cpuTurn(); }, 450);
  }
}

// ---- 描画（盤は three.js の 3D、情報欄だけ DOM） ----

const $start = document.getElementById('start');
const $game = document.getElementById('game');
const $result = document.getElementById('result');
const $board3d = document.getElementById('board3d');
const $wallsTop = document.getElementById('wallsTop');
const $wallsBottom = document.getElementById('wallsBottom');
const $turnLabel = document.getElementById('turnLabel');
const $resultText = document.getElementById('resultText');

function playerLabel(p) {
  if (state.mode === 'cpu') return p === 0 ? 'あなた' : 'CPU ';
  if (state.mode === 'watch') return `CPU ${p + 1} `;
  return `プレイヤー${p + 1}`;
}

function render() {
  $wallsTop.textContent = state.wallsLeft[1];
  $wallsBottom.textContent = state.wallsLeft[0];
  $turnLabel.textContent = state.over ? '' : `${playerLabel(state.turn)}の番`;
  syncScene();

  if (state.over) {
    $resultText.textContent = state.mode === 'cpu' && state.winner === 1 ? 'CPU の勝ち' : `${playerLabel(state.winner)}の勝ち！`;
    $result.hidden = false;
  } else {
    $result.hidden = true;
  }
}

// ---- 操作（盤面の上のタップを判定するのは rules 側の関数のまま。入力元だけ 3D の raycaster） ----

// マスをタップ → 進む。隣り合う溝を 2 つ続けてタップ → その 2 つをふさぐ壁を置く。
// 2 つの溝が同じ線の上で隣り合っていれば、壁の向きと位置が 1 つに決まる。
function wallFromEdges(x, y) {
  if (x.o !== y.o) return null;
  if (x.o === 'v' && x.b === y.b && Math.abs(x.a - y.a) === 1) return { orient: 'v', r: Math.min(x.a, y.a), c: x.b };
  if (x.o === 'h' && x.a === y.a && Math.abs(x.b - y.b) === 1) return { orient: 'h', r: x.a, c: Math.min(x.b, y.b) };
  return null;
}

function tapCell(r, c) {
  if (state.over || state.mode === 'demo' || isCpu(state.turn)) return;
  const ok = legalMoves(state.walls, state.pos, state.turn).some(([i, j]) => i === r && j === c);
  if (ok) {
    doMove(state.turn, [r, c]);
    render();
    afterTurn();
  } else if (state.sel) {
    state.sel = null;
    render();
  }
}

function tapEdge(o, a, b) {
  if (state.over || state.mode === 'demo' || isCpu(state.turn)) return;
  const has = o === 'v' ? (state.walls.has(`v:${a}:${b}`) || state.walls.has(`v:${a - 1}:${b}`)) : (state.walls.has(`h:${a}:${b}`) || state.walls.has(`h:${a}:${b - 1}`));
  if (state.wallsLeft[state.turn] <= 0 || has) return;
  const edge = { o, a, b };
  const sel = state.sel;
  const w = sel && wallFromEdges(sel, edge);
  if (w && wallLegal(state.walls, state.pos, w.orient, w.r, w.c)) {
    doWall(state.turn, w.orient, w.r, w.c);
    render();
    afterTurn();
    return;
  }
  // 同じ溝なら選び直し、それ以外（離れている・置けない）はこの溝を 1 つ目にする
  state.sel = sel && sel.o === edge.o && sel.a === edge.a && sel.b === edge.b ? null : edge;
  render();
}

// ---- 3D の木の盤（three.js）。ドラッグで回す、ピンチで寄る ----
// 9x9 のマスと、マスの間を彫った溝（壁置き場）。壁は溝に差し込む板として立体で置く。
const CELL = 0.5;                 // マスの一辺
const GAP = 0.12;                 // マスの間の溝の幅
const PITCH = CELL + GAP;
const BOARD_SIZE = N * PITCH - GAP;
const pos1d = (i) => (i - 4) * PITCH;           // マス i（0..8）の中心座標
const edgePos = (i) => (i - 4 + 0.5) * PITCH;   // 境界 i/i+1（0..7）の中心座標

const canvas = document.createElement('canvas');
canvas.className = 'board3d__canvas';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
camera.position.set(0, 7.2, 6.7);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.minDistance = 5;
controls.maxDistance = 16;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // 盤の下にはもぐらない
controls.target.set(0, 0.3, 0);
controls.update();
controls.addEventListener('change', draw);

// 影は付けない。環境光（RoomEnvironment）と弱い向きの光で質感を出す
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a2e24, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 8, 4);
scene.add(sun);

// 木目（灰色の濃淡）。色はマテリアルの color で付ける
function woodTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = (y + 9 * Math.sin((2 * Math.PI * x) / S * 2) + 3 * Math.sin((2 * Math.PI * x) / S * 7)) / S;
      const ring = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * t * 14), 6);
      const v = 255 * (0.9 - 0.16 * ring + (Math.random() - 0.5) * 0.05);
      const p = (y * S + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
const GRAIN = woodTexture();
const wood = (color, o = {}) => new THREE.MeshPhysicalMaterial({
  color, map: GRAIN, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.7, side: THREE.DoubleSide, ...o,
});

const board = new THREE.Mesh(new RoundedBoxGeometry(BOARD_SIZE + 0.3, 0.36, BOARD_SIZE + 0.3, 4, 0.14), wood(0x6a4329, { clearcoat: 0.5 }));
board.position.y = -0.18;
scene.add(board);

const DESK = new THREE.Group(); // 机の天板と盤の影。ホームでは消す
scene.add(DESK);
// ---- 机の天板。盤の下に木の板を敷き、地平線まで続ける ----
{
  const box = new THREE.Box3().setFromObject(board);
  const w = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  const S = 1024, PLANK = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  ['#4b3121', '#432b1c', '#503524', '#472f1f'].forEach((col, i) => {
    for (let y = i * PLANK; y < S; y += PLANK * 4) {
      g.save();
      g.beginPath(); g.rect(0, y, S, PLANK); g.clip();
      g.fillStyle = col; g.fillRect(0, y, S, PLANK);
      for (let k = 0; k < 36; k++) { // 木目の線
        const y0 = y + Math.random() * PLANK, a = 2 + Math.random() * 4, f = 60 + Math.random() * 120;
        g.strokeStyle = `rgba(24, 12, 4, ${0.06 + Math.random() * 0.14})`;
        g.lineWidth = 0.5 + Math.random() * 2;
        g.beginPath();
        for (let x = 0; x <= S; x += 16) g.lineTo(x, y0 + a * Math.sin(x / f + k));
        g.stroke();
      }
      g.restore();
      g.fillStyle = 'rgba(0, 0, 0, 0.45)'; g.fillRect(0, y, S, 2); // 板のすき間
    }
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const FAR = 1500; // 地平線まで続いて見える広さ
  tex.repeat.set(FAR / (w * 3.2), FAR / (w * 3.2));
  const table = new THREE.Mesh(new THREE.PlaneGeometry(FAR, FAR),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, envMapIntensity: 0.4 }));
  table.rotation.x = -Math.PI / 2;
  table.position.y = box.min.y - 0.01;
  table.renderOrder = -1;
  DESK.add(table);
  // 盤の落とす影
  const sc = document.createElement('canvas');
  sc.width = sc.height = 256;
  const sg = sc.getContext('2d');
  const shade = sg.createRadialGradient(128, 128, 0, 128, 128, 128 * 0.48);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.55)'); shade.addColorStop(0.55, 'rgba(0, 0, 0, 0.4)'); shade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  sg.fillStyle = shade; sg.fillRect(0, 0, 256, 256);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(w * 3.2, w * 3.2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = box.min.y - 0.005;
  DESK.add(shadow);
}

// ホーム画面では盤を斜め上からの向きで止め、机を消して宙に浮かべる。対局に入ったら机を戻す
{
  const HOME_CAM = camera.position.clone();
  let wasHome = false;
  const watch = () => {
    const home = !!canvas.offsetParent && !!canvas.closest('.title, #homeBoard');
    if (home !== wasHome) {
      DESK.visible = controls.enabled = !home;
      camera.position.copy(HOME_CAM); controls.update(); draw();
      wasHome = home;
    }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

const COLOR = { cell: 0x4a2e1c, goal0: 0x5b4522, goal1: 0x33465a, legal: 0x3f8a4f, groove: 0x24160d, grooveSel: 0xffd35c, wall: 0x8a5a34 };

// 81 マス。立ち入れるマス 1 枚ずつが独立したメッシュ（タップの当たり判定も兼ねる）
const cellGeo = new RoundedBoxGeometry(CELL, 0.03, CELL, 2, 0.03);
const cellMeshes = [];
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    const m = new THREE.Mesh(cellGeo, wood(COLOR.cell, { roughness: 0.7, clearcoat: 0 }));
    m.position.set(pos1d(c), 0.015, pos1d(r));
    m.userData = { type: 'cell', r, c };
    scene.add(m);
    cellMeshes.push(m);
  }
}

// 溝（壁置き場）。縦の溝は行ごとに 1 区画、横の溝は列ごとに 1 区画。2 つ並べて壁になる
const GROOVE_MAT = () => new THREE.MeshStandardMaterial({ color: COLOR.groove, roughness: 0.9 });
const vGrooveGeo = new THREE.BoxGeometry(GAP + 0.08, 0.025, CELL * 0.92);
const hGrooveGeo = new THREE.BoxGeometry(CELL * 0.92, 0.025, GAP + 0.08);
const vEdgeMeshes = [];
for (let i = 0; i < N; i++) {
  for (let c = 0; c < N - 1; c++) {
    const m = new THREE.Mesh(vGrooveGeo, GROOVE_MAT());
    m.position.set(edgePos(c), 0.01, pos1d(i));
    m.userData = { type: 'edge', o: 'v', a: i, b: c };
    scene.add(m);
    vEdgeMeshes.push(m);
  }
}
const hEdgeMeshes = [];
for (let r = 0; r < N - 1; r++) {
  for (let j = 0; j < N; j++) {
    const m = new THREE.Mesh(hGrooveGeo, GROOVE_MAT());
    m.position.set(pos1d(j), 0.01, edgePos(r));
    m.userData = { type: 'edge', o: 'h', a: r, b: j };
    scene.add(m);
    hEdgeMeshes.push(m);
  }
}
const EDGE_MESHES = [...vEdgeMeshes, ...hEdgeMeshes];
const RAYCAST_TARGETS = [...cellMeshes, ...EDGE_MESHES];

// 壁板：溝 2 区画ぶんをまたいで差し込まれた木の板
const WALL_LEN = 2 * CELL + GAP;
const WALL_H = 0.34;
const vWallGeo = new THREE.BoxGeometry(GAP * 1.3, WALL_H, WALL_LEN);
const hWallGeo = new THREE.BoxGeometry(WALL_LEN, WALL_H, GAP * 1.3);
const WALL_MAT = wood(COLOR.wall, { roughness: 0.55, clearcoat: 0.3 });
let wallGroup = new THREE.Group();
scene.add(wallGroup);
function buildWalls() {
  scene.remove(wallGroup);
  wallGroup = new THREE.Group();
  for (const key of state.walls) {
    const [o, a, b] = key.split(':');
    const r = Number(a), c = Number(b);
    const m = new THREE.Mesh(o === 'v' ? vWallGeo : hWallGeo, WALL_MAT);
    if (o === 'v') m.position.set(edgePos(c), WALL_H / 2, (pos1d(r) + pos1d(r + 1)) / 2);
    else m.position.set((pos1d(c) + pos1d(c + 1)) / 2, WALL_H / 2, edgePos(r));
    wallGroup.add(m);
  }
  scene.add(wallGroup);
}

// コマ：木でできた駒型（台座＋軸＋頭）。0 は明るい木、1 は青く染めた木
const PIECE_WOOD = [wood(0xe8c98a), wood(0x3f6f95)];
function pieceMesh(player) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.08, 24), PIECE_WOOD[player]);
  base.position.y = 0.04;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.22, 16), PIECE_WOOD[player]);
  shaft.position.y = 0.19;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), PIECE_WOOD[player]);
  head.position.y = 0.4;
  g.add(base, shaft, head);
  return g;
}
let pieceGroup = new THREE.Group();
scene.add(pieceGroup);
function buildPieces() {
  scene.remove(pieceGroup);
  pieceGroup = new THREE.Group();
  for (let p = 0; p < 2; p++) {
    const [r, c] = state.pos[p];
    const m = pieceMesh(p);
    m.position.set(pos1d(c), 0.015, pos1d(r));
    pieceGroup.add(m);
  }
  scene.add(pieceGroup);
}

function syncScene() {
  const legal = (!isCpu(state.turn) && !state.over) ? legalMoves(state.walls, state.pos, state.turn) : [];
  const legalKeys = new Set(legal.map(([i, j]) => `${i},${j}`));
  for (const m of cellMeshes) {
    const { r, c } = m.userData;
    let color = COLOR.cell;
    if (r === 0) color = COLOR.goal0;
    else if (r === N - 1) color = COLOR.goal1;
    if (legalKeys.has(`${r},${c}`)) color = COLOR.legal;
    m.material.color.setHex(color);
  }
  const sel = state.sel;
  for (const m of EDGE_MESHES) {
    const { o, a, b } = m.userData;
    const has = o === 'v' ? (state.walls.has(`v:${a}:${b}`) || state.walls.has(`v:${a - 1}:${b}`)) : (state.walls.has(`h:${a}:${b}`) || state.walls.has(`h:${a}:${b - 1}`));
    const isSel = sel && sel.o === o && sel.a === a && sel.b === b;
    m.material.color.setHex(has ? COLOR.wall : isSel ? COLOR.grooveSel : COLOR.groove);
    m.visible = !has; // 壁が刺さっている溝は板の裏に隠れるので消す
  }
  buildWalls();
  buildPieces();
  draw();
}

function draw() { renderer.render(scene, camera); }
new ResizeObserver(() => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // 縦長の画面でも盤の横が切れないように、縦の画角を広げる
  camera.fov = w < h ? (2 * Math.atan(Math.tan((19 * Math.PI) / 180) * (h / w)) * 180) / Math.PI : 38;
  camera.updateProjectionMatrix();
  draw();
}).observe(canvas);

// 動かさずに離したらタップ（ドラッグは回転）
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  downAt = null;
  if (!state || state.over) return;
  const r = canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(RAYCAST_TARGETS, false)[0];
  if (!hit) return;
  const d = hit.object.userData;
  if (d.type === 'cell') tapCell(d.r, d.c);
  else tapEdge(d.o, d.a, d.b);
});

const $homeBtn = document.getElementById('homeBtn');

function startGame(mode) {
  newGame(mode);
  $start.hidden = true;
  $game.hidden = false;
  $homeBtn.hidden = false;
  $board3d.appendChild(canvas);
  render();
  afterTurn();
}

function goHome() {
  demoGame();
  $start.hidden = false;
  $game.hidden = true;
  $result.hidden = true;
  $homeBtn.hidden = true;
  document.getElementById('homeBoard').appendChild(canvas);
  syncScene();
}

document.querySelectorAll('[data-start]').forEach((btn) => {
  btn.addEventListener('click', () => startGame(btn.dataset.start));
});
document.getElementById('againBtn').addEventListener('click', () => startGame(state.mode));
$homeBtn.addEventListener('click', goHome);
document.getElementById('resultHomeBtn').addEventListener('click', goHome);
goHome();

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
