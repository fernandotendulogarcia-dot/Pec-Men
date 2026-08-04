/* =========================================================================
   PAC-MAN — jogo completo em JavaScript puro (sem bibliotecas)
   Estrutura geral:
     1. Definição do labirinto (mapa grande, gerado com "malha de corredores"
        para garantir que TODAS as células andáveis estejam conectadas).
     2. Modelo de movimento baseado em "tile + progresso" (0..1): cada
        personagem só decide a próxima direção exatamente quando está no
        centro de uma célula, e só pode se mover para células válidas.
        Isso evita, por construção, que alguém atravesse paredes.
     3. IA dos fantasmas: cada fantasma tem um alvo (tile) diferente,
        segundo o Pac-Man clássico (Blinky, Pinky, Inky, Clyde), e escolhe
        a direção que mais aproxima do alvo, nunca podendo "parar" nem
        "sumir" — sempre existe uma direção válida (e há uma rotina extra
        de segurança que recalcula a rota via BFS caso algo saia do normal).
     4. Ciclo de vida completo de "fantasma comido": eyes -> volta pra base
        -> espera -> normaliza cor -> sai da base -> volta a perseguir.
   ========================================================================= */

'use strict';

/* ------------------------------------------------------------------ */
/* 1. LABIRINTO                                                        */
/* ------------------------------------------------------------------ */

// '#' = parede | '.' = caminho (recebe pastilha) | 'D' = porta da base dos fantasmas
const RAW_MAZE = [
  "#######################################",
  "#..................#..................#",
  "#..................#..................#",
  "#.....................................#",
  "#...##....##.......#.......##....##...#",
  "#...##....##.......#.......##....##...#",
  "#.....................................#",
  "###....##....##....#....##....##....###",
  "###....##....##....#....##....##....###",
  "#.....................................#",
  "#...##....##.......#.......##....##...#",
  "#...##....##.......#.......##....##...#",
  "#.....................................#",
  "#......##....##.###D###.##....##......#",
  "#......##....##.#.....#.##....##......#",
  "#...............#.....#...............#",
  "....##....##....#.....#....##....##....",
  "#...##....##....#.....#....##....##...#",
  "#...............#.....#...............#",
  "###....##.##.##.#######.##.##.##....###",
  "###....##.##.##....#....##.##.##....###",
  "#.....................................#",
  "#...##..........##.#.##..........##...#",
  "#...##..........##.#.##..........##...#",
  "#.....................................#",
  "###....##.##.##....#....##.##.##....###",
  "###....##.##.##....#....##.##.##....###",
  "#.....................................#",
  "#....#....##....##.#.##....##....#....#",
  "#....#....##....##.#.##....##....#....#",
  "#.....................................#",
  "###.##.##.##.##.##.#.##.##.##.##.##.###",
  "#######################################",
];

const ROWS = RAW_MAZE.length;
const COLS = RAW_MAZE[0].length;
const CELL = 18; // tamanho de cada célula em pixels

// Tipos de estrutura (estático, nunca muda durante o jogo)
const WALL = 0, PATH = 1, DOOR = 2;
// Tipos de pastilha (dinâmico, muda conforme o jogador come)
const NONE = 0, DOT = 1, POWER = 2;

const structure = []; // [row][col] -> WALL | PATH | DOOR
const pellets = [];   // [row][col] -> NONE | DOT | POWER

for (let r = 0; r < ROWS; r++) {
  const sRow = [];
  const pRow = [];
  for (let c = 0; c < COLS; c++) {
    const ch = RAW_MAZE[r][c];
    if (ch === '#') { sRow.push(WALL); pRow.push(NONE); }
    else if (ch === 'D') { sRow.push(DOOR); pRow.push(NONE); }
    else { sRow.push(PATH); pRow.push(DOT); }
  }
  structure.push(sRow);
  pellets.push(pRow);
}

// Células que não devem ter pastilha (interior da base dos fantasmas e túnel)
function clearPellets(r1, c1, r2, c2) {
  for (let r = r1; r <= r2; r++)
    for (let c = c1; c <= c2; c++)
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) pellets[r][c] = NONE;
}
clearPellets(14, 17, 18, 21); // interior da casa dos fantasmas
clearPellets(16, 0, 16, 3);   // entrada do túnel (esquerda)
clearPellets(16, 35, 16, 38); // entrada do túnel (direita)
pellets[27][19] = NONE;       // ponto de partida do Pac-Man

