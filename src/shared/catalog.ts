// 内置素材目录：表情、名片背景、气泡样式、消息特效，以及各种长度限制。
// 前后端都会用到：服务器用 id 列表校验请求，页面用其余字段渲染。
// 这里只有数据，不含任何图片文件，全部离线可用。
import type { ChatMessage } from './types.js';

// ---------- 长度和数量限制 ----------

export const LIMITS = {
  nameLength: 20,
  bioLength: 40,
  textLength: 5000,
  pollQuestionLength: 60,
  optionLength: 40,
  pollMaxOptions: 10,
  relayTitleLength: 60,
  relayEntryLength: 100,
  relayMaxEntries: 200,
  wheelTitleLength: 40,
  wheelOptionLength: 20,
  wheelMaxOptions: 20,
  stickerNameLength: 20,
  maxCustomStickers: 300,
  gomokuSize: 15,
  remarkLength: 20,
  nudgeSuffixLength: 12,
  /** 一条消息最多 @ 几个人 */
  maxMentions: 50,
  /** 合并转发最多选几条，一次最多转给几个会话 */
  forwardMaxItems: 100,
  forwardMaxTargets: 20,
  /** 引用和转发的摘要最多保留多少字 */
  summaryLength: 80,
  /** 打开页面时每个会话先加载多少条，往上翻时每次再加载多少条 */
  historyPage: 100,
  searchMaxResults: 50,
  searchQueryLength: 50,
} as const;

/** @所有人 时，消息的 mentions 里用这个值 */
export const MENTION_ALL = 'all';

// ---------- 表情 ----------

/** 表情的动作，对应 style.css 里的 motion-* 动画 */
export type Motion = 'shake' | 'bounce' | 'spin' | 'pulse' | 'slap' | 'float' | 'zoom' | 'swing' | 'jelly' | 'crawl';

export type Tone = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'dark';

export type Eye =
  | 'dot'
  | 'happy'
  | 'angry'
  | 'cry'
  | 'big'
  | 'closed'
  | 'heart'
  | 'smug'
  | 'x'
  | 'spiral'
  | 'side'
  | 'star';

export type Mouth =
  | 'smile'
  | 'grin'
  | 'frown'
  | 'o'
  | 'flat'
  | 'wavy'
  | 'wail'
  | 'smirk'
  | 'teeth'
  | 'tongue'
  | 'cat'
  | 'fangs';

export type Extra =
  | 'vein'
  | 'sweat'
  | 'tears'
  | 'zzz'
  | 'fire'
  | 'question'
  | 'shades'
  | 'hearts'
  | 'sparkle'
  | 'fish'
  | 'blush';

/** 大字报：一个 emoji 配一句话 */
export interface MemeArt {
  kind: 'meme';
  emoji: string;
  text: string;
  tone: Tone;
}

/** 原创的猪猪、猫猫：由页面用 SVG 现场画出来，表情由眼睛、嘴巴和装饰组合而成 */
export interface FaceArt {
  kind: 'face';
  animal: 'pig' | 'cat';
  /** 一个值表示两只眼睛一样，两个值分别是左眼和右眼 */
  eyes: Eye | [Eye, Eye];
  mouth: Mouth;
  extras?: Extra[];
  text: string;
}

/** 动图：大号 emoji 循环播放动作 */
export interface EmojiArt {
  kind: 'emoji';
  emoji: string;
  text: string;
}

export type StickerArt = MemeArt | FaceArt | EmojiArt;

export interface BuiltinSticker {
  id: string;
  art: StickerArt;
  motion: Motion;
}

export interface StickerPack {
  id: string;
  name: string;
  /** 动图包循环播放，其余的只在出现和鼠标悬停时动一下 */
  loop: boolean;
  stickers: BuiltinSticker[];
}

const meme = (id: string, emoji: string, text: string, tone: Tone, motion: Motion): BuiltinSticker => ({
  id: `meme-${id}`,
  art: { kind: 'meme', emoji, text, tone },
  motion,
});

const face = (
  animal: 'pig' | 'cat',
  id: string,
  text: string,
  eyes: Eye | [Eye, Eye],
  mouth: Mouth,
  extras: Extra[],
  motion: Motion,
): BuiltinSticker => ({
  id: `${animal}-${id}`,
  art: { kind: 'face', animal, eyes, mouth, extras, text },
  motion,
});

