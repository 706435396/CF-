/**
 * 纯 JS MD5 实现（Cloudflare Workers 无 node:crypto，WebCrypto 不支持 MD5）
 * 标准 RFC 1321 算法，硬编码 K/S 表，已用标准向量 + 中文验证。
 * 返回小写 32 位十六进制字符串，支持 UTF-8。
 */

// T[i] = floor(abs(sin(i+1)) * 2^32)，硬编码避免浮点误差
const K = [
  0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
  0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
  0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
  0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
  0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
  0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
  0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
  0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391,
];
// 每轮左移位数（64 个，按 16 轮分四组）
const S = [
  7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
  5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
  4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
  6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21,
];

function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) | 0; }

export function md5(str) {
  // UTF-8 编码为字节数组
  const utf8 = unescape(encodeURIComponent(str));
  const bytes = new Array(utf8.length);
  for (let i = 0; i < utf8.length; i++) bytes[i] = utf8.charCodeAt(i) & 0xff;

  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const lo = bitLen >>> 0;
  const hi = Math.floor(bitLen / 4294967296) >>> 0;
  bytes.push(lo & 0xff, (lo >>> 8) & 0xff, (lo >>> 16) & 0xff, (lo >>> 24) & 0xff);
  bytes.push(hi & 0xff, (hi >>> 8) & 0xff, (hi >>> 16) & 0xff, (hi >>> 24) & 0xff);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let off = 0; off < bytes.length; off += 64) {
    const M = new Array(16);
    for (let j = 0; j < 16; j++) {
      const o = off + j * 4;
      M[j] = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) | 0;
    }
    let a = a0, b = b0, c = c0, d = d0;
    for (let j = 0; j < 64; j++) {
      let F, g;
      if (j < 16) { F = (b & c) | (~b & d); g = j; }
      else if (j < 32) { F = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { F = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { F = c ^ (b | ~d); g = (7 * j) % 16; }
      F = (F + a + K[j] + M[g]) | 0;
      a = d; d = c; c = b;
      b = (b + rotl(F, S[j])) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }

  const result = [a0, b0, c0, d0];
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 4; i++) {
    const w = result[i];
    for (let b = 0; b < 4; b++) {
      const byte = (w >>> (b * 8)) & 0xff;
      out += hex[(byte >> 4) & 0x0f] + hex[byte & 0x0f];
    }
  }
  return out;
}