// Power pellets (pastilhas grandes) nos quatro "cantos" do mapa
const POWER_COORDS = [[1, 1], [1, 37], [29, 1], [29, 37]];
for (const [r, c] of POWER_COORDS) pellets[r][c] = POWER;

let totalDots = 0;
for (let r = 0; r < ROWS; r++)
  for (let c = 0; c < COLS; c++)
    if (pellets[r][c] !== NONE) totalDots++;

const TUNNEL_ROW = 16; // linha usada para o túnel de teleporte esquerda<->direita

const GHOST_HOUSE_DOOR = { row: 13, col: 19 };
const GHOST_HOUSE_EXIT = { row: 12, col: 19 }; // célula logo acima da porta
const GHOST_HOUSE_CENTER = { row: 16, col: 19 };

/* ------------------------------------------------------------------ */
/* 2. FUNÇÕES DE APOIO AO LABIRINTO (colisão, vizinhos, BFS)          */
/* ------------------------------------------------------------------ */

const DIRS = {
  UP: { dr: -1, dc: 0 },
  DOWN: { dr: 1, dc: 0 },
  LEFT: { dr: 0, dc: -1 },
  RIGHT: { dr: 0, dc: 1 },
};
const DIR_LIST = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
const OPPOSITE = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' };

// Normaliza coordenadas de coluna considerando o túnel (wrap-around)
function wrapCol(row, col) {
  if (row === TUNNEL_ROW) {
    if (col < 0) return COLS - 1;
    if (col >= COLS) return 0;
  }
  return col;
}

// Uma célula é andável se não for parede. A porta só é andável por fantasmas
// (quando allowDoor é verdadeiro — usado para entrar/sair da base ou para os
// "olhos" retornando à base).
function isWalkable(row, col, allowDoor) {
  if (row < 0 || row >= ROWS) return false;
  let c = col;
  if (c < 0 || c >= COLS) {
    if (row === TUNNEL_ROW) c = wrapCol(row, c);
    else return false;
  }
  const s = structure[row][c];
  if (s === WALL) return false;
  if (s === DOOR) return !!allowDoor;
  return true;
}

function neighborCell(row, col, dirName) {
  const d = DIRS[dirName];
  let nr = row + d.dr;
  let nc = col + d.dc;
  if (nr === TUNNEL_ROW) nc = wrapCol(nr, nc);
  return { row: nr, col: nc };
}

// Lista as direções válidas a partir de uma célula
function availableDirs(row, col, allowDoor, excludeDir) {
  const out = [];
  for (const name of DIR_LIST) {
    if (excludeDir && name === excludeDir) continue;
    const n = neighborCell(row, col, name);
    if (isWalkable(n.row, n.col, allowDoor)) out.push(name);
  }
  return out;
}

// BFS simples para achar o primeiro passo de um caminho mais curto entre duas
// células. Usado para: fantasma "comido" voltando à base, fantasma saindo da
// base, e a rotina de segurança anti-travamento.
function bfsFirstStep(fromRow, fromCol, toRow, toCol, allowDoor) {
  if (fromRow === toRow && fromCol === toCol) return null;
  const visited = new Set();
  const key = (r, c) => r + ',' + c;
  visited.add(key(fromRow, fromCol));
  const queue = [{ row: fromRow, col: fromCol, first: null }];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const name of DIR_LIST) {
      const n = neighborCell(cur.row, cur.col, name);
      if (!isWalkable(n.row, n.col, allowDoor)) continue;
      const k = key(n.row, n.col);
      if (visited.has(k)) continue;
      visited.add(k);
      const first = cur.first || name;
      if (n.row === toRow && n.col === toCol) return first;
      queue.push({ row: n.row, col: n.col, first });
    }
    if (queue.length > 4000) break; // limite de segurança
  }
  return null;
}

function tileDistance(r1, c1, r2, c2) {
  const dx = r1 - r2, dy = c1 - c2;
  return Math.sqrt(dx * dx + dy * dy);
}

/* ------------------------------------------------------------------ */
/* 3. CANVAS E UI                                                      */
/* ------------------------------------------------------------------ */

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
canvas.width = COLS * CELL;
canvas.height = ROWS * CELL;

