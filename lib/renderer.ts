/* ============================================================
   renderer.ts — canvas renderer for the court and players
   Ported from ui.js with drawing logic preserved exactly.
   ============================================================ */
import { COURT, type Game } from "./engine";

export const SCALE = 10; // px per foot
export const PAD = 32; // out-of-bounds apron in px

export class Renderer {
  cv: HTMLCanvasElement;
  W: number;
  H: number;
  ctx: CanvasRenderingContext2D;
  time: number;
  courtLayer: HTMLCanvasElement | null;
  colors: string[] = [];

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

  draw(game: Game, dt: number) {
    this.time += dt;
    const c = this.ctx;
    c.clearRect(0, 0, this.W, this.H);
    if (this.courtLayer) c.drawImage(this.courtLayer, 0, 0);

    // lab mode: authored motion paths, drawn under the players
    if (game.lab) {
      for (let ti = 0; ti < 2; ti++) {
        for (const p of game.teams[ti].players) {
          if (!p.path || p.path.length < 2) continue;
          c.save();
          c.strokeStyle = this.hexA(this.colors[ti] || "#ffffff", 0.8);
          c.lineWidth = 2.5;
          c.setLineDash([7, 6]);
          c.beginPath();
          c.moveTo(this.px(p.path[0].x), this.py(p.path[0].y));
          for (let i = 1; i < p.path.length; i++) {
            c.lineTo(this.px(p.path[i].x), this.py(p.path[i].y));
          }
          c.stroke();
          c.setLineDash([]);
          // arrowhead at the end of the route
          const a = p.path[p.path.length - 2];
          const b = p.path[p.path.length - 1];
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          const bx = this.px(b.x),
            by = this.py(b.y);
          c.beginPath();
          c.moveTo(bx, by);
          c.lineTo(bx - 9 * Math.cos(ang - 0.45), by - 9 * Math.sin(ang - 0.45));
          c.moveTo(bx, by);
          c.lineTo(bx - 9 * Math.cos(ang + 0.45), by - 9 * Math.sin(ang + 0.45));
          c.stroke();
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
