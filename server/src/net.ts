import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { User } from './auth.js';

// 普通用户填写的邮件服务器、模型接口地址会由服务器去连接。为防止被用来探测服务器所在的内网
// （或云厂商的元数据地址），没有"内网地址"权限的用户只能连接公网地址。

function privateV4(ip: string) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** 把 IPv6 地址展开成 8 组 16 位数；格式不对返回 null */
function expandV6(ip: string): number[] | null {
  let v = ip.toLowerCase().split('%')[0];
  // 末尾带点分十进制的写法（::ffff:1.2.3.4）先换成两组十六进制
  const dotted = v.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    v = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = v.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const g = expandV6(ip);
  // 解析不了的一律当作不安全
  if (!g) return true;
  const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  // 内嵌 IPv4 的几种写法：::ffff:a.b.c.d（映射）、::a.b.c.d（兼容，含 :: 和 ::1）、64:ff9b::/96（NAT64）
  if (zeros(5) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 && g[6] === 0 && g[7] <= 1 ? true : privateV4(v4);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4(v4);
  // fc00::/7 唯一本地地址、fe80::/10 链路本地、ff00::/8 组播
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
}

/** 主机名解析到内网 / 本机地址时抛出 403 */
export async function assertPublicHost(user: User, host: string, what: string): Promise<void> {
  if (user.perms.privateHosts || !host) return;
  const h = host.replace(/^\[|\]$/g, '');
  let ips: string[];
  try {
    ips = isIP(h) ? [h] : (await lookup(h, { all: true })).map((r) => r.address);
  } catch {
    return; // 解析不了的地址连接时自然会失败，这里不拦
  }
  if (ips.some(isPrivateIp))
    throw Object.assign(new Error(`${what}指向内网或本机地址，管理员没有给你开放这个权限`), { statusCode: 403 });
}

export async function assertPublicUrl(user: User, url: string, what: string): Promise<void> {
  if (!url) return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  await assertPublicHost(user, host, what);
}
