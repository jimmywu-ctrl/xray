import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { proxyAgent } from '../adapters/core/proxy.ts';
import { usableAvatarUrl } from './avatar-policy.mjs';
import { AvatarCache } from './avatar-cache.mjs';

const MAX_BYTES = 5 * 1024 * 1024;
const cache = new AvatarCache({directory:path.join(process.env.XRAY_DATA_DIR??path.join(process.env.APPDATA??os.homedir(),'xray-next'),'cache','avatars')});

function validate(value) {
  if (!usableAvatarUrl(value)) throw new Error('头像地址不在允许范围');
  return new URL(value.trim());
}

function sniffImageContentType(body) {
  if (body.length >= 12 && body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)
    return 'image/jpeg';
  if (body.length >= 6 && ['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString('ascii')))
    return 'image/gif';
  if (body.length >= 12 && body.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brands = body.subarray(8, Math.min(body.length, 64)).toString('ascii');
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
  }
  return null;
}

function requestImage(url, agent, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      agent,
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
        Referer: `https://${url.hostname}/`,
      },
      timeout: 12_000,
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirects < 3) {
        let target;
        try { target = validate(new URL(response.headers.location, url).href); }
        catch (error) { response.resume(); reject(error); return; }
        response.resume();
        requestImage(target, agent, redirects + 1).then(resolve, reject);
        return;
      }
      const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (status !== 200) {
        response.resume();
        reject(Object.assign(new Error(`头像源返回 HTTP ${status || '未知'}`), { status: status || 502 }));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_BYTES) {
          response.destroy(new Error('头像图片超过大小限制'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        const contentType = type.startsWith('image/') ? type : sniffImageContentType(body);
        if (!contentType) {
          reject(new Error(`头像源返回的内容不是可识别图片：${type || '未声明类型'}`));
          return;
        }
        resolve({ body, contentType });
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('头像请求超时')));
    request.on('error', reject);
  });
}

export async function fetchAvatarImage(source) {
  const url = validate(source);
  const key = url.href;
  return cache.get(key,async()=>requestImage(url,(await proxyAgent())?.agent));
}
