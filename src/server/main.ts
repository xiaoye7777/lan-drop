import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

/** 列出本机所有内网 IPv4 地址，方便把网址发给同事 */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address)
    // 198.18.x.x 是代理软件的虚拟网卡（如 Clash 的 TUN 模式），同事访问不到
    .filter((address) => !/^198\.1[89]\./.test(address));
}

const config = loadConfig();
const app = createApp(config);

app.server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被占用。可以换一个端口启动：LAN_DROP_PORT=8001 npm start`);
  } else {
    console.error('启动失败：', error);
  }
  process.exit(1);
});

app.server.listen({ port: config.port, host: config.host }, () => {
  console.log('\nlan-drop 已启动\n');
  const hosts = config.host ? [config.host] : lanAddresses();
  for (const host of hosts) console.log(`  访问地址：http://${host}:${config.port}`);
  console.log(`  本机访问：http://localhost:${config.port}`);
  console.log(`  访问口令：${config.accessCode}`);
  console.log(`  数据目录：${config.dataDir}\n`);
  console.log('把访问地址和口令发给同事即可。按 Ctrl+C 停止。\n');
});

function shutdown(): void {
  app.close().then(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
