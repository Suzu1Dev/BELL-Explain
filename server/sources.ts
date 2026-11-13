import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as safeFetch } from 'undici';
import ipaddr from 'ipaddr.js';
import * as cheerio from 'cheerio';
import type { GenerateRequest, Source } from '../shared/types.js';
import { AppError } from './errors.js';

const MAX_BYTES = 1_000_000;
const MAX_TEXT = 45_000;
export function isPublicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    return parsed.range() === 'unicast';
  } catch { return false; }
}
export function validatePublicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new AppError(400, '請輸入完整的 HTTPS 網址。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (isIP(host) && !isPublicAddress(host))) {
    throw new AppError(400, '只支援公開的 HTTPS 網址，無法讀取本機或內部網路。');
  }
  url.hash = '';
  // A note keeps the address it was read from, and notes sync with addresses up to 4,000 characters.
  if (url.href.length > 4000) throw new AppError(400, '網址超過 4,000 字元，請改用較短的網址，或直接貼上內容。');
  return url;
}

export interface FetchedSource { text: string; url: string; contentType: string; }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, {once:true});
    promise.then(value => {signal.removeEventListener('abort', abort); resolve(value);}, error => {signal.removeEventListener('abort', abort); reject(error);});
  });
}
export async function fetchPublic(input: string, signal: AbortSignal): Promise<FetchedSource> {
  let url = validatePublicUrl(input);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  for (let redirects = 0; redirects <= 3; redirects++) {
    timeout.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    // Resolve once, validate every address, and pin the connection to those addresses.
    // The original hostname is retained for TLS validation and the HTTP Host header.
    const addresses = await abortable(lookup(hostname, {all:true}), timeout);
    timeout.throwIfAborted();
    if (!addresses.length || addresses.some(result => !isPublicAddress(result.address))) throw new AppError(400, '此網址解析到非公開網路，無法讀取。');
    const dispatcher = new Agent({connect:{timeout:7000, lookup: (_host, options, callback) => {
      const matching = options.family ? addresses.filter(item => item.family === options.family) : addresses;
      const selected = matching[0];
      if (!selected) { callback(new Error('No public address'), '', 4); return; }
      if (options.all) callback(null, matching);
      else callback(null, selected.address, selected.family);
    }}});
    try {
      const response = await safeFetch(url, {dispatcher, signal:timeout, redirect:'manual', headers:{'user-agent':'BELL-Explain/0.1 (personal learning reader)', accept:'text/html,text/plain,application/json;q=0.9,text/markdown;q=0.9'}});
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) throw new AppError(422, '來源重新導向過多，請改用最終文章網址。');
        url = validatePublicUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(response.status === 404 ? 404 : 422, response.status === 404 ? '找不到公開來源，請確認網址。' : '來源網站拒絕讀取或暫時無法使用，請直接貼上內容。');
      }
      const contentType = response.headers.get('content-type') || '';
      if (!/text\/|application\/(json|[^;]+\+json|xhtml\+xml)/i.test(contentType)) {
        await response.body?.cancel(); throw new AppError(422, '這個網址不是可讀取的文字網頁。請貼上文章或程式碼。');
      }
      if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) { await response.body?.cancel(); throw new AppError(413, '來源超過 1 MB，請直接貼上需要解釋的段落。'); }
      const reader = response.body?.getReader();
      if (!reader) throw new AppError(422, '來源沒有可讀取的內容。');
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new AppError(413, '來源超過 1 MB，請直接貼上需要解釋的段落。'); }
        chunks.push(value);
      }
      return {text:Buffer.concat(chunks).toString('utf8'), url:url.href, contentType};
    } finally { await dispatcher.close(); }
  }
  throw new AppError(422, '無法讀取此來源。');
}

