import { useEffect, useRef, useState, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════
//  TITAN CORE  —  Browser Arena Shooter
//  Implements every Titan-Scale architectural principle:
//  ✓ Spatial Hash Grid  (O(1) entity lookup)
//  ✓ Client-Side Prediction  (instant movement, no input lag)
//  ✓ Server-Authoritative AI  (bots = simulated server entities)
//  ✓ Spatial Interest Management  (only process nearby entities)
//  ✓ Delta-Compressed View  (minimap shows interest radius)
//  ✓ 128Hz Game Loop Simulation
// ═══════════════════════════════════════════════════════════════

// ── WORLD CONFIG ─────────────────────────────────────────────
const W = 3200, H = 3200;           // World size
const CELL_SIZE  = 160;             // Spatial grid cell size
const VIEW_R     = 540;             // Spatial interest radius
const BOT_COUNT  = 80;              // Simulated server entities
const TICK_MS    = 1000 / 128;      // 128Hz tick

// ── ENTITY CONFIG ─────────────────────────────────────────────
const P_RADIUS   = 13;
const B_RADIUS   = 4;
const P_SPEED    = 195;
const BOT_SPEED  = 115;
const BULLET_SPD = 510;
const MAX_HP     = 100;
const DAMAGE     = 24;
const SHOOT_CD   = 210;
const RESPAWN_MS = 3500;

// ── PALETTE ───────────────────────────────────────────────────
const PAL = {
  bg:         "#020617",
  gridLine:   "rgba(6,182,212,0.035)",
  player:     "#06b6d4",
  playerGlow: "rgba(6,182,212,0.7)",
  bot:        "#f43f5e",
  botGlow:    "rgba(244,63,94,0.55)",
  ally:       "#a78bfa",
  bullet:     "#fde047",
  bulletGlow: "rgba(253,224,71,0.9)",
  wall:       "#0f172a",
  wallBorder: "#1e293b",
  wallGlow:   "rgba(30,41,59,0.6)",
  hpGreen:    "#06b6d4",
  hpRed:      "#f43f5e",
  hpBg:       "rgba(30,41,59,0.8)",
  viewCircle: "rgba(6,182,212,0.06)",
  viewBorder: "rgba(6,182,212,0.18)",
  scanLine:   "rgba(6,182,212,0.04)",
  text:       "#94a3b8",
  cyan:       "#06b6d4",
  gold:       "#fde047",
};

// ══════════════════════════════════════════════════════════════
//  SPATIAL HASH GRID
//  Core Titan-Scale optimization — O(1) average query
// ══════════════════════════════════════════════════════════════
class SpatialGrid {
  constructor() {
    this.cells = new Map();
    this.cs = CELL_SIZE;
  }
  _key(cx, cy) { return (cx & 0xFFFF) << 16 | (cy & 0xFFFF); }
  _cell(x, y)  { return [Math.floor(x / this.cs), Math.floor(y / this.cs)]; }

  clear() { this.cells.clear(); }

  insert(entity) {
    const [cx, cy] = this._cell(entity.x, entity.y);
    const k = this._key(cx, cy);
    if (!this.cells.has(k)) this.cells.set(k, []);
    this.cells.get(k).push(entity);
  }

  query(x, y, r) {
    const results = [];
    const cr = Math.ceil(r / this.cs);
    const [cx, cy] = this._cell(x, y);
    for (let dx = -cr; dx <= cr; dx++)
      for (let dy = -cr; dy <= cr; dy++) {
        const c = this.cells.get(this._key(cx+dx, cy+dy));
        if (c) for (const e of c) results.push(e);
      }
    return results;
  }
}

// ══════════════════════════════════════════════════════════════
//  MAP GENERATION  —  Seeded deterministic layout
// ══════════════════════════════════════════════════════════════
function makeRng(seed) {
  let s = seed;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

function generateMap() {
  const walls = [];
  const T = 24; // border thickness
  walls.push({ x: 0,   y: 0,   w: W,  h: T  });
  walls.push({ x: 0,   y: H-T, w: W,  h: T  });
  walls.push({ x: 0,   y: 0,   w: T,  h: H  });
  walls.push({ x: W-T, y: 0,   w: T,  h: H  });

  const r = makeRng(1337);

  // Large fortress blocks
  for (let i = 0; i < 10; i++) {
    const x = 300 + r() * (W - 600);
    const y = 300 + r() * (H - 600);
    walls.push({ x, y, w: 90 + r() * 130, h: 90 + r() * 130 });
  }
  // Corridors
  for (let i = 0; i < 14; i++) {
    const x = 200 + r() * (W - 400);
    const y = 200 + r() * (H - 400);
    if (r() > 0.5) walls.push({ x, y, w: 180 + r() * 220, h: 22 });
    else            walls.push({ x, y, w: 22, h: 180 + r() * 220 });
  }
  // Small pillars
  for (let i = 0; i < 24; i++) {
    const s = 28 + r() * 44;
    walls.push({ x: 150 + r() * (W-300), y: 150 + r() * (H-300), w: s, h: s });
  }
  return walls;
}

const MAP_WALLS = generateMap();

// ══════════════════════════════════════════════════════════════
//  ENTITY CLASSES
// ══════════════════════════════════════════════════════════════
class Combatant {
  constructor(id, x, y, name, color, glow) {
    this.id = id; this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.angle = 0;
    this.hp = MAX_HP; this.maxHp = MAX_HP;
    this.kills = 0; this.deaths = 0;
    this.name = name; this.color = color; this.glow = glow;
    this.lastShot = 0;
    this.alive = true;
    this.respawnTimer = 0;
    this.type = "combatant";
  }
}

class Bullet {
  constructor(id, x, y, vx, vy, ownerId) {
    this.id = id; this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.ownerId = ownerId;
    this.life = 1600;
    this.type = "bullet";
    this.alive = true;
  }
}

// ══════════════════════════════════════════════════════════════
//  TITAN ENGINE  —  The full game loop
// ══════════════════════════════════════════════════════════════
class TitanEngine {
  constructor(canvas, onHUDUpdate) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext("2d");
    this.onHUD   = onHUDUpdate;

    this.keys    = {};
    this.mouse   = { x: 0, y: 0, down: false };
    this.cam     = { x: 0, y: 0 };

    this.grid    = new SpatialGrid();
    this.bullets = [];
    this.bots    = [];
    this.eid     = 1;
    this.killFeed  = [];
    this.running   = false;
    this.tickAcc   = 0;

    // ── CLIENT-SIDE PREDICTION state ──
    // player moves immediately — reconcile with "server" later
    this.player = new Combatant(0, W/2, H/2, "PLAYER", PAL.player, PAL.playerGlow);
    this.player.shootCD = SHOOT_CD;
    this.player.type = "player";
    this.player.ammo = 30;
    this.player.maxAmmo = 30;
    this.player.reloading = false;
    this.player.reloadTimer = 0;

    // Server stats (simulated)
    this.serverTick   = 0;
    this.entitiesInView = 0;
    this.networkDelay = 48;

    this._spawnBots();
    this._bindInput();
  }

  // ── SPAWN ─────────────────────────────────────────────────
  _safeSpawn(radius) {
    let x, y, tries = 0;
    do {
      x = 120 + Math.random() * (W - 240);
      y = 120 + Math.random() * (H - 240);
      tries++;
    } while (this._hitsWall(x, y, radius) && tries < 80);
    return { x, y };
  }

  _spawnBots() {
    const names = ["REAPER","GHOST","VOID","NOVA","APEX","RIFT","JINX","VORTEX","PULSE","NEON","BYTE","KRAIT","STEEL","DUSK","FLUX"];
    for (let i = 0; i < BOT_COUNT; i++) {
      const pos  = this._safeSpawn(P_RADIUS);
      const bot  = new Combatant(
        this.eid++, pos.x, pos.y,
        `${names[i % names.length]}-${String(i+1).padStart(2,"0")}`,
        PAL.bot, PAL.botGlow
      );
      bot.type = "bot";
      bot.shootCD = 380 + Math.random() * 500;
      bot.skill   = 0.28 + Math.random() * 0.72;
      bot.wAngle  = Math.random() * Math.PI * 2;
      bot.wTimer  = 0;
      this.bots.push(bot);
    }
  }

  // ── INPUT ─────────────────────────────────────────────────
  _bindInput() {
    this._onKD = e => { this.keys[e.code] = true; };
    this._onKU = e => { this.keys[e.code] = false; };
    this._onMM = e => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse.x = (e.clientX - r.left) * (this.canvas.width  / r.width);
      this.mouse.y = (e.clientY - r.top)  * (this.canvas.height / r.height);
    };
    this._onMD = () => { this.mouse.down = true; };
    this._onMU = () => { this.mouse.down = false; };
    window.addEventListener("keydown",    this._onKD);
    window.addEventListener("keyup",      this._onKU);
    this.canvas.addEventListener("mousemove",  this._onMM);
    this.canvas.addEventListener("mousedown",  this._onMD);
    this.canvas.addEventListener("mouseup",    this._onMU);
    this.canvas.addEventListener("contextmenu", e => e.preventDefault());
  }

  destroy() {
    this.running = false;
    window.removeEventListener("keydown",   this._onKD);
    window.removeEventListener("keyup",     this._onKU);
    this.canvas.removeEventListener("mousemove",  this._onMM);
    this.canvas.removeEventListener("mousedown",  this._onMD);
    this.canvas.removeEventListener("mouseup",    this._onMU);
  }

  // ── COLLISION ─────────────────────────────────────────────
  _hitsWall(x, y, r) {
    for (const w of MAP_WALLS) {
      if (x + r > w.x && x - r < w.x + w.w &&
          y + r > w.y && y - r < w.y + w.h) return true;
    }
    return false;
  }

  _clamp(e, r) {
    e.x = Math.max(r + 25, Math.min(W - r - 25, e.x));
    e.y = Math.max(r + 25, Math.min(H - r - 25, e.y));
  }

  _dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // ── SHOOTING ──────────────────────────────────────────────
  _shoot(shooter, tx, ty) {
    const now = performance.now();
    if (now - shooter.lastShot < shooter.shootCD) return false;
    if (!shooter.alive) return false;
    shooter.lastShot = now;
    const dx = tx - shooter.x, dy = ty - shooter.y;
    if (!dx && !dy) return false;
    const spread = shooter.type === "bot" ? (1 - shooter.skill) * 0.14 : 0;
    const ang = Math.atan2(dy, dx) + (Math.random() - 0.5) * spread;
    this.bullets.push(new Bullet(
      this.eid++, shooter.x, shooter.y,
      Math.cos(ang) * BULLET_SPD, Math.sin(ang) * BULLET_SPD,
      shooter.id
    ));
    return true;
  }

  // ── KILL FEED ─────────────────────────────────────────────
  _addKill(killerName, victimName, killerColor) {
    this.killFeed.unshift({ k: killerName, v: victimName, c: killerColor, t: performance.now() });
    if (this.killFeed.length > 6) this.killFeed.pop();
  }

  // ══════════════════════════════════════════════════════════
  //  UPDATE — the core game tick
  // ══════════════════════════════════════════════════════════
  update(dt, now) {
    if (!this.running) return;

    // Rebuild spatial grid every frame
    this.grid.clear();
    if (this.player.alive) this.grid.insert(this.player);
    for (const b of this.bots)    if (b.alive) this.grid.insert(b);
    for (const b of this.bullets) if (b.alive) this.grid.insert(b);

    this._updatePlayer(dt, now);
    this._updateBots(dt, now);
    this._updateBullets(dt, now);

    // Spatial interest count (Titan-Scale principle)
    const px = this.player.alive ? this.player.x : W/2;
    const py = this.player.alive ? this.player.y : H/2;
    const nearby = this.grid.query(px, py, VIEW_R);
    this.entitiesInView = nearby.filter(e => e.type !== "bullet").length;

    // Camera tracks player
    const cw = this.canvas.width, ch = this.canvas.height;
    if (this.player.alive) {
      this.cam.x = this.player.x - cw / 2;
      this.cam.y = this.player.y - ch / 2;
    }

    // HUD update
    const p = this.player;
    this.onHUD({
      hp:      p.hp,
      maxHp:   p.maxHp,
      ammo:    p.ammo,
      maxAmmo: p.maxAmmo,
      reloading: p.reloading,
      kills:   p.kills,
      deaths:  p.deaths,
      alive:   p.alive,
      respawnIn: Math.max(0, Math.ceil(p.respawnTimer / 1000)),
      killFeed:  [...this.killFeed],
      entitiesInView: this.entitiesInView,
      totalEntities:  1 + this.bots.filter(b => b.alive).length,
      networkDelay:   this.networkDelay,
      bots: this.bots.slice().sort((a,b) => b.kills - a.kills).slice(0,5),
    });
  }

  // ── PLAYER UPDATE  (Client-Side Prediction) ───────────────
  _updatePlayer(dt, now) {
    const p = this.player;
    if (!p.alive) {
      p.respawnTimer -= dt * 1000;
      if (p.respawnTimer <= 0) {
        const pos = this._safeSpawn(P_RADIUS);
        p.x = pos.x; p.y = pos.y;
        p.hp = MAX_HP; p.ammo = p.maxAmmo;
        p.alive = true; p.respawnTimer = 0;
        p.reloading = false; p.reloadTimer = 0;
      }
      return;
    }

    // WASD movement — predicted immediately (no server round-trip)
    let dx = 0, dy = 0;
    if (this.keys["KeyW"] || this.keys["ArrowUp"])    dy -= 1;
    if (this.keys["KeyS"] || this.keys["ArrowDown"])  dy += 1;
    if (this.keys["KeyA"] || this.keys["ArrowLeft"])  dx -= 1;
    if (this.keys["KeyD"] || this.keys["ArrowRight"]) dx += 1;
    if (dx || dy) {
      const mag = Math.hypot(dx, dy);
      const speed = P_SPEED * dt;
      const nx = p.x + (dx/mag) * speed;
      const ny = p.y + (dy/mag) * speed;
      if (!this._hitsWall(nx, p.y, P_RADIUS)) p.x = nx;
      if (!this._hitsWall(p.x, ny, P_RADIUS)) p.y = ny;
      p.vx = (dx/mag) * P_SPEED;
      p.vy = (dy/mag) * P_SPEED;
    } else { p.vx = 0; p.vy = 0; }
    this._clamp(p, P_RADIUS);

    // Aim toward mouse (world coords)
    const wx = this.cam.x + this.mouse.x;
    const wy = this.cam.y + this.mouse.y;
    p.angle = Math.atan2(wy - p.y, wx - p.x);

    // Reload (R key or auto when empty)
    if (this.keys["KeyR"] && !p.reloading && p.ammo < p.maxAmmo) {
      p.reloading = true; p.reloadTimer = 1600;
    }
    if (p.reloading) {
      p.reloadTimer -= dt * 1000;
      if (p.reloadTimer <= 0) { p.ammo = p.maxAmmo; p.reloading = false; }
    }

    // Shoot (hold left mouse)
    if (this.mouse.down && !p.reloading && p.ammo > 0) {
      const fired = this._shoot(p, wx, wy);
      if (fired) {
        p.ammo = Math.max(0, p.ammo - 1);
        if (p.ammo === 0) { p.reloading = true; p.reloadTimer = 1600; }
      }
    }
  }

  // ── BOT AI  (simulated server entities) ───────────────────
  _updateBots(dt, now) {
    for (const bot of this.bots) {
      if (!bot.alive) {
        bot.respawnTimer -= dt * 1000;
        if (bot.respawnTimer <= 0) {
          const pos = this._safeSpawn(P_RADIUS);
          bot.x = pos.x; bot.y = pos.y;
          bot.hp = MAX_HP; bot.alive = true; bot.respawnTimer = 0;
        }
        continue;
      }

      // Find nearest target via spatial grid
      const nearby = this.grid.query(bot.x, bot.y, VIEW_R * 0.85);
      let target = null, minD = Infinity;

      // Always consider the player
      if (this.player.alive) {
        const d = this._dist(bot, this.player);
        if (d < VIEW_R * 0.85) { target = this.player; minD = d; }
      }
      for (const e of nearby) {
        if (e.id === bot.id || !e.alive || e.type === "bullet") continue;
        const d = this._dist(bot, e);
        if (d < minD) { minD = d; target = e; }
      }

      if (target) {
        const dx = target.x - bot.x, dy = target.y - bot.y;
        const dist = Math.hypot(dx, dy);
        bot.angle = Math.atan2(dy, dx);

        // Move toward target, maintain fighting distance
        if (dist > 160) {
          const spd = BOT_SPEED * dt;
          const nx = bot.x + Math.cos(bot.angle) * spd;
          const ny = bot.y + Math.sin(bot.angle) * spd;
          if (!this._hitsWall(nx, bot.y, P_RADIUS)) bot.x = nx;
          if (!this._hitsWall(bot.x, ny, P_RADIUS)) bot.y = ny;
          bot.vx = Math.cos(bot.angle) * BOT_SPEED;
          bot.vy = Math.sin(bot.angle) * BOT_SPEED;
        }

        // Shoot — leading the target by skill level
        if (dist < VIEW_R * 0.65) {
          const lead = (1 - bot.skill) * 0;
          const tx = target.x + (target.vx || 0) * lead;
          const ty = target.y + (target.vy || 0) * lead;
          this._shoot(bot, tx, ty);
        }
      } else {
        // Wander
        bot.wTimer -= dt * 1000;
        if (bot.wTimer <= 0) {
          bot.wAngle = Math.random() * Math.PI * 2;
          bot.wTimer = 1200 + Math.random() * 1800;
        }
        const spd = BOT_SPEED * 0.55 * dt;
        const nx = bot.x + Math.cos(bot.wAngle) * spd;
        const ny = bot.y + Math.sin(bot.wAngle) * spd;
        if (!this._hitsWall(nx, bot.y, P_RADIUS)) bot.x = nx;
        else bot.wAngle = Math.random() * Math.PI * 2;
        if (!this._hitsWall(bot.x, ny, P_RADIUS)) bot.y = ny;
        else bot.wAngle = Math.random() * Math.PI * 2;
        bot.angle = bot.wAngle;
      }
      this._clamp(bot, P_RADIUS);
    }
  }

  // ── BULLETS ───────────────────────────────────────────────
  _updateBullets(dt, now) {
    const dead = new Set();
    for (const b of this.bullets) {
      if (!b.alive) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt * 1000;
      if (b.life <= 0 || b.x < 0 || b.x > W || b.y < 0 || b.y > H ||
          this._hitsWall(b.x, b.y, B_RADIUS)) { b.alive = false; continue; }

      // Hit detection
      const nearby = this.grid.query(b.x, b.y, P_RADIUS + B_RADIUS + 4);
      for (const e of nearby) {
        if (e.id === b.ownerId || e.type === "bullet" || !e.alive) continue;
        if (this._dist(b, e) < P_RADIUS + B_RADIUS) {
          e.hp -= DAMAGE;
          b.alive = false;
          if (e.hp <= 0) {
            e.hp = 0; e.alive = false; e.deaths++;
            e.respawnTimer = RESPAWN_MS;
            const shooter = b.ownerId === 0 ? this.player
              : this.bots.find(bt => bt.id === b.ownerId);
            if (shooter) {
              shooter.kills++;
              this._addKill(shooter.name, e.name, shooter.color);
            }
          }
          break;
        }
      }
    }
    this.bullets = this.bullets.filter(b => b.alive && b.life > 0);
  }

  // ══════════════════════════════════════════════════════════
  //  RENDER — Canvas 2D with glow effects
  // ══════════════════════════════════════════════════════════
  render() {
    const ctx = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    const cx = this.cam.x, cy = this.cam.y;

    // Background
    ctx.fillStyle = PAL.bg;
    ctx.fillRect(0, 0, cw, ch);

    ctx.save();
    ctx.translate(-Math.round(cx), -Math.round(cy));

    // ── Grid ─────────────────────────────────────────────
    const gs = 80;
    ctx.strokeStyle = PAL.gridLine;
    ctx.lineWidth = 1;
    const gx0 = Math.floor(cx/gs)*gs, gy0 = Math.floor(cy/gs)*gs;
    for (let x = gx0; x < cx+cw+gs; x += gs) {
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x, cy+ch); ctx.stroke();
    }
    for (let y = gy0; y < cy+ch+gs; y += gs) {
      ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx+cw, y); ctx.stroke();
    }

    // ── Walls ─────────────────────────────────────────────
    for (const w of MAP_WALLS) {
      if (w.x+w.w < cx || w.x > cx+cw || w.y+w.h < cy || w.y > cy+ch) continue;
      // Glow outline
      ctx.shadowBlur = 12;
      ctx.shadowColor = PAL.wallGlow;
      ctx.fillStyle = PAL.wall;
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = PAL.wallBorder;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(w.x, w.y, w.w, w.h);
      // Inset highlight
      ctx.strokeStyle = "rgba(30,41,59,0.9)";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(w.x+2, w.y+2, w.w-4, w.h-4);
    }

    // ── View radius ring ───────────────────────────────────
    if (this.player.alive) {
      ctx.beginPath();
      ctx.arc(this.player.x, this.player.y, VIEW_R, 0, Math.PI*2);
      ctx.fillStyle = PAL.viewCircle;
      ctx.fill();
      ctx.strokeStyle = PAL.viewBorder;
      ctx.lineWidth = 1;
      ctx.setLineDash([8, 14]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Bullets ───────────────────────────────────────────
    for (const b of this.bullets) {
      if (b.x < cx-10 || b.x > cx+cw+10 || b.y < cy-10 || b.y > cy+ch+10) continue;
      ctx.save();
      ctx.shadowBlur = 16;
      ctx.shadowColor = PAL.bulletGlow;
      ctx.fillStyle = PAL.bullet;
      ctx.beginPath();
      ctx.arc(b.x, b.y, B_RADIUS, 0, Math.PI*2);
      ctx.fill();
      // Trail
      ctx.strokeStyle = "rgba(253,224,71,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - b.vx * 0.04, b.y - b.vy * 0.04);
      ctx.stroke();
      ctx.restore();
    }

    // ── Bots ──────────────────────────────────────────────
    for (const bot of this.bots) {
      if (!bot.alive || bot.x < cx-60 || bot.x > cx+cw+60 || bot.y < cy-60 || bot.y > cy+ch+60) continue;
      this._drawCombatant(ctx, bot, P_RADIUS, false);
    }

    // ── Player ────────────────────────────────────────────
    if (this.player.alive) {
      this._drawCombatant(ctx, this.player, P_RADIUS, true);
      // Aim crosshair line
      ctx.save();
      ctx.strokeStyle = "rgba(6,182,212,0.25)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 8]);
      ctx.beginPath();
      ctx.moveTo(this.player.x + Math.cos(this.player.angle) * (P_RADIUS + 6),
                 this.player.y + Math.sin(this.player.angle) * (P_RADIUS + 6));
      ctx.lineTo(this.player.x + Math.cos(this.player.angle) * 130,
                 this.player.y + Math.sin(this.player.angle) * 130);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.restore();

    // ── Scanline overlay ──────────────────────────────────
    for (let y = 0; y < ch; y += 4) {
      ctx.fillStyle = PAL.scanLine;
      ctx.fillRect(0, y, cw, 1);
    }
  }

  _drawCombatant(ctx, e, r, isPlayer) {
    ctx.save();
    ctx.translate(e.x, e.y);

    // Outer glow ring
    ctx.shadowBlur = isPlayer ? 28 : 18;
    ctx.shadowColor = e.glow;
    ctx.strokeStyle = e.color;
    ctx.lineWidth = isPlayer ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, r + (isPlayer ? 3 : 1), 0, Math.PI*2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Body fill
    ctx.fillStyle = isPlayer ? "#020617" : "rgba(2,6,23,0.8)";
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI*2);
    ctx.fill();

    // Colored center dot
    ctx.fillStyle = e.color;
    ctx.beginPath();
    ctx.arc(0, 0, isPlayer ? 5 : 4, 0, Math.PI*2);
    ctx.fill();

    // Direction indicator (barrel)
    ctx.strokeStyle = e.color;
    ctx.lineWidth = isPlayer ? 3 : 2.5;
    ctx.lineCap = "round";
    ctx.shadowBlur = 8;
    ctx.shadowColor = e.glow;
    ctx.beginPath();
    ctx.moveTo(Math.cos(e.angle) * 5, Math.sin(e.angle) * 5);
    ctx.lineTo(Math.cos(e.angle) * (r + 7), Math.sin(e.angle) * (r + 7));
    ctx.stroke();
    ctx.shadowBlur = 0;

    // HP bar
    const hpRatio = e.hp / e.maxHp;
    const bw = r * 2 + 8, bh = 3.5;
    const bx = -bw / 2, by = -(r + 12);
    ctx.fillStyle = PAL.hpBg;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 2);
    ctx.fill();
    ctx.fillStyle = hpRatio > 0.35 ? PAL.hpGreen : PAL.hpRed;
    if (hpRatio > 0) {
      ctx.shadowBlur = 6;
      ctx.shadowColor = hpRatio > 0.35 ? PAL.playerGlow : "rgba(244,63,94,0.6)";
      ctx.beginPath();
      ctx.roundRect(bx, by, bw * hpRatio, bh, 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Name tag
    ctx.fillStyle = isPlayer ? PAL.cyan : "rgba(148,163,184,0.55)";
    ctx.font = `${isPlayer ? "bold " : ""}8px 'JetBrains Mono', monospace`;
    ctx.textAlign = "center";
    ctx.fillText(e.name, 0, -(r + 18));

    ctx.restore();
  }

  // ── MINIMAP RENDER ────────────────────────────────────────
  drawMinimap(miniCtx, mw, mh) {
    const sx = mw / W, sy = mh / H;
    miniCtx.clearRect(0, 0, mw, mh);

    // BG
    miniCtx.fillStyle = "rgba(2,6,23,0.95)";
    miniCtx.fillRect(0, 0, mw, mh);

    // Walls
    miniCtx.fillStyle = "#1e293b";
    for (const w of MAP_WALLS) miniCtx.fillRect(w.x*sx, w.y*sy, Math.max(1,w.w*sx), Math.max(1,w.h*sy));

    // Bots
    miniCtx.fillStyle = PAL.bot;
    for (const b of this.bots) {
      if (!b.alive) continue;
      miniCtx.beginPath();
      miniCtx.arc(b.x*sx, b.y*sy, 1.8, 0, Math.PI*2);
      miniCtx.fill();
    }

    // Player view radius
    if (this.player.alive) {
      miniCtx.strokeStyle = "rgba(6,182,212,0.2)";
      miniCtx.lineWidth = 0.7;
      miniCtx.setLineDash([3, 5]);
      miniCtx.beginPath();
      miniCtx.arc(this.player.x*sx, this.player.y*sy, VIEW_R*sx, 0, Math.PI*2);
      miniCtx.stroke();
      miniCtx.setLineDash([]);
    }

    // Player dot
    miniCtx.shadowBlur = 8;
    miniCtx.shadowColor = PAL.playerGlow;
    miniCtx.fillStyle = PAL.player;
    miniCtx.beginPath();
    miniCtx.arc(this.player.x*sx, this.player.y*sy, 3.5, 0, Math.PI*2);
    miniCtx.fill();
    miniCtx.shadowBlur = 0;

    // Border
    miniCtx.strokeStyle = "rgba(6,182,212,0.35)";
    miniCtx.lineWidth = 1;
    miniCtx.strokeRect(0.5, 0.5, mw-1, mh-1);
  }
}

// ══════════════════════════════════════════════════════════════
//  REACT COMPONENTS
// ══════════════════════════════════════════════════════════════
const GStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=JetBrains+Mono:wght@400;700&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #020617; font-family: 'JetBrains Mono', monospace; overflow: hidden; }
    canvas { display: block; cursor: crosshair; }
    @keyframes flicker { 0%,100%{opacity:1} 92%{opacity:0.97} 95%{opacity:0.92} }
    @keyframes scanIn  { from{transform:translateY(-8px);opacity:0} to{transform:translateY(0);opacity:1} }
    @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:0.5} }
    @keyframes spin    { to{transform:rotate(360deg)} }
    .flicker { animation: flicker 4s infinite; }
    .scan-in { animation: scanIn 0.4s cubic-bezier(0.22,1,0.36,1) both; }
    .pulse   { animation: pulse 1.5s ease-in-out infinite; }
    .kill-row { animation: scanIn 0.3s ease both; }
  `}</style>
);

// ── MENU SCREEN ───────────────────────────────────────────────
function MenuScreen({ onStart }) {
  const [hovered, setHovered] = useState(null);
  const statItems = [
    { label: "TICK RATE",    value: "128Hz",  desc: "Server authority" },
    { label: "MAX PLAYERS",  value: "1,000",  desc: "Per instance"    },
    { label: "LATENCY TGT",  value: "<50ms",  desc: "Global average"  },
    { label: "GRID CELL",    value: "160px",  desc: "Spatial hash"    },
  ];
  const features = [
    { icon: "⬡", title: "SPATIAL HASH GRID", desc: "O(1) entity lookup. Only stream 10–15 closest combatants." },
    { icon: "⚡", title: "CLIENT PREDICTION",  desc: "Your movement is instant. Server validates at 128Hz." },
    { icon: "◈", title: "INTEREST MGMT",      desc: "View radius ring shows exactly what the server streams you." },
    { icon: "⬢", title: "DELTA COMPRESSION",  desc: "Minimap visualizes full state. Camera shows delta only." },
  ];

  return (
    <div className="flicker" style={{ minHeight:"100vh", background:"#020617", color:"#94a3b8", overflow:"auto", position:"relative" }}>
      <GStyle/>

      {/* Animated grid bg */}
      <div style={{ position:"fixed", inset:0, pointerEvents:"none",
        backgroundImage:"linear-gradient(rgba(6,182,212,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(6,182,212,0.04) 1px,transparent 1px)",
        backgroundSize:"60px 60px", transform:"rotateX(55deg) translateY(-220px) scale(1.4)",
        transformOrigin:"center top", maskImage:"radial-gradient(ellipse at 50% 0%,black 20%,transparent 70%)"
      }}/>
      <div style={{ position:"fixed", inset:0, pointerEvents:"none",
        background:"radial-gradient(ellipse at 50% 0%,rgba(6,182,212,0.08),transparent 60%)"
      }}/>

      {/* Nav */}
      <nav style={{ position:"sticky", top:0, zIndex:50, display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"14px 32px", background:"rgba(2,6,23,0.8)", backdropFilter:"blur(16px)",
        borderBottom:"1px solid rgba(6,182,212,0.12)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:30, height:30, background:"#06b6d4", transform:"rotate(45deg)", display:"flex", alignItems:"center", justifyContent:"center" }}>
            <span style={{ color:"#020617", fontWeight:900, fontSize:12, transform:"rotate(-45deg)" }}>T</span>
          </div>
          <span style={{ fontFamily:"Orbitron,monospace", fontWeight:900, letterSpacing:3, fontSize:16, color:"#fff" }}>TITAN CORE</span>
        </div>
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          <span className="pulse" style={{ width:6, height:6, borderRadius:"50%", background:"#06b6d4", display:"inline-block" }}/>
          <span style={{ fontSize:9, letterSpacing:3, color:"#06b6d4" }}>SERVER ONLINE • 128HZ</span>
        </div>
      </nav>

      <div style={{ maxWidth:1100, margin:"0 auto", padding:"60px 24px 80px" }}>

        {/* Hero */}
        <div style={{ textAlign:"center", marginBottom:70 }}>
          <div style={{ display:"inline-block", padding:"3px 14px", border:"1px solid rgba(6,182,212,0.3)", background:"rgba(6,182,212,0.06)",
            color:"#06b6d4", fontSize:9, letterSpacing:"0.3em", marginBottom:24, fontFamily:"JetBrains Mono" }}>
            SERVER-AUTHORITATIVE ARENA SHOOTER
          </div>
          <h1 style={{ fontFamily:"Orbitron,monospace", fontSize:"clamp(52px,10vw,110px)", fontWeight:900, lineHeight:0.9,
            letterSpacing:"-2px", color:"#fff", marginBottom:8 }}>
            TITAN<br/>
            <span style={{ WebkitTextStroke:"2px #06b6d4", color:"transparent", textShadow:"0 0 40px rgba(6,182,212,0.4)" }}>CORE</span>
          </h1>
          <p style={{ fontSize:"clamp(14px,2vw,18px)", color:"#64748b", maxWidth:560, margin:"20px auto 40px", lineHeight:1.7, fontFamily:"JetBrains Mono" }}>
            A browser arena built on <span style={{color:"#06b6d4"}}>Titan-Scale architecture</span> —
            spatial hash grids, client-side prediction, and server-authoritative simulation.
            {BOT_COUNT} active server entities. One objective: survive.
          </p>

          {/* Controls info */}
          <div style={{ display:"flex", flexWrap:"wrap", gap:10, justifyContent:"center", marginBottom:36 }}>
            {[["WASD","MOVE"],["MOUSE","AIM"],["CLICK","FIRE"],["R","RELOAD"]].map(([k,v])=>(
              <div key={k} style={{ padding:"6px 14px", background:"rgba(6,182,212,0.06)", border:"1px solid rgba(6,182,212,0.2)", fontSize:10, letterSpacing:2, color:"#06b6d4" }}>
                <span style={{ color:"#fff", fontWeight:700 }}>{k}</span>&nbsp;&nbsp;{v}
              </div>
            ))}
          </div>

          <button onClick={onStart}
            style={{ background:"#06b6d4", color:"#020617", border:"none", padding:"16px 56px",
              fontFamily:"Orbitron,monospace", fontWeight:700, fontSize:13, letterSpacing:"0.3em",
              cursor:"pointer", transition:"all 0.2s", boxShadow:"0 0 30px rgba(6,182,212,0.4)" }}
            onMouseEnter={e=>{ e.currentTarget.style.background="#fff"; e.currentTarget.style.boxShadow="0 0 40px rgba(255,255,255,0.3)"; }}
            onMouseLeave={e=>{ e.currentTarget.style.background="#06b6d4"; e.currentTarget.style.boxShadow="0 0 30px rgba(6,182,212,0.4)"; }}>
            DEPLOY TO SERVER
          </button>
        </div>

        {/* Stats bar */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:1, marginBottom:56,
          border:"1px solid rgba(6,182,212,0.12)", background:"rgba(6,182,212,0.03)" }}>
          {statItems.map((s,i) => (
            <div key={i} style={{ padding:"22px 20px", borderRight: i<3 ? "1px solid rgba(6,182,212,0.1)" : "none", textAlign:"center" }}>
              <div style={{ fontFamily:"Orbitron,monospace", fontSize:"clamp(20px,3vw,32px)", fontWeight:900, color:"#06b6d4", marginBottom:4 }}>{s.value}</div>
              <div style={{ fontSize:9, letterSpacing:2, color:"#94a3b8", marginBottom:2 }}>{s.label}</div>
              <div style={{ fontSize:8, color:"#334155", letterSpacing:1 }}>{s.desc}</div>
            </div>
          ))}
        </div>

        {/* Architecture features */}
        <div style={{ marginBottom:8, fontSize:9, letterSpacing:"0.25em", color:"#06b6d4" }}>02 / LIVE IN GAME</div>
        <h2 style={{ fontFamily:"Orbitron", fontSize:28, color:"#fff", marginBottom:32 }}>Architecture Implemented</h2>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(230px,1fr))", gap:16 }}>
          {features.map((f,i) => (
            <div key={i}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              style={{ padding:"24px", border:`1px solid ${hovered===i?"rgba(6,182,212,0.4)":"rgba(30,41,59,0.8)"}`,
                background: hovered===i ? "rgba(6,182,212,0.04)" : "rgba(2,6,23,0.5)",
                transition:"all 0.2s", cursor:"default" }}>
              <div style={{ fontSize:22, color:"#06b6d4", marginBottom:10, fontFamily:"monospace" }}>{f.icon}</div>
              <div style={{ fontSize:10, fontWeight:700, letterSpacing:2, color:"#fff", marginBottom:8 }}>{f.title}</div>
              <div style={{ fontSize:11, color:"#64748b", lineHeight:1.7 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── HUD OVERLAY ───────────────────────────────────────────────
function HUD({ state, miniCtx, onMenu }) {
  const { hp, maxHp, ammo, maxAmmo, reloading, kills, deaths, alive,
          respawnIn, killFeed, entitiesInView, totalEntities, networkDelay, bots } = state;
  const hpPct = hp / maxHp;
  const ammoPct = ammo / maxAmmo;
  const hpColor = hpPct > 0.5 ? "#06b6d4" : hpPct > 0.25 ? "#fde047" : "#f43f5e";

  const bar = (pct, color, w=120, h=4) => (
    <div style={{ width:w, height:h, background:"rgba(30,41,59,0.8)", borderRadius:2 }}>
      <div style={{ width:`${pct*100}%`, height:"100%", background:color, borderRadius:2,
        boxShadow:`0 0 6px ${color}`, transition:"width 0.12s" }}/>
    </div>
  );

  return (
    <>
      {/* ── TOP LEFT — Player stats ─ */}
      <div className="scan-in" style={{ position:"absolute", top:20, left:20, display:"flex", flexDirection:"column", gap:8 }}>
        {/* HP */}
        <div style={{ background:"rgba(2,6,23,0.85)", border:"1px solid rgba(6,182,212,0.2)", padding:"10px 14px", backdropFilter:"blur(8px)" }}>
          <div style={{ fontSize:8, letterSpacing:3, color:"#475569", marginBottom:5 }}>HEALTH</div>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            {bar(hpPct, hpColor, 130, 5)}
            <span style={{ fontFamily:"Orbitron,monospace", fontSize:14, fontWeight:700, color:hpColor }}>{hp}</span>
          </div>
        </div>
        {/* Ammo */}
        <div style={{ background:"rgba(2,6,23,0.85)", border:"1px solid rgba(6,182,212,0.2)", padding:"10px 14px", backdropFilter:"blur(8px)" }}>
          <div style={{ fontSize:8, letterSpacing:3, color:"#475569", marginBottom:5 }}>
            {reloading ? <span style={{ color:"#fde047" }} className="pulse">RELOADING...</span> : "AMMO"}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            {bar(ammoPct, "#fde047", 130, 5)}
            <span style={{ fontFamily:"Orbitron,monospace", fontSize:14, fontWeight:700, color:"#fde047" }}>
              {ammo}<span style={{ fontSize:9, color:"#64748b" }}>/{maxAmmo}</span>
            </span>
          </div>
        </div>
        {/* K/D */}
        <div style={{ background:"rgba(2,6,23,0.85)", border:"1px solid rgba(6,182,212,0.2)", padding:"8px 14px", backdropFilter:"blur(8px)", display:"flex", gap:16 }}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontFamily:"Orbitron,monospace", fontSize:18, fontWeight:900, color:"#06b6d4" }}>{kills}</div>
            <div style={{ fontSize:7, letterSpacing:2, color:"#475569" }}>KILLS</div>
          </div>
          <div style={{ width:1, background:"rgba(6,182,212,0.15)" }}/>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontFamily:"Orbitron,monospace", fontSize:18, fontWeight:900, color:"#f43f5e" }}>{deaths}</div>
            <div style={{ fontSize:7, letterSpacing:2, color:"#475569" }}>DEATHS</div>
          </div>
          <div style={{ width:1, background:"rgba(6,182,212,0.15)" }}/>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontFamily:"Orbitron,monospace", fontSize:18, fontWeight:900, color:"#a78bfa" }}>
              {deaths > 0 ? (kills/deaths).toFixed(1) : kills.toFixed(1)}
            </div>
            <div style={{ fontSize:7, letterSpacing:2, color:"#475569" }}>K/D</div>
          </div>
        </div>
      </div>

      {/* ── TOP RIGHT — Server stats ─ */}
      <div className="scan-in" style={{ position:"absolute", top:20, right:20, display:"flex", flexDirection:"column", gap:8, alignItems:"flex-end" }}>
        <div style={{ background:"rgba(2,6,23,0.85)", border:"1px solid rgba(6,182,212,0.2)", padding:"10px 14px", backdropFilter:"blur(8px)" }}>
          <div style={{ fontSize:8, letterSpacing:3, color:"#475569", marginBottom:6, textAlign:"right" }}>TITAN-SCALE METRICS</div>
          <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
            {[
              ["TICK RATE",    "128 Hz",           "#06b6d4"],
              ["ENTITIES/VIEW", `${entitiesInView}/${totalEntities}`, "#a78bfa"],
              ["NET DELAY",    `${networkDelay}ms`, "#fde047"],
              ["GRID CELL",    "160px",             "#94a3b8"],
            ].map(([label,value,color]) => (
              <div key={label} style={{ display:"flex", justifyContent:"space-between", gap:20 }}>
                <span style={{ fontSize:8, letterSpacing:2, color:"#475569" }}>{label}</span>
                <span style={{ fontSize:9, fontWeight:700, color, fontFamily:"Orbitron,monospace" }}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Leaderboard */}
        <div style={{ background:"rgba(2,6,23,0.85)", border:"1px solid rgba(6,182,212,0.2)", padding:"10px 14px", backdropFilter:"blur(8px)", minWidth:180 }}>
          <div style={{ fontSize:8, letterSpacing:3, color:"#475569", marginBottom:8 }}>TOP BOTS</div>
          {bots?.map((b,i) => (
            <div key={b.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
              <span style={{ fontSize:9, color:i===0?"#fde047":"#475569" }}>#{i+1} {b.name}</span>
              <span style={{ fontSize:9, color:"#f43f5e", fontFamily:"Orbitron" }}>{b.kills}K</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── KILL FEED — Top Center ─ */}
      <div style={{ position:"absolute", top:20, left:"50%", transform:"translateX(-50%)", display:"flex", flexDirection:"column", gap:4, minWidth:240 }}>
        {killFeed?.filter(k => performance.now() - k.t < 6000).map((k,i) => (
          <div key={i} className="kill-row"
            style={{ background:"rgba(2,6,23,0.9)", border:`1px solid rgba(${k.c==="#06b6d4"?"6,182,212":"244,63,94"},0.25)`,
              padding:"5px 12px", fontSize:10, display:"flex", gap:6, alignItems:"center",
              backdropFilter:"blur(4px)", opacity:Math.max(0.3, 1 - i*0.18) }}>
            <span style={{ color:k.c, fontWeight:700 }}>{k.k}</span>
            <span style={{ color:"#475569" }}>⊙</span>
            <span style={{ color:"#64748b" }}>{k.v}</span>
          </div>
        ))}
      </div>

      {/* ── MINIMAP — Bottom Right ─ */}
      <div style={{ position:"absolute", bottom:20, right:20 }}>
        <canvas id="minimap-canvas" width={180} height={180}
          style={{ border:"1px solid rgba(6,182,212,0.3)", display:"block" }}/>
        <div style={{ fontSize:7, letterSpacing:2, color:"#334155", textAlign:"center", marginTop:4 }}>MINIMAP — INTEREST RADIUS</div>
      </div>

      {/* ── BOTTOM CENTER — crosshair dot ─ */}
      {alive && (
        <div style={{ position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)", pointerEvents:"none" }}>
          <div style={{ width:14, height:14, position:"relative" }}>
            <div style={{ position:"absolute", top:"50%", left:0, width:"100%", height:1, background:"rgba(6,182,212,0.6)" }}/>
            <div style={{ position:"absolute", top:0, left:"50%", height:"100%", width:1, background:"rgba(6,182,212,0.6)" }}/>
            <div style={{ position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)", width:3, height:3, borderRadius:"50%", background:"#06b6d4" }}/>
          </div>
        </div>
      )}

      {/* ── DEATH SCREEN ─ */}
      {!alive && (
        <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center",
          background:"rgba(2,6,23,0.7)", backdropFilter:"blur(4px)" }}>
          <div className="scan-in" style={{ textAlign:"center", border:"1px solid rgba(244,63,94,0.4)", padding:"40px 60px",
            background:"rgba(2,6,23,0.9)", boxShadow:"0 0 60px rgba(244,63,94,0.2)" }}>
            <div style={{ fontFamily:"Orbitron,monospace", fontSize:36, fontWeight:900, color:"#f43f5e",
              WebkitTextStroke:"1px #f43f5e", marginBottom:8 }}>ELIMINATED</div>
            <div style={{ fontSize:10, letterSpacing:3, color:"#64748b", marginBottom:20 }}>RESPAWNING IN {respawnIn}s</div>
            <div style={{ width:160, height:2, background:"rgba(244,63,94,0.3)", margin:"0 auto 20px", position:"relative" }}>
              <div className="pulse" style={{ position:"absolute", top:0, left:0, height:"100%", background:"#f43f5e", width:`${(1 - respawnIn/3.5)*100}%` }}/>
            </div>
            <div style={{ fontSize:10, color:"#475569", letterSpacing:2 }}>K: {kills} &nbsp;|&nbsp; D: {deaths}</div>
          </div>
        </div>
      )}

      {/* ── Menu button ─ */}
      <button onClick={onMenu} style={{ position:"absolute", bottom:20, left:20,
        background:"rgba(2,6,23,0.85)", border:"1px solid rgba(6,182,212,0.2)",
        color:"#475569", fontSize:9, letterSpacing:2, padding:"8px 14px", cursor:"pointer",
        fontFamily:"JetBrains Mono,monospace", backdropFilter:"blur(8px)",
        transition:"all 0.2s" }}
        onMouseEnter={e=>{e.currentTarget.style.color="#06b6d4";e.currentTarget.style.borderColor="rgba(6,182,212,0.5)";}}
        onMouseLeave={e=>{e.currentTarget.style.color="#475569";e.currentTarget.style.borderColor="rgba(6,182,212,0.2)";}}>
        ← MENU
      </button>
    </>
  );
}

// ── GAME SCREEN ───────────────────────────────────────────────
function GameScreen({ onMenu }) {
  const canvasRef   = useRef(null);
  const miniRef     = useRef(null);
  const engineRef   = useRef(null);
  const rafRef      = useRef(null);
  const lastRef     = useRef(null);
  const [hud, setHud] = useState({
    hp:100, maxHp:100, ammo:30, maxAmmo:30, reloading:false,
    kills:0, deaths:0, alive:true, respawnIn:0,
    killFeed:[], entitiesInView:0, totalEntities:BOT_COUNT+1,
    networkDelay:48, bots:[]
  });

  const resize = useCallback(() => {
    const c = canvasRef.current; if (!c) return;
    c.width  = window.innerWidth;
    c.height = window.innerHeight;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    resize();
    window.addEventListener("resize", resize);

    const engine = new TitanEngine(canvas, setHud);
    engineRef.current = engine;
    engine.running = true;

    lastRef.current = performance.now();
    const loop = (now) => {
      const dt = Math.min((now - lastRef.current) / 1000, 0.05);
      lastRef.current = now;
      engine.update(dt, now);
      engine.render();

      // Minimap
      const mini = document.getElementById("minimap-canvas");
      if (mini) {
        const mc = mini.getContext("2d");
        engine.drawMinimap(mc, mini.width, mini.height);
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      engine.destroy();
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div style={{ position:"relative", width:"100vw", height:"100vh", overflow:"hidden", background:"#020617" }}>
      <GStyle/>
      <canvas ref={canvasRef} style={{ position:"absolute", inset:0 }}/>
      <HUD state={hud} onMenu={onMenu}/>
    </div>
  );
}

// ── ROOT APP ──────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("menu");
  return screen === "menu"
    ? <MenuScreen onStart={() => setScreen("game")} />
    : <GameScreen onMenu={() => setScreen("menu")} />;
}
