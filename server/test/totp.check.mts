import { base32Decode, base32Encode, newRecoveryCodes, totpAt, useRecoveryCode, verifyTotp } from '../src/totp.ts';

// RFC 6238 附录 B 的 SHA1 测试向量（密钥 "12345678901234567890"，取 8 位结果的后 6 位）
const secret = Buffer.from('12345678901234567890');
const vectors: [number, string][] = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']];
let bad = 0;
for (const [t, want] of vectors) {
  const got = totpAt(secret, Math.floor(t / 30));
  if (got !== want) (bad++, console.log('✗ totp', t, got, 'expected', want));
}
const b32 = base32Encode(secret);
if (b32 !== 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' || !base32Decode(b32).equals(secret)) (bad++, console.log('✗ base32', b32));
const now = 1111111111_000;
if (!verifyTotp(1, b32, '050471', now)) (bad++, console.log('✗ verify current'));
if (verifyTotp(1, b32, '050471', now)) (bad++, console.log('✗ replay should be rejected'));
if (!verifyTotp(2, b32, '081804', now)) (bad++, console.log('✗ previous step should pass'));
if (verifyTotp(3, b32, '000000', now) || verifyTotp(3, b32, 'abc', now)) (bad++, console.log('✗ wrong code accepted'));
const { plain, hashed } = newRecoveryCodes();
const left = useRecoveryCode(hashed, plain[3].toUpperCase().replace('-', ' '));
if (!left || left.length !== 9 || useRecoveryCode(left, plain[3]) !== null || useRecoveryCode(hashed, 'nope') !== null) (bad++, console.log('✗ recovery codes'));
console.log(bad ? `totp: ${bad} 项不符` : `totp: ${vectors.length + 6} 项全部通过`);
process.exit(bad ? 1 : 0);