const pig = (id: string, text: string, eyes: Eye | [Eye, Eye], mouth: Mouth, extras: Extra[], motion: Motion) =>
  face('pig', id, text, eyes, mouth, ['blush', ...extras], motion);

const cat = (id: string, text: string, eyes: Eye | [Eye, Eye], mouth: Mouth, extras: Extra[], motion: Motion) =>
  face('cat', id, text, eyes, mouth, extras, motion);

const gif = (id: string, emoji: string, text: string, motion: Motion): BuiltinSticker => ({
  id: `gif-${id}`,
  art: { kind: 'emoji', emoji, text },
  motion,
});

export const STICKER_PACKS: StickerPack[] = [
  {
    id: 'meme',
    name: '嘴替',
    loop: false,
    stickers: [
      meme('jiuzhe', '🤨', '就这？', 'red', 'shake'),
      meme('limao', '😐', '你礼貌吗', 'blue', 'zoom'),
      meme('jile', '🤭', '急了急了', 'orange', 'bounce'),
      meme('buhuiba', '😏', '不会吧不会吧', 'purple', 'swing'),
      meme('xiele', '🙃', '我真的会谢', 'pink', 'jelly'),
      meme('tui', '🙅', '退！退！退！', 'red', 'shake'),
      meme('cai', '🥱', '菜就多练', 'dark', 'zoom'),
      meme('chabuduo', '😑', '差不多得了', 'blue', 'pulse'),
      meme('jiaowo', '🤔', '你在教我做事？', 'purple', 'zoom'),
      meme('zhengxiao', '😂', '给爷整笑了', 'yellow', 'bounce'),
      meme('damie', '🙅‍♀️', '达咩', 'pink', 'swing'),
      meme('dani', '👊', '打你哦', 'red', 'slap'),
      meme('pa', '👉', '爬', 'dark', 'zoom'),
      meme('choushenme', '👀', '你瞅啥', 'orange', 'shake'),
      meme('shanni', '🖐️', '别逼我扇你', 'red', 'slap'),
      meme('qisi', '😤', '气死我了', 'red', 'shake'),
      meme('guanwo', '🙄', '关我屁事', 'dark', 'swing'),
      meme('wuyu', '😶', '无语子', 'blue', 'pulse'),
      meme('dian', '📖', '典', 'yellow', 'zoom'),
      meme('bengbuzhu', '🤣', '绷不住了', 'orange', 'bounce'),
      meme('six', '👍', '6', 'green', 'pulse'),
      meme('shoudao', '✅', '收到', 'green', 'bounce'),
      meme('xiaban', '🏃', '下班！', 'green', 'crawl'),
      meme('moyu', '🐟', '摸鱼中', 'blue', 'swing'),
      meme('nixing', '💪', '你行你上', 'orange', 'pulse'),
      meme('butingbuting', '🙉', '我不听我不听', 'purple', 'shake'),
      meme('haojiahuo', '😮', '好家伙', 'yellow', 'zoom'),
      meme('nalai', '🤲', '拿来吧你', 'orange', 'slap'),
      meme('bizui', '🤐', '闭嘴', 'dark', 'pulse'),
      meme('biejuan', '🌀', '别卷了', 'blue', 'spin'),
      meme('pofang', '💔', '破防了', 'pink', 'shake'),
      meme('yibian', '👋', '一边玩去', 'purple', 'swing'),
      meme('hehe', '🙂', '呵呵', 'dark', 'jelly'),
      meme('yidu', '📵', '已读不回', 'dark', 'pulse'),
    ],
  },
  {
    id: 'pig',
    name: '猪猪',
    loop: false,
    stickers: [
      pig('hehe', '嘿嘿', 'happy', 'smile', [], 'bounce'),
      pig('heng', '哼！', 'angry', 'frown', ['vein'], 'shake'),
      pig('wuwu', '呜呜呜', 'cry', 'wail', ['tears'], 'jelly'),
      pig('shock', '？？？', 'big', 'o', ['question'], 'zoom'),
      pig('sleep', '睡了', 'closed', 'flat', ['zzz'], 'float'),
      pig('love', '爱你', 'heart', 'smile', ['hearts'], 'pulse'),
      pig('deyi', '得意', 'smug', 'smirk', ['sparkle'], 'swing'),
      pig('lei', '累死了', 'x', 'tongue', [], 'jelly'),
      pig('ganfan', '干饭！', 'happy', 'grin', ['sparkle'], 'bounce'),
      pig('ganga', '尴尬', 'dot', 'wavy', ['sweat'], 'jelly'),
      pig('gongni', '拱你！', 'angry', 'teeth', ['fire'], 'shake'),
      pig('yun', '晕', 'spiral', 'wavy', [], 'spin'),
      pig('dongde', '你懂的', ['happy', 'dot'], 'smirk', [], 'swing'),
      pig('ku', '酷', 'dot', 'smirk', ['shades'], 'zoom'),
      pig('a', '啊？', 'dot', 'o', ['question'], 'zoom'),
      pig('xiexie', '谢谢老板', 'star', 'grin', ['sparkle'], 'bounce'),
    ],
  },
  {
    id: 'cat',
    name: '猫猫',
    loop: false,
    stickers: [
      cat('ha', '哈！', 'angry', 'fangs', ['vein'], 'shake'),
      cat('miao', '喵？', 'big', 'cat', ['question'], 'zoom'),
      cat('guanni', '关你猫事', 'smug', 'cat', [], 'swing'),
      cat('zhenjing', '猫猫震惊', 'big', 'o', ['sweat'], 'zoom'),
      cat('weiqu', '委屈', 'cry', 'frown', ['tears'], 'jelly'),
      cat('xianqi', '嫌弃', 'side', 'flat', [], 'swing'),
      cat('tietie', '贴贴', 'happy', 'cat', ['blush', 'hearts'], 'pulse'),
      cat('xiaoyu', '小鱼干呢', 'star', 'grin', ['fish'], 'bounce'),
      cat('kun', '困', 'closed', 'cat', ['zzz'], 'float'),
      cat('bang', '邦邦两拳', 'angry', 'teeth', ['fire'], 'slap'),
      cat('dese', '得瑟', 'smug', 'smirk', ['sparkle'], 'swing'),
      cat('lanle', '烂了', 'x', 'tongue', [], 'jelly'),
      cat('ai', '爱了', 'heart', 'cat', ['blush'], 'pulse'),
      cat('henghe', '哼哼', ['dot', 'happy'], 'smirk', [], 'swing'),
      cat('yun', '晕乎乎', 'spiral', 'wavy', [], 'spin'),
      cat('ku', '高冷', 'dot', 'flat', ['shades'], 'zoom'),
    ],
  },
  {
    id: 'gif',
    name: '动图',
    loop: true,
    stickers: [
      gif('poop', '💩', '送你', 'bounce'),
      gif('clown', '🤡', '小丑竟是我', 'shake'),
      gif('hammer', '🔨', '敲你', 'slap'),
      gif('slap', '👋', '扇你', 'slap'),
      gif('skull', '💀', '笑死', 'shake'),
      gif('fire', '🔥', '火大', 'pulse'),
      gif('duck', '🦆', '鸭', 'crawl'),
      gif('rocket', '🚀', '冲！', 'float'),
      gif('bomb', '💣', '炸了', 'shake'),
      gif('moon', '🌚', '嘿嘿', 'jelly'),
      gif('dizzy', '🥴', '醉了', 'swing'),
      gif('ghost', '👻', '吓你', 'zoom'),
      gif('turtle', '🐢', '慢死了', 'crawl'),
      gif('monkey', '🙈', '没眼看', 'swing'),
      gif('lemon', '🍋', '酸了', 'pulse'),
      gif('devil', '😈', '坏笑', 'bounce'),
      gif('yue', '🤮', 'yue', 'jelly'),
      gif('cracker', '🧨', '点炮', 'shake'),
    ],
  },
];

