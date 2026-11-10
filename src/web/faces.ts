// 用 SVG 画原创的猪猪和猫猫表情。
// 一张脸由固定的头部，加上可替换的眼睛、嘴巴和装饰组成，坐标系是 120×120。
import type { Extra, Eye, FaceArt, Mouth } from '../shared/catalog.js';
import { svg } from './dom.js';

const INK = '#3b2a2f';
const MOUTH_INSIDE = '#7a2735';
const TONGUE = '#ff7a90';

const PALETTE = {
  pig: { skin: '#ffc4d3', edge: '#e0809c', inner: '#ff9fb9', nose: '#ff9fb9', nostril: '#b54d6d', blush: '#ff6f96' },
  cat: { skin: '#ffd49b', edge: '#d18e42', inner: '#ffb1a3', nose: '#ff8a8a', nostril: '#ff8a8a', blush: '#ff8fa3' },
};

/** 不同动物的眼睛、嘴巴、腮红位置 */
const LAYOUT = {
  pig: { eyeY: 54, mouthY: 96, blushY: 80 },
  cat: { eyeY: 60, mouthY: 84, blushY: 76 },
};

type Palette = (typeof PALETTE)['pig'];
type Part = SVGElement | false;

const stroke = (color: string, width: number) => ({
  fill: 'none',
  stroke: color,
  'stroke-width': width,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
});

function heartPath(x: number, y: number, size: number): string {
  const s = size / 7;
  return `M${x} ${y + 6 * s}C${x - 10 * s} ${y - s} ${x - 6 * s} ${y - 9 * s} ${x} ${y - 4 * s}C${x + 6 * s} ${y - 9 * s} ${x + 10 * s} ${y - s} ${x} ${y + 6 * s}Z`;
}

function starPath(x: number, y: number, r: number, points = 5, inner = 0.45): string {
  let path = '';
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? r : r * inner;
    const angle = (Math.PI / points) * i - Math.PI / 2;
    path += `${i === 0 ? 'M' : 'L'}${x + radius * Math.cos(angle)} ${y + radius * Math.sin(angle)}`;
  }
  return `${path}Z`;
}

/** side：左眼 -1，右眼 1。inner 指向脸的中间，用来画朝内倾斜的眉毛 */
function drawEye(kind: Eye, x: number, y: number, side: -1 | 1, palette: Palette): SVGElement {
  const inner = -side;
  switch (kind) {
    case 'happy':
      return svg('path', { d: `M${x - 7} ${y + 2}Q${x} ${y - 7} ${x + 7} ${y + 2}`, ...stroke(INK, 3.5) });
    case 'angry':
      return svg(
        'g',
        {},
        svg('path', { d: `M${x - inner * 9} ${y - 11}L${x + inner * 7} ${y - 5}`, ...stroke(INK, 3.5) }),
        svg('circle', { cx: x, cy: y + 1, r: 4.5, fill: INK }),
      );
    case 'cry':
      return svg(
        'g',
        {},
        svg('path', { d: `M${x - 7} ${y}Q${x} ${y + 5} ${x + 7} ${y}`, ...stroke(INK, 3.5) }),
        svg('path', {
          d: `M${x} ${y + 4}C${x + 4} ${y + 10} ${x + 3} ${y + 14} ${x} ${y + 14}C${x - 3} ${y + 14} ${x - 4} ${y + 10} ${x} ${y + 4}Z`,
          fill: '#7cc8ff',
        }),
      );
    case 'big':
      return svg(
        'g',
        {},
        svg('circle', { cx: x, cy: y, r: 9, fill: '#fff', stroke: INK, 'stroke-width': 2.5 }),
        svg('circle', { cx: x, cy: y + 1, r: 3.6, fill: INK }),
      );
    case 'closed':
      return svg('path', { d: `M${x - 7} ${y + 1}Q${x} ${y + 5} ${x + 7} ${y + 1}`, ...stroke(INK, 3.5) });
    case 'heart':
      return svg('path', { d: heartPath(x, y, 8), fill: '#ff4d6d' });
    case 'smug':
      return svg(
        'g',
        {},
        svg('path', { d: `M${x - 5} ${y - 2}A5 5 0 0 0 ${x + 5} ${y - 2}Z`, fill: INK }),
        svg('path', { d: `M${x - 8} ${y - 2}L${x + 8} ${y - 2}`, ...stroke(INK, 3) }),
      );
    case 'x':
      return svg('path', { d: `M${x - 6} ${y - 6}L${x + 6} ${y + 6}M${x + 6} ${y - 6}L${x - 6} ${y + 6}`, ...stroke(INK, 3.5) });
    case 'spiral':
      return svg('path', {
        d: `M${x} ${y}m-1 0a1.5 1.5 0 1 1 3 0a3 3 0 1 1 -6 0a4.5 4.5 0 1 1 9 0a6 6 0 1 1 -12 0`,
        ...stroke(INK, 2.2),
      });
    case 'side':
      // 斜眼：白眼珠，黑眼珠挤在一边，上眼皮压下来
      return svg(
        'g',
        {},
        svg('ellipse', { cx: x, cy: y, rx: 8, ry: 6, fill: '#fff', stroke: INK, 'stroke-width': 2 }),
        svg('circle', { cx: x + 4, cy: y + 1, r: 3, fill: INK }),
        svg('path', { d: `M${x - 10} ${y - 8}L${x + 10} ${y - 8}L${x + 10} ${y - 1}L${x - 10} ${y - 1}Z`, fill: palette.skin }),
        svg('path', { d: `M${x - 9} ${y - 1}L${x + 9} ${y - 1}`, ...stroke(INK, 3) }),
      );
    case 'star':
      return svg('path', { d: starPath(x, y, 8), fill: '#ffd23f', stroke: '#d9a400', 'stroke-width': 1.5 });
    default:
      return svg(
        'g',
        {},
        svg('circle', { cx: x, cy: y, r: 5.5, fill: INK }),
        svg('circle', { cx: x + 1.8, cy: y - 1.8, r: 1.8, fill: '#fff' }),
      );
  }
}