type Reader = typeof fetchPublic;
function trimSource(content: string): {content:string; truncated:boolean} { return {content:content.slice(0, MAX_TEXT), truncated:content.length > MAX_TEXT}; }
function githubRoot(content: string): {owner:string; repo:string; url:string} {
  const url = validatePublicUrl(content);
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname !== 'github.com' || parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_.-]+$/.test(part))) throw new AppError(400, 'Repository 請輸入公開 GitHub 專案根網址，例如 https://github.com/owner/repo。');
  const [owner, rawRepo] = parts; const repo = rawRepo.replace(/\.git$/, '');
  return {owner, repo, url:`https://github.com/${owner}/${repo}`};
}
interface GitHubEntry { name:string; path:string; type:string; size:number; }
function decodeFile(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload as {encoding?:string; content?:string; size?:number};
  if (value.encoding !== 'base64' || typeof value.content !== 'string' || (value.size || 0) > 50_000) return '';
  return Buffer.from(value.content, 'base64').toString('utf8');
}
async function readRepository(request: GenerateRequest, signal: AbortSignal, read: Reader): Promise<Source> {
  const repo = githubRoot(request.content); const api = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
  const json = async (url: string): Promise<unknown> => { const result = await read(url, signal); try { return JSON.parse(result.text); } catch { throw new AppError(422, 'GitHub 來源格式無法讀取。'); } };
  const metadata = await json(api) as {default_branch?:string; description?:string; private?:boolean};
  if (metadata.private || typeof metadata.default_branch !== 'string') throw new AppError(422, '目前只支援公開 GitHub repository。');
  const ref = `?ref=${encodeURIComponent(metadata.default_branch)}`;
  const fragments: string[] = [`Repository: ${repo.owner}/${repo.repo}`, `Description: ${String(metadata.description || '').slice(0, 1000)}`];
  const included: string[] = []; const skipped: string[] = [];
  try {
    const result = await json(`${api}/readme${ref}`);
    const readme = decodeFile(result);
    if (readme) { included.push('README'); fragments.push(`--- README ---\n${readme.slice(0, 15_000)}`); if (readme.length > 15_000) skipped.push('README 已截斷'); }
  } catch (error) { if (!(error instanceof AppError && error.status === 404)) throw error; }
  const rootEntries = await json(`${api}/contents${ref}`);
  let entries: GitHubEntry[] = Array.isArray(rootEntries) ? rootEntries : [];
  const folder = entries.find(entry => entry.type === 'dir' && ['src','lib','app'].includes(entry.name));
  if (folder) {
    const children = await json(`${api}/contents/${encodeURIComponent(folder.path)}${ref}`);
    if (Array.isArray(children)) entries = [...entries, ...children];
  }
  const selected = entries.filter(entry => entry.type === 'file' && entry.size <= 25_000 && /\.(tsx?|jsx?|py|go|rs|java|rb|c|cpp|h|swift|vue|svelte)$/i.test(entry.name) && !/(test|spec|\.min\.)/i.test(entry.name)).sort((a,b) => {
    const priority = (entry:GitHubEntry) => /^(index|main|app|server)\./i.test(entry.name) ? 0 : 1;
    return priority(a)-priority(b) || a.path.localeCompare(b.path);
  }).slice(0,3);
  for (const entry of selected) {
    const file = decodeFile(await json(`${api}/contents/${entry.path.split('/').map(encodeURIComponent).join('/')}${ref}`));
    if (file) { included.push(entry.path); fragments.push(`--- ${entry.path} ---\n${file.slice(0, 9000)}`); if (file.length > 9000) skipped.push(`${entry.path} 已截斷`); }
  }
  if (!included.length) throw new AppError(422, '此專案沒有可直接讀取的 README 或小型原始碼，請貼上要解釋的檔案。');
  const clipped = trimSource(fragments.join('\n\n'));
  return {kind:'repo', label:`${repo.owner}/${repo.repo}`, url:repo.url, ...clipped, truncated:clipped.truncated || skipped.length > 0,
    fetchedAt:new Date().toISOString(), scope:`公開分支 ${metadata.default_branch}；實際讀取：${included.join('、')}。僅分析上述檔案，未讀取完整 repository${skipped.length ? `；${skipped.join('、')}` : ''}。`};
}

export async function extractSource(request: GenerateRequest, signal: AbortSignal, read: Reader = fetchPublic): Promise<Source> {
  signal.throwIfAborted();
  if (request.kind === 'document') throw new AppError(400, '請先上傳檔案，再使用檔案 ID 產生解說。');
  if (request.kind === 'repo') return readRepository(request, AbortSignal.any([signal, AbortSignal.timeout(40_000)]), read);
  if (request.kind === 'url') {
    const result = await read(request.content, signal);
    let title = new URL(result.url).hostname; let content = result.text;
    if (/html/i.test(result.contentType)) {
      const $ = cheerio.load(result.text);
      title = $('title').first().text().trim().slice(0, 180) || title;
      $('script,style,noscript,iframe,nav,footer,header,svg,form,.ui-infobar,.ui-toc,.ui-affix-toc,.navbar').remove();
      const main = $('#doc.markdown-body').first().length ? $('#doc.markdown-body').first()
        : $('#doc').first().length ? $('#doc').first()
        : $('article').first().length ? $('article').first()
        : $('main').first().length ? $('main').first()
        : $('.markdown-body').first().length ? $('.markdown-body').first()
        : $('body');
      main.find('p,div,section,h1,h2,h3,h4,li,pre,br').append('\n');
      content = main.text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
    }
    if (content.trim().length < 60) throw new AppError(422, '此網頁沒有足夠的可讀文字，可能需要登入或 JavaScript。請直接貼上內容。');
    return {kind:'url', label:title, url:result.url, ...trimSource(content), fetchedAt:new Date().toISOString(), scope:'讀取公開網址的靜態文字；不包含登入後內容、圖片文字或 JavaScript 動態內容。'};
  }
  return {kind:request.kind, label:request.content.split('\n')[0].slice(0, 100), ...trimSource(request.content), scope:request.kind === 'concept' ? '以你提供的概念作為問題；教學由模型知識生成，未額外查證外部來源。' : '僅分析本次貼上的內容，未讀取其他檔案或外部連結。'};
}