export const BUILTIN_STICKERS = new Map(
  STICKER_PACKS.flatMap((pack) => pack.stickers.map((sticker) => [sticker.id, { pack, sticker }] as const)),
);

// ---------- 名片背景（同事列表里每个人那一行的背景） ----------

export type Tier = 'common' | 'rare' | 'epic' | 'legendary';

export const TIER_NAMES: Record<Tier, string> = {
  common: '普通',
  rare: '稀有',
  epic: '史诗',
  legendary: '传说',
};

export interface Nameplate {
  id: string;
  name: string;
  tier: Tier;
}

/** 样式在 style.css 的 np-<id> 里 */
export const NAMEPLATES: Nameplate[] = [
  { id: 'default', name: '默认', tier: 'common' },
  { id: 'mint', name: '薄荷', tier: 'common' },
  { id: 'sunset', name: '落日', tier: 'rare' },
  { id: 'ocean', name: '深海', tier: 'rare' },
  { id: 'sakura', name: '樱花', tier: 'rare' },
  { id: 'carbon', name: '碳纤维', tier: 'epic' },
  { id: 'neon', name: '霓虹', tier: 'epic' },
  { id: 'matrix', name: '矩阵', tier: 'epic' },
  { id: 'aurora', name: '极光', tier: 'legendary' },
  { id: 'galaxy', name: '星河', tier: 'legendary' },
  { id: 'gold', name: '黄金', tier: 'legendary' },
  { id: 'lava', name: '熔岩', tier: 'legendary' },
];