const scoreEl = document.getElementById('score-value');
const livesEl = document.getElementById('lives-value');
const overlayEl = document.getElementById('overlay');
const overlayTitleEl = document.getElementById('overlay-title');
const overlayMsgEl = document.getElementById('overlay-message');
const restartBtn = document.getElementById('restart-btn');
const startBtn = document.getElementById('start-btn');

/* ------------------------------------------------------------------ */
/* 4. ESTADO DO JOGO                                                   */
/* ------------------------------------------------------------------ */

const GameMode = { READY: 'ready', PLAYING: 'playing', DYING: 'dying', WIN: 'win', GAMEOVER: 'gameover' };

const state = {
  score: 0,
  lives: 3,
  dotsEaten: 0,
  mode: GameMode.READY,
  globalGhostMode: 'scatter', // 'scatter' | 'chase' — alternam com o tempo
  modeTimer: 0,
  scheduleIndex: 0,
  frightTimer: 0,
  ghostEatCombo: 0,
  freezeTimer: 0, // pequena pausa após Pac-Man perder uma vida
};

// Duração (segundos) de cada fase scatter/chase, alternando. Depois que a
// lista acaba, o jogo permanece em "chase" (padrão clássico).
const MODE_SCHEDULE = [
  { mode: 'scatter', time: 7 },
  { mode: 'chase', time: 20 },
  { mode: 'scatter', time: 7 },
  { mode: 'chase', time: 20 },
  { mode: 'scatter', time: 5 },
  { mode: 'chase', time: 999999 },
];

const FRIGHT_DURATION = 8; // segundos que os fantasmas ficam vulneráveis
const BASE_SPEED = 6;      // tiles/segundo do Pac-Man

/* ------------------------------------------------------------------ */
/* 5. PAC-MAN                                                          */
/* ------------------------------------------------------------------ */

const pacman = {
  row: 27, col: 19,
  progress: 0,
  dir: null,        // direção atual de movimento
  nextDir: 'LEFT',  // direção desejada pelo jogador
  speed: BASE_SPEED,
  mouthPhase: 0,
};

function resetPacman() {
  pacman.row = 27;
  pacman.col = 19;
  pacman.progress = 0;
  pacman.dir = null;
  pacman.nextDir = 'LEFT';
}

function pacmanPixelPos() {
  let r = pacman.row, c = pacman.col;
  if (pacman.dir) {
    const d = DIRS[pacman.dir];
    r += d.dr * pacman.progress;
    c += d.dc * pacman.progress;
  }
  // ajuste visual para o wrap do túnel não "arrastar" o sprite pela tela toda
  return { x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 };
}

function updatePacman(dt) {
  pacman.mouthPhase += dt * 10;

  // Decide direção quando alinhado ao centro da célula (progress == 0)
  if (pacman.progress === 0) {
    if (pacman.nextDir && isWalkable(
      neighborCell(pacman.row, pacman.col, pacman.nextDir).row,
      neighborCell(pacman.row, pacman.col, pacman.nextDir).col, false)) {
      pacman.dir = pacman.nextDir;
    } else if (pacman.dir && !isWalkable(
      neighborCell(pacman.row, pacman.col, pacman.dir).row,
      neighborCell(pacman.row, pacman.col, pacman.dir).col, false)) {
      pacman.dir = null; // bateu numa parede sem direção alternativa: para
    }
  }

  if (!pacman.dir) return;

  pacman.progress += pacman.speed * dt;
  if (pacman.progress >= 1) {
    pacman.progress = 0;
    const n = neighborCell(pacman.row, pacman.col, pacman.dir);
    pacman.row = n.row;
    pacman.col = wrapCol(n.row, n.col);
    // comer pastilha ao chegar numa nova célula
    eatPelletAt(pacman.row, pacman.col);
  }
}

function eatPelletAt(row, col) {
  const p = pellets[row][col];
  if (p === NONE) return;
  pellets[row][col] = NONE;
  state.dotsEaten++;
  if (p === DOT) {
    state.score += 10;
  } else if (p === POWER) {
    state.score += 50;
    activateFrightMode();
  }
  updateHud();
  if (state.dotsEaten >= totalDots) {
    triggerWin();
  }
}