function drawMouth(kind: Mouth, x: number, y: number): SVGElement {
  switch (kind) {
    case 'grin':
      return svg(
        'g',
        {},
        svg('path', { d: `M${x - 11} ${y - 3}Q${x} ${y + 16} ${x + 11} ${y - 3}Z`, fill: MOUTH_INSIDE, stroke: INK, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }),
        svg('ellipse', { cx: x, cy: y + 3.5, rx: 5, ry: 2.6, fill: TONGUE }),
      );
    case 'frown':
      return svg('path', { d: `M${x - 8} ${y + 3}Q${x} ${y - 5} ${x + 8} ${y + 3}`, ...stroke(INK, 3) });
    case 'o':
      return svg('ellipse', { cx: x, cy: y, rx: 5, ry: 6.5, fill: MOUTH_INSIDE, stroke: INK, 'stroke-width': 2 });
    case 'flat':
      return svg('path', { d: `M${x - 7} ${y}L${x + 7} ${y}`, ...stroke(INK, 3) });
    case 'wavy':
      return svg('path', { d: `M${x - 10} ${y}Q${x - 7.5} ${y - 4} ${x - 5} ${y}T${x} ${y}T${x + 5} ${y}T${x + 10} ${y}`, ...stroke(INK, 2.6) });
    case 'wail':
      return svg(
        'g',
        {},
        svg('ellipse', { cx: x, cy: y + 2, rx: 10, ry: 8, fill: MOUTH_INSIDE, stroke: INK, 'stroke-width': 2 }),
        svg('ellipse', { cx: x, cy: y + 6, rx: 5, ry: 2.5, fill: TONGUE }),
      );
    case 'smirk':
      return svg('path', { d: `M${x - 8} ${y + 1}Q${x + 1} ${y + 5} ${x + 9} ${y - 4}`, ...stroke(INK, 3) });
    case 'teeth':
      return svg(
        'g',
        {},
        svg('path', {
          d: `M${x - 11} ${y - 4}Q${x} ${y - 8} ${x + 11} ${y - 4}Q${x + 12} ${y + 6} ${x} ${y + 7}Q${x - 12} ${y + 6} ${x - 11} ${y - 4}Z`,
          fill: '#fff',
          stroke: INK,
          'stroke-width': 2.5,
          'stroke-linejoin': 'round',
        }),
        svg('path', { d: `M${x - 4} ${y - 6}L${x - 4} ${y + 6}M${x + 4} ${y - 6}L${x + 4} ${y + 6}M${x - 11} ${y + 1}L${x + 11} ${y + 1}`, ...stroke(INK, 1.5) }),
      );
    case 'tongue':
      return svg(
        'g',
        {},
        svg('path', { d: `M${x + 1} ${y}Q${x + 2} ${y + 9} ${x + 6} ${y + 8}Q${x + 8} ${y + 5} ${x + 7} ${y}Z`, fill: TONGUE, stroke: INK, 'stroke-width': 1.5 }),
        svg('path', { d: `M${x - 8} ${y}L${x + 8} ${y}`, ...stroke(INK, 3) }),
      );
    case 'cat':
      return svg('path', { d: `M${x - 9} ${y - 3}Q${x - 4.5} ${y + 5} ${x} ${y - 1}Q${x + 4.5} ${y + 5} ${x + 9} ${y - 3}`, ...stroke(INK, 2.5) });
    case 'fangs':
      return svg(
        'g',
        {},
        svg('path', { d: `M${x - 10} ${y - 3}Q${x} ${y + 15} ${x + 10} ${y - 3}Z`, fill: MOUTH_INSIDE, stroke: INK, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }),
        svg('path', { d: `M${x - 7} ${y - 2.5}L${x - 4.5} ${y + 4}L${x - 2} ${y - 2}ZM${x + 7} ${y - 2.5}L${x + 4.5} ${y + 4}L${x + 2} ${y - 2}Z`, fill: '#fff' }),
      );
    default:
      return svg('path', { d: `M${x - 9} ${y - 2}Q${x} ${y + 7} ${x + 9} ${y - 2}`, ...stroke(INK, 3) });
  }
}

