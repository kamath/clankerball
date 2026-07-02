/* ============================================================
   renderer.ts — canvas renderer for the court and players
   Ported from ui.js with drawing logic preserved exactly.
   ============================================================ */
import { COURT } from "@repo/shared";

export const SCALE = 10; // px per foot
export const PAD = 32; // out-of-bounds apron in px

/* The subset of the game state the renderer actually reads. The live `Game`
   satisfies this structurally, and a replay feeds a lightweight scene built
   from recorded frames — so both paths share the exact same drawing code. */
interface SceneVec {
  x: number;
  y: number;
}
interface ScenePlayer {
  pos: SceneVec;
  heightIn: number;
  number: number;
  name: string;
  annotation?: string | null;
  path?: SceneVec[] | null;
}
export interface DrawScene {
  lab: unknown;
  teams: { name: string; score: number; color: string; players: ScenePlayer[] }[];
  ball: { pos: SceneVec; air: number; holder: ScenePlayer | null };
  phase?: string;
  inb?: { inbounder: { pos: SceneVec } } | null;
  over: boolean;
}

/* Play-diagram glyphs for the staged lab possession, in classic coaching
   notation: a screen is a line capped with a perpendicular bar, a cut/roll
   is a solid arrow, a dribble is a wavy arrow, an iso is a dashed ring.
   Glyphs hold live player references, so they track drags while staged.
   `action` ties a glyph back to its plan-action index, for hover-linking
   with the sidebar and on-court select/delete. */
export type OverlayGlyph = (
  | { kind: "screen"; from: ScenePlayer; to: ScenePlayer }
  | { kind: "cut"; from: ScenePlayer; to: SceneVec }
  | { kind: "drive"; from: ScenePlayer; via: ScenePlayer; to: SceneVec }
  | { kind: "free"; from: ScenePlayer; away: ScenePlayer }
  | { kind: "ring"; on: ScenePlayer }
) & { action?: number };

/** A screen gesture in progress: screener → pointer, hovered teammate lit. */
export interface PendingScreen {
  from: ScenePlayer;
  to: SceneVec;
  over: ScenePlayer | null;
}

export class Renderer {
  cv: HTMLCanvasElement;
  W: number;
  H: number;
  ctx: CanvasRenderingContext2D;
  time: number;
  courtLayer: HTMLCanvasElement | null;
  colors: string[] = [];
  /** action diagram for the staged lab possession; null = no overlay */
  overlay: OverlayGlyph[] | null = null;
  /** players whose movement a plan action owns — their routes draw dimmed */
  ownedByAction: Set<ScenePlayer> = new Set();
  /** plan-action index to emphasize (sidebar/court hover); null = none */
  highlightAction: number | null = null;
  /** plan-action index selected on court (shows the ✕ delete badge) */
  selectedAction: number | null = null;
  /** in-flight screen gesture, drawn as a tentative glyph */
  pending: PendingScreen | null = null;
  /** one grab-handle per action, in court feet (rebuilt every draw) */
  private handles: { action: number; x: number; y: number }[] = [];
  /** where the ✕ badge for the selected action was drawn, in court feet */
  private deleteBadge: { action: number; x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.cv = canvas;
    this.W = COURT.W * SCALE + PAD * 2;
    this.H = COURT.H * SCALE + PAD * 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = this.W * dpr;
    canvas.height = this.H * dpr;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.scale(dpr, dpr);
    this.time = 0;
    this.courtLayer = null;
  }

  px(x: number) {
    return PAD + x * SCALE;
  }
  py(y: number) {
    return PAD + y * SCALE;
  }

  setTeams(colors: string[]) {
    this.colors = colors;
    this.courtLayer = this.buildCourt(colors);
  }

