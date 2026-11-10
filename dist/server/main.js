import { isIPv4 } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { loadOrCreateCertificate } from './tls.js';
/** 列出本机所有内网 IPv4 地址，方便把网址发给同事 */
function lanAddresses() {
    return Object.values(networkInterfaces())
        .flatMap((items) => items ?? [])
        .filter((item) => item.family === 'IPv4' && !item.internal)
        .map((item) => item.address)
        // 198.18.x.x 是代理软件的虚拟网卡（如 Clash 的 TUN 模式），同事访问不到
        .filter((address) => !/^198\.1[89]\./.test(address));
}
// Node 太旧时直接说明原因，免得出现看不懂的报错
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
    console.error(`需要 Node.js 20 或更高版本，当前是 ${process.version}。`);
    process.exit(1);
}
if (nodeMajor < 20)
    console.warn(`当前 Node.js 是 ${process.version}，建议升级到 20 或更高版本。`);
const config = loadConfig();
const hosts = config.host ? [config.host] : lanAddresses();
let tls;
if (config.https) {
    // 证书要覆盖同事可能用到的所有地址
    const ips = [...new Set([...hosts.filter((host) => isIPv4(host)), '127.0.0.1', '::1'])];
    const dnsNames = ['localhost', hostname()].filter((name) => /^[A-Za-z0-9.-]+$/.test(name));
    tls = loadOrCreateCertificate(join(config.dataDir, 'tls'), ips, dnsNames);
}
const app = createApp(config, { tls });
app.server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`端口 ${config.port} 已被占用。可以换一个端口启动：LAN_DROP_PORT=8001 npm start`);
    }
    else {
        console.error('启动失败：', error);
    }
    process.exit(1);
});
function printAddresses() {
    const port = config.port;
    if (tls) {
        for (const host of hosts)
            console.log(`  加密地址（推荐）：https://${host}:${port}`);
        if (config.allowHttp) {
            for (const host of hosts)
                console.log(`  备用地址（加密地址打不开时用）：http://${host}:${port}`);
        }
    }
    else {
        for (const host of hosts)
            console.log(`  访问地址：http://${host}:${port}`);
    }
    console.log(`  本机访问：${tls ? 'https' : 'http'}://localhost:${port}（在这台电脑上用这个地址打开，可以清理任何人的文件）`);
}
app.server.listen({ port: config.port, host: config.host }, () => {
    console.log('\nlan-drop 已启动\n');
    printAddresses();
    console.log(`  访问口令：${config.accessCode}`);
    console.log(`  数据目录：${config.dataDir}\n`);
    if (tls) {
        console.log('加密地址的证书是自己签发的，浏览器第一次打开会提示“不安全”，选择“高级 → 继续访问”即可。');
        console.log('想确认连的是这台服务器，可以在浏览器的证书详情里核对指纹：');
        console.log(`  SHA-256 指纹：${tls.fingerprint}`);
        if (tls.created)
            console.log('  （证书是刚生成的，同事的浏览器会再提示一次“不安全”）');
        if (config.allowHttp)
            console.log('有同事打不开加密地址时，让他改用备用地址（http://），内容不加密，但功能一样。');
        console.log('');
    }
    else {
        console.log('注意：HTTPS 已关闭，聊天内容和文件在网络上是明文传输的。\n');
    }
    if (config.freshDataDir) {
        console.log('这是一个新的数据目录，里面还没有聊天记录。');
        console.log('如果你是在升级新版本：先按 Ctrl+C 停止，用旧版本文件夹里的 data 文件夹替换上面的数据目录，再重新启动。\n');
    }
    console.log('把访问地址和口令发给同事即可。按 Ctrl+C 停止。\n');
});
function shutdown() {
    app.close().then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