function flame(x: number, y: number, scale: number): SVGElement {
  const p = (dx: number, dy: number) => `${x + dx * scale} ${y + dy * scale}`;
  return svg(
    'g',
    {},
    svg('path', { d: `M${p(0, 18)}C${p(-12, 10)} ${p(-6, 0)} ${p(0, -12)}C${p(6, 0)} ${p(12, 10)} ${p(0, 18)}Z`, fill: '#ff5a1f' }),
    svg('path', { d: `M${p(0, 18)}C${p(-6, 13)} ${p(-3, 6)} ${p(0, 0)}C${p(3, 6)} ${p(6, 13)} ${p(0, 18)}Z`, fill: '#ffd23f' }),
  );
}

/** 画在头后面的装饰（火焰），要先画 */
function drawBehind(extras: Extra[]): Part[] {
  return extras.includes('fire') ? [flame(28, 24, 1), flame(60, 14, 1.2), flame(92, 24, 1)] : [];
}

/** 画在脸上面的装饰 */
function drawAbove(extras: Extra[], eyeY: number): Part[] {
  const parts: Part[] = [];
  for (const extra of extras) {
    switch (extra) {
      case 'tears':
        parts.push(svg('path', { d: `M36 ${eyeY + 6}Q32 ${eyeY + 26} 36 ${eyeY + 42}M84 ${eyeY + 6}Q88 ${eyeY + 26} 84 ${eyeY + 42}`, ...stroke('#7cc8ff', 4.5) }));
        break;
      case 'shades':
        parts.push(
          svg('rect', { x: 26, y: eyeY - 8, width: 28, height: 15, rx: 5, fill: '#1d1d1f' }),
          svg('rect', { x: 66, y: eyeY - 8, width: 28, height: 15, rx: 5, fill: '#1d1d1f' }),
          svg('path', { d: `M54 ${eyeY - 3}L66 ${eyeY - 3}`, ...stroke('#1d1d1f', 3) }),
          svg('path', { d: `M31 ${eyeY - 4}L38 ${eyeY - 4}M71 ${eyeY - 4}L78 ${eyeY - 4}`, ...stroke('#ffffff99', 2) }),
        );
        break;
      case 'vein':
        // 漫画里的“生气”符号
        parts.push(
          svg('path', {
            d: 'M94 16Q94 21 89 21M100 16Q100 21 105 21M94 28Q94 23 89 23M100 28Q100 23 105 23',
            ...stroke('#e5383b', 3),
          }),
        );
        break;
      case 'sweat':
        parts.push(svg('path', { d: 'M98 26C103 34 104 39 98 41C92 39 93 34 98 26Z', fill: '#8fd3ff', stroke: '#4aa8e0', 'stroke-width': 1.5 }));
        break;
      case 'question':
        parts.push(svg('text', { x: 92, y: 30, 'font-size': 26, 'font-weight': 800, fill: '#ff9f1c', stroke: '#fff', 'stroke-width': 1 }, '?'));
        break;
      case 'zzz':
        parts.push(
          svg('text', { x: 88, y: 32, 'font-size': 16, 'font-weight': 800, fill: '#6b8cff' }, 'Z'),
          svg('text', { x: 99, y: 20, 'font-size': 12, 'font-weight': 800, fill: '#6b8cff' }, 'Z'),
          svg('text', { x: 107, y: 11, 'font-size': 9, 'font-weight': 800, fill: '#6b8cff' }, 'Z'),
        );
        break;
      case 'hearts':
        parts.push(svg('path', { d: `${heartPath(100, 26, 7)}${heartPath(18, 22, 5)}`, fill: '#ff4d6d' }));
        break;
      case 'sparkle':
        parts.push(svg('path', { d: `${starPath(102, 22, 8, 4, 0.3)}${starPath(16, 28, 6, 4, 0.3)}`, fill: '#ffd23f' }));
        break;
      case 'fish':
        parts.push(
          svg(
            'g',
            {},
            svg('ellipse', { cx: 96, cy: 98, rx: 11, ry: 6, fill: '#8ecae6', stroke: '#2b7a9b', 'stroke-width': 1.5 }),
            svg('path', { d: 'M106 98L114 92L114 104Z', fill: '#8ecae6', stroke: '#2b7a9b', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }),
            svg('circle', { cx: 91, cy: 97, r: 1.4, fill: INK }),
          ),
        );
        break;
      default:
        break;
    }
  }
  return parts;
}