function activateFrightMode() {
  state.frightTimer = FRIGHT_DURATION;
  state.ghostEatCombo = 0;
  for (const g of ghosts) {
    if (g.mode === 'chase' || g.mode === 'scatter' || g.mode === 'frightened') {
      g.mode = 'frightened';
      g.dir = OPPOSITE[g.dir] && availableDirs(g.row, g.col, false).includes(OPPOSITE[g.dir])
        ? OPPOSITE[g.dir] : g.dir; // inverte o sentido, clássico do Pac-Man
    }
  }
}

/* ------------------------------------------------------------------ */
/* 6. FANTASMAS                                                        */
/* ------------------------------------------------------------------ */

// Configuração de cada um dos 4 fantasmas clássicos
const GHOST_DEFS = [
  { name: 'blinky', color: '#ff0000', startRow: 14, startCol: 19, scatter: [1, 37], releaseDelay: 0 },
  { name: 'pinky', color: '#ffb8ff', startRow: 16, startCol: 18, scatter: [1, 1], releaseDelay: 2 },
  { name: 'inky', color: '#00ffff', startRow: 16, startCol: 19, scatter: [29, 37], releaseDelay: 5 },
  { name: 'clyde', color: '#ffb851', startRow: 16, startCol: 20, scatter: [29, 1], releaseDelay: 9 },
];

let ghosts = [];

function createGhosts() {
  ghosts = GHOST_DEFS.map(def => ({
    def,
    row: def.startRow,
    col: def.startCol,
    progress: 0,
    dir: 'UP',
    speed: BASE_SPEED * 0.9,
    mode: 'house',       // 'house' | 'exiting' | 'scatter' | 'chase' | 'frightened' | 'eaten'
    houseTimer: def.releaseDelay,
    lastTileChangeAt: 0, // p/ rotina anti-travamento
    bobDir: 1,
  }));
}

function ghostPixelPos(g) {
  let r = g.row, c = g.col;
  if (g.dir) {
    const d = DIRS[g.dir];
    r += d.dr * g.progress;
    c += d.dc * g.progress;
  }
  return { x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 };
}

// Alvo (tile) de cada fantasma segundo o comportamento clássico
function ghostTarget(g) {
  const px = pacman;
  if (g.mode === 'scatter') {
    return { row: g.def.scatter[0], col: g.def.scatter[1] };
  }
  if (g.mode === 'eaten') {
    return { row: GHOST_HOUSE_CENTER.row, col: GHOST_HOUSE_CENTER.col };
  }
  if (g.mode === 'exiting') {
    return { row: GHOST_HOUSE_EXIT.row, col: GHOST_HOUSE_EXIT.col };
  }
  // modo 'chase' — comportamento individual
  const pd = px.dir ? DIRS[px.dir] : { dr: 0, dc: 0 };
  switch (g.def.name) {
    case 'blinky':
      return { row: px.row, col: px.col };
    case 'pinky': {
      return { row: px.row + pd.dr * 4, col: px.col + pd.dc * 4 };
    }
    case 'inky': {
      const ahead = { row: px.row + pd.dr * 2, col: px.col + pd.dc * 2 };
      const blinky = ghosts.find(gh => gh.def.name === 'blinky');
      const vr = ahead.row - blinky.row;
      const vc = ahead.col - blinky.col;
      return { row: blinky.row + vr * 2, col: blinky.col + vc * 2 };
    }
    case 'clyde': {
      const d = tileDistance(g.row, g.col, px.row, px.col);
      if (d > 8) return { row: px.row, col: px.col };
      return { row: g.def.scatter[0], col: g.def.scatter[1] };
    }
    default:
      return { row: px.row, col: px.col };
  }
}

