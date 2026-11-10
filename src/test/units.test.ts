// 单元测试：证书生成、图片识别、五子棋判定
import assert from 'node:assert/strict';
import { createPublicKey, X509Certificate } from 'node:crypto';
import { test } from 'node:test';
import { makesFive } from '../server/activities.js';
import { inspectImage } from '../server/images.js';
import { createCertificate, loadOrCreateCertificate } from '../server/tls.js';
import { gifHeader, jpegHeader, newDataDir, pngHeader, webpHeader } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

// ---------- 证书 ----------

test('自签名证书：RSA，签名有效，包含所有地址，不是 CA，有效期 397 天', () => {
  const { key, cert } = createCertificate(['127.0.0.1', '192.168.1.10', '::1'], ['localhost']);
  const x509 = new X509Certificate(cert);

  assert.ok(x509.verify(x509.publicKey), '用自己的公钥能验证签名');
  assert.equal(x509.publicKey.asymmetricKeyType, 'rsa', 'RSA 证书兼容性最好');
  assert.equal(x509.checkIP('192.168.1.10'), '192.168.1.10');
  assert.equal(x509.checkIP('::1'), '::1');
  assert.equal(x509.checkHost('localhost'), 'localhost');
  assert.equal(x509.checkIP('10.0.0.1'), undefined, '没写进去的地址不匹配');
  assert.equal(x509.ca, false, '不能用来签发别的证书');
  assert.deepEqual(x509.keyUsage, ['1.3.6.1.5.5.7.3.1'], '只用于网站服务器');

  const days = (new Date(x509.validTo).getTime() - Date.now()) / DAY;
  assert.ok(days > 396 && days < 398, `有效期 ${days} 天`);

  // 私钥和证书里的公钥是一对
  const fromKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  assert.deepEqual(fromKey, x509.publicKey.export({ type: 'spki', format: 'der' }));
});

test('证书：地址不变时沿用，本机 IP 变了就重新生成', () => {
  const dir = newDataDir();
  const first = loadOrCreateCertificate(dir, ['127.0.0.1'], ['localhost']);
  assert.equal(first.created, true);
  const again = loadOrCreateCertificate(dir, ['127.0.0.1'], ['localhost']);
  assert.equal(again.created, false);
  assert.equal(again.fingerprint, first.fingerprint);
  const moved = loadOrCreateCertificate(dir, ['127.0.0.1', '10.1.2.3'], ['localhost']);
  assert.equal(moved.created, true);
  assert.notEqual(moved.fingerprint, first.fingerprint);
});

// ---------- 图片识别 ----------

test('识别 PNG、JPEG、GIF、WebP 的格式和尺寸', () => {
  assert.deepEqual(inspectImage(pngHeader(640, 480)), { type: 'png', width: 640, height: 480 });
  assert.deepEqual(inspectImage(jpegHeader(4000, 3000)), { type: 'jpeg', width: 4000, height: 3000 });
  assert.deepEqual(inspectImage(gifHeader(120, 90)), { type: 'gif', width: 120, height: 90 });
  assert.deepEqual(inspectImage(webpHeader(1024, 768)), { type: 'webp', width: 1024, height: 768 });

  // WebP 的另外两种编码
  const lossless = Buffer.alloc(30);
  lossless.write('RIFF', 0, 'latin1');
  lossless.write('WEBP', 8, 'latin1');
  lossless.write('VP8L', 12, 'latin1');
  lossless[20] = 0x2f;
  lossless.writeUInt32LE((300 - 1) | ((200 - 1) << 14), 21);
  assert.deepEqual(inspectImage(lossless), { type: 'webp', width: 300, height: 200 });

  const lossy = Buffer.alloc(30);
  lossy.write('RIFF', 0, 'latin1');
  lossy.write('WEBP', 8, 'latin1');
  lossy.write('VP8 ', 12, 'latin1');
  Buffer.from([0x9d, 0x01, 0x2a]).copy(lossy, 23);
  lossy.writeUInt16LE(800, 26);
  lossy.writeUInt16LE(600, 28);
  assert.deepEqual(inspectImage(lossy), { type: 'webp', width: 800, height: 600 });
});

test('不认识的格式、读不出尺寸、尺寸过大，都不当图片', () => {
  assert.equal(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(inspectImage(Buffer.from('<!doctype html><script>alert(1)</script>')), null);
  assert.equal(inspectImage(Buffer.from('PK\x03\x04 zip file')), null);
  assert.equal(inspectImage(pngHeader(640, 480).subarray(0, 20)), null, '文件头不完整');
  assert.equal(inspectImage(pngHeader(30000, 30000)), null);
  assert.equal(inspectImage(pngHeader(10000, 10000)), null, '超过像素总数上限');
  assert.equal(inspectImage(pngHeader(0, 100)), null);
  assert.equal(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null, '没有尺寸信息的 JPEG');
});

// ---------- 五子棋 ----------

/** 让黑棋下在指定位置，白棋下在远处不相干的位置 */
function blackPlays(cells: number[]): number[] {
  const white = [224, 222, 220, 218, 216, 214];
  return cells.flatMap((cell, i) => (i < cells.length - 1 ? [cell, white[i]] : [cell]));
}

test('五子棋判定：横、竖、两条斜线都能连五，四个不算', () => {
  const at = (row: number, col: number) => row * 15 + col;
  const lines = {
    横: [0, 1, 2, 3, 4].map((i) => at(7, 3 + i)),
    竖: [0, 1, 2, 3, 4].map((i) => at(2 + i, 5)),
    斜: [0, 1, 2, 3, 4].map((i) => at(i, i)),
    反斜: [0, 1, 2, 3, 4].map((i) => at(i, 10 - i)),
  };
  for (const [name, cells] of Object.entries(lines)) {
    const moves = blackPlays(cells);
    assert.equal(makesFive(moves, cells[4]), true, `${name}连五`);
    assert.equal(makesFive(blackPlays(cells.slice(0, 4)), cells[3]), false, `${name}四个不算`);
  }
  // 中间落子补成五个也算
  const gap = [at(9, 0), at(9, 1), at(9, 3), at(9, 4), at(9, 2)];
  assert.equal(makesFive(blackPlays(gap), at(9, 2)), true);
  // 跨行不算：第 0 行最后两格和第 1 行开头三格在数组里是连续的
  const wrap = [13, 14, 15, 16, 17];
  assert.equal(makesFive(blackPlays(wrap), 17), false);
});
