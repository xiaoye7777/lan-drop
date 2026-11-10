// 消息特效（仿 iMessage）。
// 气泡特效靠 CSS 动画（见 style.css 的 fx-*）；全屏特效在一块透明画布上用粒子动画画出来。
import { EFFECTS } from '../shared/catalog.js';
import { prefersReducedMotion } from './dom.js';

/** 气泡特效的时长，要和 style.css 里的动画时长一致 */
export const BUBBLE_EFFECT_MS: Record<string, number> = { slam: 900, loud: 1500, gentle: 2600 };

export function effectInfo(id: string | undefined) {
  return EFFECTS.find((effect) => effect.id === id);
}

// ---------- 全屏粒子动画 ----------

type Kind = 'confetti' | 'balloon' | 'spark' | 'heart' | 'bomb' | 'flash' | 'boom' | 'debris';

interface Particle {
  kind: Kind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rotation: number;
  spin: number;
  /** 已经存在的时间和最长存在时间（秒） */
  age: number;
  life: number;
  /** 延迟多少秒后才出现，用来安排先后顺序 */
  delay: number;
}

const COLORS = ['#ff4d6d', '#ffd23f', '#3ddc97', '#4cc9f0', '#9b5de5', '#ff8a3d', '#f15bb5'];
const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
const between = (min: number, max: number) => min + Math.random() * (max - min);

let particles: Particle[] = [];
let running = false;
let lastFrame = 0;

function canvas(): HTMLCanvasElement {
  return document.getElementById('effects-canvas') as HTMLCanvasElement;
}

function particle(kind: Kind, fields: Partial<Particle>): Particle {
  return { kind, x: 0, y: 0, vx: 0, vy: 0, size: 10, color: '#fff', rotation: 0, spin: 0, age: 0, life: 3, delay: 0, ...fields };
}

function spawn(effect: string, width: number, height: number): void {
  switch (effect) {
    case 'confetti':
      for (let i = 0; i < 180; i += 1) {
        particles.push(
          particle('confetti', {
            x: between(0, width),
            y: between(-height * 0.4, -10),
            vx: between(-60, 60),
            vy: between(80, 260),
            size: between(6, 11),
            color: pickColor(),
            rotation: between(0, Math.PI * 2),
            spin: between(-8, 8),
            life: 5,
            delay: between(0, 0.6),
          }),
        );
      }
      break;
    case 'balloons':
      for (let i = 0; i < 20; i += 1) {
        particles.push(
          particle('balloon', {
            x: between(width * 0.05, width * 0.95),
            y: height + between(30, 260),
            vy: -between(110, 190),
            size: between(26, 40),
            color: pickColor(),
            rotation: between(0, Math.PI * 2),
            life: 7,
            delay: between(0, 1),
          }),
        );
      }
      break;
    case 'fireworks':
      for (let burst = 0; burst < 6; burst += 1) {
        const cx = between(width * 0.15, width * 0.85);
        const cy = between(height * 0.15, height * 0.5);
        const color = pickColor();
        for (let i = 0; i < 70; i += 1) {
          const angle = (Math.PI * 2 * i) / 70;
          const speed = between(90, 260);
          particles.push(
            particle('spark', {
              x: cx,
              y: cy,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              size: between(1.8, 3),
              color: Math.random() < 0.2 ? '#ffffff' : color,
              life: between(1.2, 1.9),
              delay: burst * 0.45,
            }),
          );
        }
      }
      break;
    case 'hearts':
      for (let i = 0; i < 45; i += 1) {
        particles.push(
          particle('heart', {
            x: between(0, width),
            y: height + between(10, 200),
            vy: -between(90, 200),
            size: between(14, 30),
            color: ['#ff4d6d', '#ff758f', '#ff8fab', '#c9184a'][i % 4],
            rotation: between(0, Math.PI * 2),
            life: 6,
            delay: between(0, 1.2),
          }),
        );
      }
      break;
    case 'bomb': {
      const cx = width / 2;
      const cy = height / 2;
      particles.push(particle('bomb', { x: cx, y: cy, size: 60, life: 0.7 }));
      particles.push(particle('flash', { life: 0.5, delay: 0.7 }));
      particles.push(particle('boom', { x: cx, y: cy, size: 120, life: 0.9, delay: 0.7 }));
      for (let i = 0; i < 90; i += 1) {
        const angle = between(0, Math.PI * 2);
        const speed = between(200, 700);
        particles.push(
          particle('debris', {
            x: cx,
            y: cy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            size: between(3, 8),
            color: ['#ff8a3d', '#ffd23f', '#6c757d', '#343a40'][i % 4],
            rotation: between(0, Math.PI * 2),
            spin: between(-10, 10),
            life: between(0.8, 1.4),
            delay: 0.7,
          }),
        );
      }
      // 爆炸时整个界面跟着抖一下
      window.setTimeout(() => {
        document.body.classList.add('screen-shake');
        window.setTimeout(() => document.body.classList.remove('screen-shake'), 600);
      }, 700);
      break;
    }
    default:
      break;
  }
}