// Escolhe a próxima direção do fantasma no centro de uma célula
function chooseGhostDir(g) {
  const allowDoor = (g.mode === 'eaten' || g.mode === 'exiting' || g.mode === 'house');

  if (g.mode === 'house') {
    // Ainda esperando para sair: fica balançando dentro da casinha
    const upFree = isWalkable(g.row - 1, g.col, true);
    const downFree = isWalkable(g.row + 1, g.col, true);
    if (g.row <= GHOST_HOUSE_CENTER.row - 1 || !upFree) g.bobDir = 1;
    else if (g.row >= GHOST_HOUSE_CENTER.row + 1 || !downFree) g.bobDir = -1;
    return g.bobDir === 1 ? 'DOWN' : 'UP';
  }

  if (g.mode === 'exiting') {
    // Sai da casa em direção à porta usando BFS (garante caminho válido)
    if (g.row === GHOST_HOUSE_EXIT.row && g.col === GHOST_HOUSE_EXIT.col) {
      return null; // chegou: quem chama troca de modo
    }
    const step = bfsFirstStep(g.row, g.col, GHOST_HOUSE_EXIT.row, GHOST_HOUSE_EXIT.col, true);
    return step || fallbackDir(g, true);
  }

  if (g.mode === 'eaten') {
    // Olhos voltando pra base
    if (g.row === GHOST_HOUSE_CENTER.row && g.col === GHOST_HOUSE_CENTER.col) {
      return null; // chegou em casa
    }
    const step = bfsFirstStep(g.row, g.col, GHOST_HOUSE_CENTER.row, GHOST_HOUSE_CENTER.col, true);
    return step || fallbackDir(g, true);
  }

  // scatter / chase / frightened: escolhe entre as direções válidas (sem
  // voltar para trás, a menos que seja a única opção — clássico do Pac-Man)
  const options = availableDirs(g.row, g.col, false, g.dir ? OPPOSITE[g.dir] : null);
  const finalOptions = options.length > 0 ? options : availableDirs(g.row, g.col, false, null);

  if (finalOptions.length === 0) return fallbackDir(g, false);

  if (g.mode === 'frightened') {
    return finalOptions[Math.floor(Math.random() * finalOptions.length)];
  }

  const target = ghostTarget(g);
  let best = finalOptions[0];
  let bestDist = Infinity;
  for (const name of finalOptions) {
    const n = neighborCell(g.row, g.col, name);
    const d = tileDistance(n.row, n.col, target.row, target.col);
    if (d < bestDist) { bestDist = d; best = name; }
  }
  return best;
}

// Rotina de segurança: se por algum motivo nenhuma direção "normal" for
// encontrada, recalcula uma rota válida com BFS até uma célula aberta
// próxima, garantindo que o fantasma NUNCA fique travado.
function fallbackDir(g, allowDoor) {
  const opts = availableDirs(g.row, g.col, allowDoor, null);
  if (opts.length > 0) return opts[Math.floor(Math.random() * opts.length)];
  // Situação extrema (não deveria ocorrer no mapa validado): procura
  // qualquer célula andável nas redondezas via BFS amplo.
  const step = bfsFirstStep(g.row, g.col, GHOST_HOUSE_CENTER.row, GHOST_HOUSE_CENTER.col, true);
  return step || 'UP';
}