// ---------- 聊天气泡 ----------

export interface BubbleStyle {
  id: string;
  name: string;
}

/** 样式在 style.css 的 bubble-<id> 里。所有人看到的都是发送者选的样式 */
export const BUBBLES: BubbleStyle[] = [
  { id: 'default', name: '默认' },
  { id: 'mint', name: '薄荷' },
  { id: 'grape', name: '葡萄' },
  { id: 'peach', name: '蜜桃' },
  { id: 'sunset', name: '晚霞' },
  { id: 'neon', name: '霓虹' },
  { id: 'gold', name: '鎏金' },
  { id: 'pixel', name: '像素' },
  { id: 'candy', name: '糖果' },
  { id: 'midnight', name: '午夜' },
];

// ---------- 消息特效（仿 iMessage） ----------

export interface Effect {
  id: string;
  name: string;
  /** bubble：气泡本身动；screen：全屏播放动画 */
  kind: 'bubble' | 'screen';
}

export const EFFECTS: Effect[] = [
  { id: 'slam', name: '重击', kind: 'bubble' },
  { id: 'loud', name: '大声', kind: 'bubble' },
  { id: 'gentle', name: '轻声', kind: 'bubble' },
  { id: 'ink', name: '隐形墨水', kind: 'bubble' },
  { id: 'confetti', name: '彩带', kind: 'screen' },
  { id: 'balloons', name: '气球', kind: 'screen' },
  { id: 'fireworks', name: '烟花', kind: 'screen' },
  { id: 'hearts', name: '爱心', kind: 'screen' },
  { id: 'bomb', name: '炸弹', kind: 'screen' },
];

export const NAMEPLATE_IDS = new Set(NAMEPLATES.map((item) => item.id));
export const BUBBLE_IDS = new Set(BUBBLES.map((item) => item.id));
export const EFFECT_IDS = new Set(EFFECTS.map((item) => item.id));

// ---------- 消息摘要 ----------

/** 截断到指定字数（按字符算，不会把表情符号切成两半） */
export function truncate(text: string, length: number): string {
  const chars = [...text];
  return chars.length > length ? `${chars.slice(0, length).join('')}…` : text;
}

/** 一条消息的简短说明，用于引用回复、合并转发里的互动消息、会话列表和搜索结果 */
export function summarize(message: Pick<ChatMessage, 'text' | 'file' | 'sticker' | 'poll' | 'relay' | 'wheel' | 'gomoku' | 'forward' | 'nudge'>): string {
  if (message.text !== undefined) return truncate(message.text.replace(/\s+/g, ' ').trim(), LIMITS.summaryLength);
  if (message.file) return `${message.file.image ? '[图片]' : '[文件]'} ${message.file.name}`;
  if (message.sticker) return '[表情]';
  if (message.poll) return `[投票] ${message.poll.question}`;
  if (message.relay) return `[接龙] ${message.relay.title}`;
  if (message.wheel) return `[大转盘] ${message.wheel.title}`;
  if (message.gomoku) return '[五子棋]';
  if (message.forward) return `[聊天记录] ${message.forward.title}`;
  if (message.nudge) return `[拍一拍] ${message.nudge.targetName}`;
  return '';
}