export function drawFace(art: FaceArt): SVGSVGElement {
  const palette = PALETTE[art.animal];
  const { eyeY, mouthY, blushY } = LAYOUT[art.animal];
  const extras = art.extras ?? [];
  const [leftEye, rightEye] = Array.isArray(art.eyes) ? art.eyes : [art.eyes, art.eyes];
  const skin = { fill: palette.skin, stroke: palette.edge, 'stroke-width': 3, 'stroke-linejoin': 'round' };

  const head: Part[] =
    art.animal === 'pig'
      ? [
          svg('path', { d: 'M24 40L28 12L50 28Z', ...skin }),
          svg('path', { d: 'M96 40L92 12L70 28Z', ...skin }),
          svg('path', { d: 'M30 33L31.5 20L43 28Z', fill: palette.inner }),
          svg('path', { d: 'M90 33L88.5 20L77 28Z', fill: palette.inner }),
          svg('ellipse', { cx: 60, cy: 66, rx: 46, ry: 42, ...skin }),
          svg('ellipse', { cx: 60, cy: 78, rx: 18, ry: 13, fill: palette.nose, stroke: palette.edge, 'stroke-width': 2.5 }),
          svg('ellipse', { cx: 53, cy: 78, rx: 3.2, ry: 4.6, fill: palette.nostril }),
          svg('ellipse', { cx: 67, cy: 78, rx: 3.2, ry: 4.6, fill: palette.nostril }),
        ]
      : [
          svg('path', { d: 'M20 50L26 10L52 32Z', ...skin }),
          svg('path', { d: 'M100 50L94 10L68 32Z', ...skin }),
          svg('path', { d: 'M27 42L30 20L45 33Z', fill: palette.inner }),
          svg('path', { d: 'M93 42L90 20L75 33Z', fill: palette.inner }),
          svg('ellipse', { cx: 60, cy: 68, rx: 48, ry: 40, ...skin }),
          svg('path', { d: 'M52 31L54 41M60 29L60 41M68 31L66 41', ...stroke('#e0a058', 3) }),
          svg('path', { d: 'M55.5 72L64.5 72L60 77.5Z', fill: palette.nose, stroke: palette.edge, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }),
          svg('path', { d: 'M12 70L32 74M12 80L32 80M108 70L88 74M108 80L88 80', ...stroke(palette.edge, 2) }),
        ];

  const blush =
    art.animal === 'pig' || extras.includes('blush')
      ? [
          svg('ellipse', { cx: 28, cy: blushY, rx: 8, ry: 5, fill: palette.blush, opacity: 0.5 }),
          svg('ellipse', { cx: 92, cy: blushY, rx: 8, ry: 5, fill: palette.blush, opacity: 0.5 }),
        ]
      : [];

  return svg(
    'svg',
    { viewBox: '0 0 120 120', class: 'face', 'aria-hidden': 'true' },
    ...drawBehind(extras),
    ...head,
    ...blush,
    drawEye(leftEye, 40, eyeY, -1, palette),
    drawEye(rightEye, 80, eyeY, 1, palette),
    drawMouth(art.mouth, 60, mouthY),
    ...drawAbove(extras, eyeY),
  );
}