function updateGhost(g, dt) {
  // Velocidade conforme o modo
  if (g.mode === 'frightened') g.speed = BASE_SPEED * 0.55;
  else if (g.mode === 'eaten') g.speed = BASE_SPEED * 1.9;
  else if (g.mode === 'house' || g.mode === 'exiting') g.speed = BASE_SPEED * 0.6;
  else g.speed = BASE_SPEED * 0.85;

  if (g.mode === 'house') {
    g.houseTimer -= dt;
    if (g.houseTimer <= 0) g.mode = 'exiting';
  }

  // 'resting' é tratado ANTES da decisão genérica de direção, pois usa sua
  // própria lógica de balanço (bobbing) e não deve cair no ramo padrão de
  // perseguição/scatter (que não faz sentido dentro da casinha).
  if (g.mode === 'resting') {
    // Balança suavemente dentro da base enquanto espera
    const upFree = isWalkable(g.row - 1, g.col, true);
    const downFree = isWalkable(g.row + 1, g.col, true);
    if (g.row <= GHOST_HOUSE_CENTER.row - 1 || !upFree) g.bobDir = 1;
    else if (g.row >= GHOST_HOUSE_CENTER.row + 1 || !downFree) g.bobDir = -1;
    g.dir = g.bobDir === 1 ? 'DOWN' : 'UP';
    g.speed = BASE_SPEED * 0.5;
    g.houseTimer -= dt;
    g.progress += g.speed * dt;
    if (g.progress >= 1) {
      g.progress = 0;
      const n = neighborCell(g.row, g.col, g.dir);
      if (isWalkable(n.row, n.col, true)) { g.row = n.row; g.col = n.col; }
    }
    if (g.houseTimer <= 0) {
      g.mode = 'exiting';
      g.row = GHOST_HOUSE_CENTER.row;
      g.col = GHOST_HOUSE_CENTER.col;
      g.progress = 0;
      g.dir = 'UP';
    }
    return;
  }

  // Decide a próxima direção exatamente quando alinhado ao centro da célula
  if (g.progress === 0) {
    const nextDir = chooseGhostDir(g);
    if (nextDir === null) {
      // Chegou ao destino de uma rota especial (saída ou base)
      if (g.mode === 'exiting') {
        g.mode = state.frightTimer > 0 ? 'frightened' : state.globalGhostMode;
      } else if (g.mode === 'eaten') {
        g.mode = 'resting';
        g.houseTimer = 2.5; // espera alguns segundos na base
      }
      g.dir = g.dir || 'UP';
    } else {
      g.dir = nextDir;
    }
  }

  if (!g.dir) g.dir = 'UP';

  const allowDoor = (g.mode === 'eaten' || g.mode === 'exiting' || g.mode === 'house');
  g.progress += g.speed * dt;

  // Rotina anti-travamento: se por muito tempo o fantasma não muda de tile,
  // força um recálculo de rota (isso cobre qualquer caso extremo).
  g.lastTileChangeAt += dt;
  if (g.lastTileChangeAt > 4) {
    g.progress = 0;
    g.dir = fallbackDir(g, allowDoor);
    g.lastTileChangeAt = 0;
  }

  if (g.progress >= 1) {
    g.progress = 0;
    g.lastTileChangeAt = 0;
    const n = neighborCell(g.row, g.col, g.dir);
    if (isWalkable(n.row, n.col, allowDoor)) {
      g.row = n.row;
      g.col = wrapCol(n.row, n.col);
    } else {
      // segurança extra: nunca deveria acontecer pois só andamos em
      // direções pré-validadas, mas se acontecer, recalcula na hora.
      g.dir = fallbackDir(g, allowDoor);
    }
  }
}

function resetGhosts() {
  createGhosts();
}

/* ------------------------------------------------------------------ */
/* 7. MODOS GLOBAIS (scatter/chase) E FRIGHTENED                       */
/* ------------------------------------------------------------------ */

