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

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
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