function update(p: Particle, dt: number): void {
  switch (p.kind) {
    case 'confetti':
      p.vy = Math.min(p.vy + 120 * dt, 320);
      p.vx += Math.sin(p.age * 3 + p.rotation) * 30 * dt;
      p.rotation += p.spin * dt;
      break;
    case 'balloon':
      // 左右轻轻摆动
      p.vx = Math.sin(p.age * 1.6 + p.rotation) * 25;
      break;
    case 'heart':
      p.vx = Math.sin(p.age * 2 + p.rotation) * 40;
      break;
    case 'spark':
      p.vy += 140 * dt;
      p.vx *= 1 - 1.2 * dt;
      p.vy *= 1 - 1.2 * dt;
      break;
    case 'debris':
      p.vy += 500 * dt;
      p.rotation += p.spin * dt;
      break;
    default:
      break;
  }
  p.x += p.vx * dt;
  p.y += p.vy * dt;
}

function drawHeart(ctx: CanvasRenderingContext2D, size: number): void {
  const s = size / 30;
  ctx.beginPath();
  ctx.moveTo(0, 9 * s);
  ctx.bezierCurveTo(-15 * s, -2 * s, -9 * s, -14 * s, 0, -6 * s);
  ctx.bezierCurveTo(9 * s, -14 * s, 15 * s, -2 * s, 0, 9 * s);
  ctx.fill();
}

function draw(ctx: CanvasRenderingContext2D, p: Particle, width: number, height: number): void {
  const progress = p.age / p.life;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.fillStyle = p.color;
  switch (p.kind) {
    case 'confetti':
      ctx.rotate(p.rotation);
      // 纸片翻转：宽度随时间变化
      ctx.scale(1, Math.cos(p.age * 6 + p.rotation));
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      break;
    case 'balloon':
      ctx.beginPath();
      ctx.ellipse(0, 0, p.size * 0.78, p.size, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-4, p.size + 5);
      ctx.lineTo(4, p.size + 5);
      ctx.lineTo(0, p.size - 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,120,120,0.7)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, p.size + 5);
      ctx.quadraticCurveTo(Math.sin(p.age * 3) * 10, p.size + 30, 0, p.size + 55);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.ellipse(-p.size * 0.3, -p.size * 0.35, p.size * 0.18, p.size * 0.3, -0.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'spark':
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.max(0, 1 - progress);
      ctx.beginPath();
      ctx.arc(0, 0, p.size, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'heart':
      ctx.globalAlpha = progress > 0.8 ? (1 - progress) / 0.2 : 1;
      drawHeart(ctx, p.size);
      break;
    case 'bomb':
      ctx.font = `${p.size * (0.6 + progress * 1.6)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.rotate(Math.sin(p.age * 40) * 0.08);
      ctx.fillText('💣', 0, 0);
      break;
    case 'flash':
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(255, 244, 214, ${0.85 * (1 - progress)})`;
      ctx.fillRect(0, 0, width * devicePixelRatio, height * devicePixelRatio);
      break;
    case 'boom':
      ctx.globalAlpha = Math.max(0, 1 - progress);
      ctx.font = `${p.size * (1 + progress * 1.5)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('💥', 0, 0);
      break;
    case 'debris':
      ctx.globalAlpha = Math.max(0, 1 - progress);
      ctx.rotate(p.rotation);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      break;
  }
  ctx.restore();
}

function frame(now: number): void {
  const el = canvas();
  const ctx = el.getContext('2d');
  if (!ctx) return;
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const width = window.innerWidth;
  const height = window.innerHeight;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  particles = particles.filter((p) => {
    if (p.delay > 0) {
      p.delay -= dt;
      return true;
    }
    p.age += dt;
    update(p, dt);
    const offScreen = p.y > height + 200 || p.y < -400;
    if (p.age >= p.life || (offScreen && p.age > 0.5)) return false;
    draw(ctx, p, width, height);
    return true;
  });

  if (particles.length > 0) {
    requestAnimationFrame(frame);
  } else {
    running = false;
    ctx.clearRect(0, 0, width, height);
    el.hidden = true;
  }
}

/** 播放全屏特效。系统设置了“减少动态效果”时不播放 */
export function playScreenEffect(id: string): void {
  if (effectInfo(id)?.kind !== 'screen' || prefersReducedMotion()) return;
  const el = canvas();
  el.width = Math.floor(window.innerWidth * devicePixelRatio);
  el.height = Math.floor(window.innerHeight * devicePixelRatio);
  el.hidden = false;
  spawn(id, window.innerWidth, window.innerHeight);
  if (!running) {
    running = true;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }
}