  buildCourt(colors: string[]) {
    const cv = document.createElement("canvas");
    cv.width = this.W;
    cv.height = this.H;
    const c = cv.getContext("2d")!;

    // apron
    c.fillStyle = "#181210";
    c.fillRect(0, 0, this.W, this.H);

    // hardwood
    const x0 = this.px(0),
      y0 = this.py(0);
    const w = COURT.W * SCALE,
      h = COURT.H * SCALE;
    const grad = c.createLinearGradient(0, y0, 0, y0 + h);
    grad.addColorStop(0, "#c89a60");
    grad.addColorStop(0.5, "#d2a76e");
    grad.addColorStop(1, "#bd8b52");
    c.fillStyle = grad;
    c.fillRect(x0, y0, w, h);

    // planks
    c.save();
    c.beginPath();
    c.rect(x0, y0, w, h);
    c.clip();
    for (let row = 0; row < COURT.H / 2.5; row++) {
      const ry = y0 + row * 2.5 * SCALE;
      c.fillStyle = `rgba(80, 45, 12, ${row % 2 ? 0.045 : 0.02})`;
      c.fillRect(x0, ry, w, 2.5 * SCALE);
      c.strokeStyle = "rgba(70, 40, 10, 0.12)";
      c.lineWidth = 1;
      const off = (row % 3) * 2.3 * SCALE;
      for (let sx = x0 - 7 * SCALE + off; sx < x0 + w; sx += 7 * SCALE) {
        c.beginPath();
        c.moveTo(sx, ry);
        c.lineTo(sx, ry + 2.5 * SCALE);
        c.stroke();
      }
    }
    // soft sheen
    const sheen = c.createRadialGradient(
      x0 + w / 2,
      y0 + h / 2,
      40,
      x0 + w / 2,
      y0 + h / 2,
      w / 1.6
    );
    sheen.addColorStop(0, "rgba(255,245,220,0.10)");
    sheen.addColorStop(1, "rgba(40,20,5,0.12)");
    c.fillStyle = sheen;
    c.fillRect(x0, y0, w, h);
    c.restore();

    const line = "rgba(252,248,240,0.9)";
    c.strokeStyle = line;
    c.lineWidth = 2;

    // boundary + half court
    c.strokeRect(x0, y0, w, h);
    c.beginPath();
    c.moveTo(this.px(47), y0);
    c.lineTo(this.px(47), y0 + h);
    c.stroke();
    c.beginPath();
    c.arc(this.px(47), this.py(25), 6 * SCALE, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.arc(this.px(47), this.py(25), 2 * SCALE, 0, Math.PI * 2);
    c.fillStyle = "rgba(255,180,60,0.18)";
    c.fill();
    c.stroke();

    // center-court lettering
    c.fillStyle = "rgba(60,30,8,0.4)";
    c.font = `600 13px 'Big Shoulders Display', sans-serif`;
    c.textAlign = "center";
    c.fillText("FABLE", this.px(47), this.py(25) - 22);
    c.fillText("FIELDHOUSE", this.px(47), this.py(25) + 30);

    // each half: dir = +1 means key extends toward +x (left hoop side)
    const sides = [
      { hx: COURT.HOOP_X, dir: 1, base: 0, color: colors[1] },
      { hx: COURT.W - COURT.HOOP_X, dir: -1, base: COURT.W, color: colors[0] },
    ];
    for (const s of sides) {
      const bx = this.px(s.base);
      // painted key (16 ft wide, 19 ft deep)
      c.fillStyle = this.hexA(s.color, 0.26);
      const keyX = Math.min(bx, this.px(s.base + s.dir * 19));
      c.fillRect(keyX, this.py(17), 19 * SCALE, 16 * SCALE);
      c.strokeStyle = line;
      c.strokeRect(keyX, this.py(17), 19 * SCALE, 16 * SCALE);
      // free-throw circle
      c.beginPath();
      c.arc(this.px(s.base + s.dir * 19), this.py(25), 6 * SCALE, 0, Math.PI * 2);
      c.stroke();
      // 3pt line: corner lines + arc
      const th = Math.atan2(22, 8.95);
      const cornerEndX = this.px(s.base + s.dir * 14.2);
      c.beginPath();
      c.moveTo(bx, this.py(3));
      c.lineTo(cornerEndX, this.py(3));
      c.stroke();
      c.beginPath();
      c.moveTo(bx, this.py(47));
      c.lineTo(cornerEndX, this.py(47));
      c.stroke();
      c.beginPath();
      if (s.dir > 0) c.arc(this.px(s.hx), this.py(25), 23.75 * SCALE, -th, th);
      else c.arc(this.px(s.hx), this.py(25), 23.75 * SCALE, Math.PI - th, Math.PI + th);
      c.stroke();
      // restricted area
      c.beginPath();
      if (s.dir > 0) c.arc(this.px(s.hx), this.py(25), 4 * SCALE, -Math.PI / 2, Math.PI / 2);
      else c.arc(this.px(s.hx), this.py(25), 4 * SCALE, Math.PI / 2, Math.PI * 1.5);
      c.stroke();
      // backboard
      c.lineWidth = 4;
      c.beginPath();
      c.moveTo(this.px(s.base + s.dir * 4), this.py(22));
      c.lineTo(this.px(s.base + s.dir * 4), this.py(28));
      c.stroke();
      c.lineWidth = 2;
      // rim
      c.beginPath();
      c.arc(this.px(s.hx), this.py(25), 0.75 * SCALE, 0, Math.PI * 2);
      c.strokeStyle = "#ff8c2e";
      c.lineWidth = 3;
      c.stroke();
      c.strokeStyle = line;
      c.lineWidth = 2;
    }
    return cv;
  }

  hexA(hex: string, a: number) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  setPlanOverlay(glyphs: OverlayGlyph[] | null, ownedByAction?: ScenePlayer[]) {
    this.overlay = glyphs && glyphs.length ? glyphs : null;
    this.ownedByAction = new Set(ownedByAction ?? []);
    this.highlightAction = null;
    this.selectedAction = null;
    this.deleteBadge = null;
  }
  setHighlightAction(i: number | null) {
    this.highlightAction = i;
  }
  setSelectedAction(i: number | null) {
    this.selectedAction = i;
    if (i === null) this.deleteBadge = null;
  }
  setPending(p: PendingScreen | null) {
    this.pending = p;
  }
  /** Which action's grab-handle sits at this court point, if any. */
  hitAction(x: number, y: number): number | null {
    let best: number | null = null,
      bd = 1.8;
    for (const h of this.handles) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bd) {
        bd = d;
        best = h.action;
      }
    }
    return best;
  }
  /** Distance from the point to the nearest grab-handle, in feet. */
  handleDist(x: number, y: number): number {
    let bd = Infinity;
    for (const h of this.handles) {
      bd = Math.min(bd, Math.hypot(h.x - x, h.y - y));
    }
    return bd;
  }
  /** True when the point lands on the selected action's ✕ badge. */
  hitDelete(x: number, y: number): number | null {
    const b = this.deleteBadge;
    if (b && Math.hypot(b.x - x, b.y - y) < 1.6) return b.action;
    return null;
  }

  private arrowHead(c: CanvasRenderingContext2D, x: number, y: number, ang: number, size = 9) {
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x - size * Math.cos(ang - 0.45), y - size * Math.sin(ang - 0.45));
    c.moveTo(x, y);
    c.lineTo(x - size * Math.cos(ang + 0.45), y - size * Math.sin(ang + 0.45));
    c.stroke();
  }

  /** Draw the staged play's action diagram (coaching notation). */
  private drawOverlay(c: CanvasRenderingContext2D) {
    const dotR = (p: ScenePlayer) => 9 + (p.heightIn - 70) * 0.45;
    this.handles = [];
    let badge: { action: number; x: number; y: number } | null = null;
    const seen = new Set<number>();
    const focus = this.highlightAction ?? this.selectedAction;
    // the first glyph drawn for each action carries its grab-handle
    const handleAt = (g: OverlayGlyph, x: number, y: number) => {
      if (g.action == null || seen.has(g.action)) return;
      seen.add(g.action);
      this.handles.push({ action: g.action, x: (x - PAD) / SCALE, y: (y - PAD) / SCALE });
      if (g.action === this.selectedAction) {
        // ✕ badge floats just above the handle
        const bx = x + 14,
          by = y - 14;
        badge = { action: g.action, x: (bx - PAD) / SCALE, y: (by - PAD) / SCALE };
      }
    };
    c.save();
    c.lineCap = "round";
    c.shadowColor = "rgba(20,10,2,0.55)";
    c.shadowBlur = 3;
    for (const g of this.overlay!) {
      const dim = focus != null && g.action !== focus;
      const a = dim ? 0.3 : 0.95;
      c.strokeStyle = `rgba(255,205,90,${a})`;
      c.fillStyle = `rgba(255,205,90,${a})`;
      c.lineWidth = focus != null && g.action === focus ? 3.2 : 2.5;
      switch (g.kind) {
        case "screen": {
          // line from screener toward the man he picks, capped with the
          // perpendicular screen bar just short of the target
          const ax = this.px(g.from.pos.x),
            ay = this.py(g.from.pos.y);
          const bx = this.px(g.to.pos.x),
            by = this.py(g.to.pos.y);
          const ang = Math.atan2(by - ay, bx - ax);
          const start = dotR(g.from) + 3;
          const stop = Math.max(start, Math.hypot(bx - ax, by - ay) - dotR(g.to) - 6);
          const ex = ax + Math.cos(ang) * stop,
            ey = ay + Math.sin(ang) * stop;
          c.beginPath();
          c.moveTo(ax + Math.cos(ang) * start, ay + Math.sin(ang) * start);
          c.lineTo(ex, ey);
          c.stroke();
          c.beginPath();
          c.moveTo(ex - Math.sin(ang) * 7, ey + Math.cos(ang) * 7);
          c.lineTo(ex + Math.sin(ang) * 7, ey - Math.cos(ang) * 7);
          c.stroke();
          handleAt(g, ex, ey);
          break;
        }
        case "cut": {
          // solid arrow: where the action sends him (roll, pop, post seal)
          const ax = this.px(g.from.pos.x),
            ay = this.py(g.from.pos.y);
          const bx = this.px(g.to.x),
            by = this.py(g.to.y);
          const ang = Math.atan2(by - ay, bx - ax);
          const start = dotR(g.from) + 3;
          const stop = Math.max(start, Math.hypot(bx - ax, by - ay) - 8);
          const ex = ax + Math.cos(ang) * stop,
            ey = ay + Math.sin(ang) * stop;
          c.beginPath();
          c.moveTo(ax + Math.cos(ang) * start, ay + Math.sin(ang) * start);
          c.lineTo(ex, ey);
          c.stroke();
          this.arrowHead(c, ex, ey, ang);
          handleAt(g, (ax + ex) / 2, (ay + ey) / 2);
          break;
        }
        case "drive": {
          // wavy dribble curve: handler bends around the screen toward the rim
          const p0 = { x: this.px(g.from.pos.x), y: this.py(g.from.pos.y) };
          const p1 = { x: this.px(g.via.pos.x), y: this.py(g.via.pos.y) };
          const rim = { x: this.px(g.to.x), y: this.py(g.to.y) };
          const p2 = { x: p1.x + (rim.x - p1.x) * 0.55, y: p1.y + (rim.y - p1.y) * 0.55 };
          const N = 26;
          c.beginPath();
          let lx = 0,
            ly = 0;
          for (let i = 0; i <= N; i++) {
            const t = i / N;
            const u = 1 - t;
            const x = u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x;
            const y = u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y;
            // tangent, for the perpendicular wave offset
            const dx = 2 * u * (p1.x - p0.x) + 2 * t * (p2.x - p1.x);
            const dy = 2 * u * (p1.y - p0.y) + 2 * t * (p2.y - p1.y);
            const L = Math.hypot(dx, dy) || 1;
            const wave = Math.sin(t * Math.PI * 5) * 3 * (1 - t * 0.7);
            const wx = x + (-dy / L) * wave;
            const wy = y + (dx / L) * wave;
            if (i === 0) c.moveTo(wx, wy);
            else c.lineTo(wx, wy);
            if (i === N) {
              lx = dx / L;
              ly = dy / L;
              c.stroke();
              this.arrowHead(c, wx, wy, Math.atan2(ly, lx));
            }
          }
          break;
        }
        case "free": {
          // the get-open man darts away from his defender
          const dx = g.from.pos.x - g.away.pos.x,
            dy = g.from.pos.y - g.away.pos.y;
          const L = Math.hypot(dx, dy) || 1;
          const ax = this.px(g.from.pos.x),
            ay = this.py(g.from.pos.y);
          const ex = this.px(g.from.pos.x + (dx / L) * 6),
            ey = this.py(g.from.pos.y + (dy / L) * 6);
          const ang = Math.atan2(ey - ay, ex - ax);
          const start = dotR(g.from) + 3;
          c.setLineDash([6, 5]);
          c.beginPath();
          c.moveTo(ax + Math.cos(ang) * start, ay + Math.sin(ang) * start);
          c.lineTo(ex, ey);
          c.stroke();
          c.setLineDash([]);
          this.arrowHead(c, ex, ey, ang);
          break;
        }
        case "ring": {
          // iso: clear the floor for him
          const x = this.px(g.on.pos.x),
            y = this.py(g.on.pos.y);
          c.setLineDash([5, 5]);
          c.beginPath();
          c.arc(x, y, dotR(g.on) + 7, 0, Math.PI * 2);
          c.stroke();
          c.setLineDash([]);
          handleAt(g, x, y - dotR(g.on) - 7);
          break;
        }
      }
    }
    // ✕ badge for the selected action
    this.deleteBadge = badge;
    if (badge) {
      const b: { action: number; x: number; y: number } = badge;
      const bx = this.px(b.x),
        by = this.py(b.y);
      c.setLineDash([]);
      c.beginPath();
      c.arc(bx, by, 9, 0, Math.PI * 2);
      c.fillStyle = "rgba(30,18,6,0.92)";
      c.fill();
      c.strokeStyle = "rgba(255,205,90,0.95)";
      c.lineWidth = 1.5;
      c.stroke();
      c.strokeStyle = "rgba(255,205,90,0.95)";
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(bx - 3.5, by - 3.5);
      c.lineTo(bx + 3.5, by + 3.5);
      c.moveTo(bx + 3.5, by - 3.5);
      c.lineTo(bx - 3.5, by + 3.5);
      c.stroke();
    }
    c.restore();
  }

  /** Draw the in-flight screen gesture: tentative bar-capped line from the
      screener to the pointer, with the hovered teammate haloed. */
  private drawPending(c: CanvasRenderingContext2D) {
    const p = this.pending!;
    const ax = this.px(p.from.pos.x),
      ay = this.py(p.from.pos.y);
    const bx = this.px(p.to.x),
      by = this.py(p.to.y);
    const ang = Math.atan2(by - ay, bx - ax);
    c.save();
    c.strokeStyle = "rgba(255,205,90,0.8)";
    c.lineWidth = 2.5;
    c.lineCap = "round";
    c.setLineDash([7, 6]);
    c.beginPath();
    c.moveTo(ax + Math.cos(ang) * 12, ay + Math.sin(ang) * 12);
    c.lineTo(bx, by);
    c.stroke();
    c.setLineDash([]);
    c.beginPath();
    c.moveTo(bx - Math.sin(ang) * 7, by + Math.cos(ang) * 7);
    c.lineTo(bx + Math.sin(ang) * 7, by - Math.cos(ang) * 7);
    c.stroke();
    if (p.over) {
      const ox = this.px(p.over.pos.x),
        oy = this.py(p.over.pos.y);
      c.beginPath();
      c.arc(ox, oy, 9 + (p.over.heightIn - 70) * 0.45 + 5, 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
  }

  draw(game: DrawScene, dt: number) {
    this.time += dt;
    const c = this.ctx;
    c.clearRect(0, 0, this.W, this.H);
    if (this.courtLayer) c.drawImage(this.courtLayer, 0, 0);

    // lab mode: the staged play's action diagram, under everything else
    if (game.lab && this.overlay) this.drawOverlay(c);
    if (game.lab && this.pending) this.drawPending(c);

    // lab mode: authored routes, in the same amber notation as the actions.
    // A route on a player whose movement a plan action owns draws dimmed —
    // the action wins in the engine, and the diagram should say so.
    if (game.lab) {
      for (let ti = 0; ti < 2; ti++) {
        for (const p of game.teams[ti].players) {
          if (!p.path || p.path.length < 2) continue;
          const alpha = this.ownedByAction.has(p) ? 0.3 : 0.9;
          c.save();
          c.strokeStyle = `rgba(255,205,90,${alpha})`;
          c.lineWidth = 2.5;
          c.lineCap = "round";
          c.shadowColor = "rgba(20,10,2,0.55)";
          c.shadowBlur = 3;
          c.beginPath();
          c.moveTo(this.px(p.path[0].x), this.py(p.path[0].y));
          for (let i = 1; i < p.path.length; i++) {
            c.lineTo(this.px(p.path[i].x), this.py(p.path[i].y));
          }
          c.stroke();
          // arrowhead at the end of the route
          const a = p.path[p.path.length - 2];
          const b = p.path[p.path.length - 1];
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          this.arrowHead(c, this.px(b.x), this.py(b.y), ang);
          c.restore();
        }
      }
    }

    // players
    for (let ti = 0; ti < 2; ti++) {
      const team = game.teams[ti];
      for (const p of team.players) {
        const x = this.px(p.pos.x),
          y = this.py(p.pos.y);
        const r = 9 + (p.heightIn - 70) * 0.45;
        // shadow
        c.beginPath();
        c.ellipse(x + 2, y + 3, r * 0.95, r * 0.6, 0, 0, Math.PI * 2);
        c.fillStyle = "rgba(20,10,2,0.25)";
        c.fill();
        // handler halo
        if (game.ball.holder === p) {
          const pulse = 3 + Math.sin(this.time * 6) * 1.5;
          c.beginPath();
          c.arc(x, y, r + pulse, 0, Math.PI * 2);
          c.strokeStyle = "rgba(255,200,80,0.85)";
          c.lineWidth = 2.5;
          c.stroke();
        }
        // body
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fillStyle = team.color;
        c.fill();
        c.strokeStyle = "rgba(255,255,255,0.85)";
        c.lineWidth = 2;
        c.stroke();
        // number
        c.fillStyle = "#fff";
        c.font = `800 ${Math.round(r)}px 'Big Shoulders Display', sans-serif`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(String(p.number), x, y + 1);
        // name
        const last = p.name.split(" ").slice(-1)[0];
        c.font = `600 9px 'Spline Sans Mono', monospace`;
        c.fillStyle = "rgba(20,12,4,0.9)";
        c.fillText(last, x + 0.5, y + r + 9.5);
        c.fillStyle = "rgba(255,250,240,0.95)";
        c.fillText(last, x, y + r + 9);
        // lab mode: each player's job in the called play
        if (game.lab && p.annotation) {
          c.font = `700 8px 'Spline Sans Mono', monospace`;
          c.fillStyle = "rgba(20,12,4,0.9)";
          c.fillText(p.annotation, x + 0.5, y - r - 5.5);
          c.fillStyle = "rgba(255,210,110,0.95)";
          c.fillText(p.annotation, x, y - r - 6);
        }
        c.textBaseline = "alphabetic";
      }
    }

    // ball
    const b = game.ball;
    const bx = this.px(b.pos.x),
      by = this.py(b.pos.y);
    const air = b.air || 0;
    const br = 5 * (1 + air * 1.3);
    c.beginPath();
    c.ellipse(bx + 3 + air * 10, by + 4 + air * 14, br * 0.9, br * 0.55, 0, 0, Math.PI * 2);
    c.fillStyle = `rgba(20,10,2,${0.3 - air * 0.15})`;
    c.fill();
    c.beginPath();
    c.arc(bx, by - air * 16, br, 0, Math.PI * 2);
    c.fillStyle = "#ff8c2e";
    c.fill();
    c.strokeStyle = "#7c3a0a";
    c.lineWidth = 1.4;
    c.stroke();
    c.beginPath();
    c.moveTo(bx - br, by - air * 16);
    c.lineTo(bx + br, by - air * 16);
    c.stroke();

    // inbound hint
    if (game.phase === "setup" && game.inb) {
      const ip = game.inb.inbounder.pos;
      c.fillStyle = "rgba(255,210,110,0.9)";
      c.font = `700 11px 'Spline Sans Mono', monospace`;
      c.textAlign = "center";
      c.fillText("INBOUND", this.px(ip.x), this.py(ip.y) - 22);
    }

    // final overlay
    if (game.over) {
      c.fillStyle = "rgba(10,7,4,0.6)";
      c.fillRect(0, 0, this.W, this.H);
      c.textAlign = "center";
      c.fillStyle = "#ffb53c";
      c.font = `800 84px 'Big Shoulders Display', sans-serif`;
      c.fillText("FINAL", this.W / 2, this.H / 2 - 22);
      const [a, bteam] = game.teams;
      c.fillStyle = "#f5efe2";
      c.font = `600 30px 'Big Shoulders Display', sans-serif`;
      c.fillText(
        `${a.name} ${a.score} — ${bteam.score} ${bteam.name}`,
        this.W / 2,
        this.H / 2 + 26
      );
    }
  }
}