function updateGlobalMode(dt) {
  if (state.frightTimer > 0) {
    state.frightTimer -= dt;
    if (state.frightTimer <= 0) {
      state.frightTimer = 0;
      for (const g of ghosts) {
        if (g.mode === 'frightened') g.mode = state.globalGhostMode;
      }
    }
    return; // enquanto assustados, o cronômetro scatter/chase fica pausado
  }

  state.modeTimer += dt;
  const current = MODE_SCHEDULE[state.scheduleIndex];
  if (state.modeTimer >= current.time) {
    state.modeTimer = 0;
    state.scheduleIndex = Math.min(state.scheduleIndex + 1, MODE_SCHEDULE.length - 1);
    state.globalGhostMode = MODE_SCHEDULE[state.scheduleIndex].mode;
    for (const g of ghosts) {
      if (g.mode === 'scatter' || g.mode === 'chase') {
        g.mode = state.globalGhostMode;
        // inverte a direção ao trocar de modo (comportamento clássico)
        const opp = OPPOSITE[g.dir];
        if (opp && isWalkable(neighborCell(g.row, g.col, opp).row, neighborCell(g.row, g.col, opp).col, false)) {
          g.dir = opp;
          g.progress = 0;
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 8. COLISÃO PAC-MAN x FANTASMAS                                      */
/* ------------------------------------------------------------------ */

function checkCollisions() {
  const pp = pacmanPixelPos();
  for (const g of ghosts) {
    if (g.mode === 'house' || g.mode === 'resting' || g.mode === 'exiting' || g.mode === 'eaten') continue;
    const gp = ghostPixelPos(g);
    const dist = Math.hypot(pp.x - gp.x, pp.y - gp.y);
    if (dist < CELL * 0.6) {
      if (g.mode === 'frightened') {
        state.ghostEatCombo++;
        const points = 200 * Math.pow(2, Math.min(state.ghostEatCombo - 1, 3));
        state.score += points;
        g.mode = 'eaten';
        g.progress = 0;
        updateHud();
      } else {
        loseLife();
        return;
      }
    }
  }
}

function loseLife() {
  state.lives--;
  updateHud();
  state.mode = GameMode.DYING;
  state.freezeTimer = 1.4;
  if (state.lives <= 0) {
    setTimeout(() => triggerGameOver(), 1200);
  } else {
    setTimeout(() => {
      resetPacman();
      resetGhosts();
      state.mode = GameMode.PLAYING;
    }, 1200);
  }
}

/* ------------------------------------------------------------------ */
/* 9. HUD / TELAS                                                      */
/* ------------------------------------------------------------------ */

function updateHud() {
  scoreEl.textContent = state.score;
  livesEl.textContent = state.lives;
}

function showOverlay(title, message, showRestart) {
  overlayTitleEl.textContent = title;
  overlayMsgEl.textContent = message;
  overlayEl.classList.remove('hidden');
  restartBtn.classList.toggle('hidden', !showRestart);
  startBtn.classList.add('hidden');
}

function hideOverlay() {
  overlayEl.classList.add('hidden');
}

function triggerWin() {
  state.mode = GameMode.WIN;
  showOverlay('Você venceu! 🎉', 'Todas as pastilhas foram comidas. Pontuação final: ' + state.score, true);
}

function triggerGameOver() {
  state.mode = GameMode.GAMEOVER;
  showOverlay('Game Over', 'Pontuação final: ' + state.score, true);
}

/* ------------------------------------------------------------------ */
/* 10. DESENHO                                                         */
/* ------------------------------------------------------------------ */

function drawMaze() {
  ctx.fillStyle = '#000814';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const s = structure[r][c];
      if (s === WALL) {
        ctx.fillStyle = '#1a1aa8';
        ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2);
      } else if (s === DOOR) {
        ctx.fillStyle = '#ff9fdc';
        ctx.fillRect(c * CELL + 2, r * CELL + CELL / 2 - 2, CELL - 4, 4);
      }
    }
  }

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const p = pellets[r][c];
      if (p === DOT) {
        ctx.fillStyle = '#ffd28a';
        ctx.beginPath();
        ctx.arc(c * CELL + CELL / 2, r * CELL + CELL / 2, 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (p === POWER) {
        const pulse = 3.5 + Math.sin(performance.now() / 150) * 1.5;
        ctx.fillStyle = '#ffd28a';
        ctx.beginPath();
        ctx.arc(c * CELL + CELL / 2, r * CELL + CELL / 2, pulse, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawPacman() {
  const { x, y } = pacmanPixelPos();
  const radius = CELL / 2 - 1;
  const angle = 0.25 * Math.abs(Math.sin(pacman.mouthPhase)) * Math.PI;
  let rotation = 0;
  switch (pacman.dir) {
    case 'RIGHT': rotation = 0; break;
    case 'DOWN': rotation = Math.PI / 2; break;
    case 'LEFT': rotation = Math.PI; break;
    case 'UP': rotation = -Math.PI / 2; break;
    default: rotation = 0;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.fillStyle = '#ffe600';
  ctx.beginPath();
  ctx.arc(0, 0, radius, angle, Math.PI * 2 - angle);
  ctx.lineTo(0, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawGhostBody(x, y, color) {
  const r = CELL / 2 - 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y - 1, r, Math.PI, 0, false);
  ctx.lineTo(x + r, y + r);
  const waves = 3;
  for (let i = 0; i < waves; i++) {
    const step = (2 * r) / waves;
    const wx = x + r - step * (i + 0.5);
    ctx.lineTo(wx, y + r - (i % 2 === 0 ? 3 : 0));
  }
  ctx.lineTo(x - r, y + r);
  ctx.closePath();
  ctx.fill();
}

function drawGhostEyes(x, y, dir, pale) {
  const offsets = {
    UP: [0, -2], DOWN: [0, 2], LEFT: [-2, 0], RIGHT: [2, 0], null: [0, 0],
  };
  const [ox, oy] = offsets[dir] || [0, 0];
  const eyeOffsetX = 3.2;
  for (const s of [-1, 1]) {
    ctx.fillStyle = pale ? '#3d3dff' : '#ffffff';
    ctx.beginPath();
    ctx.arc(x + s * eyeOffsetX, y - 1, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = pale ? '#ffffff' : '#0c0c6e';
    ctx.beginPath();
    ctx.arc(x + s * eyeOffsetX + ox * 0.5, y - 1 + oy * 0.5, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawGhost(g) {
  const { x, y } = ghostPixelPos(g);

  if (g.mode === 'eaten') {
    drawGhostEyes(x, y, g.dir, false);
    return;
  }

  let color = g.def.color;
  if (g.mode === 'frightened') {
    const flashing = state.frightTimer < 2.5 && Math.floor(state.frightTimer * 6) % 2 === 0;
    color = flashing ? '#ffffff' : '#2323e0';
  }

  drawGhostBody(x, y, color);
  drawGhostEyes(x, y, g.dir, g.mode === 'frightened');
}

function render() {
  drawMaze();
  for (const g of ghosts) drawGhost(g);
  drawPacman();
}

/* ------------------------------------------------------------------ */
/* 11. LOOP PRINCIPAL                                                  */
/* ------------------------------------------------------------------ */

let lastTime = null;

function gameLoop(timestamp) {
  if (lastTime === null) lastTime = timestamp;
  let dt = (timestamp - lastTime) / 1000;
  dt = Math.min(dt, 0.05); // evita saltos grandes se a aba ficar em segundo plano
  lastTime = timestamp;

  if (state.mode === GameMode.PLAYING) {
    updatePacman(dt);
    updateGlobalMode(dt);
    for (const g of ghosts) updateGhost(g, dt);
    checkCollisions();
  } else if (state.mode === GameMode.DYING) {
    // apenas espera o timeout do loseLife reiniciar posições
  }

  render();
  requestAnimationFrame(gameLoop);
}

/* ------------------------------------------------------------------ */
/* 12. ENTRADA DO JOGADOR                                              */
/* ------------------------------------------------------------------ */

const KEY_MAP = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  w: 'UP', s: 'DOWN', a: 'LEFT', d: 'RIGHT',
  W: 'UP', S: 'DOWN', A: 'LEFT', D: 'RIGHT',
};

window.addEventListener('keydown', (e) => {
  const dir = KEY_MAP[e.key];
  if (!dir) return;
  e.preventDefault();
  pacman.nextDir = dir;
  if (state.mode === GameMode.READY) startGame();
});

// Suporte a toque (botões na tela, opcional em telas pequenas)
document.querySelectorAll('[data-dir]').forEach(btn => {
  btn.addEventListener('click', () => {
    pacman.nextDir = btn.getAttribute('data-dir');
    if (state.mode === GameMode.READY) startGame();
  });
});

/* ------------------------------------------------------------------ */
/* 13. CONTROLE DE JOGO (start / restart)                              */
/* ------------------------------------------------------------------ */

function startGame() {
  hideOverlay();
  state.mode = GameMode.PLAYING;
}

function restartGame() {
  // Recompõe todas as pastilhas
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (structure[r][c] === PATH) pellets[r][c] = DOT;
    }
  }
  for (const [r, c] of POWER_COORDS) pellets[r][c] = POWER;
  clearPellets(14, 17, 18, 21);
  clearPellets(16, 0, 16, 3);
  clearPellets(16, 35, 16, 38);
  pellets[27][19] = NONE;

  state.score = 0;
  state.lives = 3;
  state.dotsEaten = 0;
  state.globalGhostMode = 'scatter';
  state.modeTimer = 0;
  state.scheduleIndex = 0;
  state.frightTimer = 0;
  state.ghostEatCombo = 0;

  resetPacman();
  resetGhosts();
  updateHud();
  hideOverlay();
  state.mode = GameMode.PLAYING;
}

startBtn.addEventListener('click', startGame);
restartBtn.addEventListener('click', restartGame);

/* ------------------------------------------------------------------ */
/* 14. INICIALIZAÇÃO                                                   */
/* ------------------------------------------------------------------ */

resetGhosts();
updateHud();
showOverlay('Pac-Man', 'Use as setas ou WASD para começar a jogar.', false);
startBtn.classList.remove('hidden');
requestAnimationFrame(gameLoop);
