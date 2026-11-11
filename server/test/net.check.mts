import { isPrivateIp } from '../src/net.ts';

// 内网 / 本机地址判断：这些地址由用户填写、由服务器去连接，漏判就是内网探测漏洞
const cases: [string, boolean][] = [
  ['127.0.0.1', true], ['10.1.2.3', true], ['192.168.1.1', true], ['172.16.0.1', true], ['172.32.0.1', false],
  ['169.254.169.254', true], ['100.64.0.1', true], ['0.0.0.0', true], ['8.8.8.8', false], ['1.1.1.1', false],
  ['::1', true], ['::', true], ['::ffff:127.0.0.1', true], ['::ffff:7f00:1', true], ['::ffff:a9fe:a9fe', true],
  ['::ffff:8.8.8.8', false], ['::ffff:808:808', false], ['::7f00:1', true], ['64:ff9b::7f00:1', true], ['64:ff9b::808:808', false],
  ['fc00::1', true], ['fd12:3456::1', true], ['fe80::1', true], ['febf::1', true], ['ff02::1', true],
  ['2001:4860:4860::8888', false], ['2606:4700:4700::1111', false], ['not-an-ip', true],
];
let bad = 0;
for (const [ip, want] of cases) if (isPrivateIp(ip) !== want) (bad++, console.log('✗', ip, 'expected', want));
console.log(bad ? `net: ${bad} 项不符` : `net: ${cases.length} 项全部通过`);
process.exit(bad ? 1 : 0);
