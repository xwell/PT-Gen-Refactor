import { NONE_EXIST_ERROR } from "./common.js";

const BGM_API_BASE = "https://api.bgm.tv/v0";
const BGM_API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Referer': 'https://bgm.tv/'
};

const DEFAULT_TIMEOUT = 15000;

async function fetchWithTimeout(url, { timeout = DEFAULT_TIMEOUT, ...opts } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    // log minimal info for debugging
    // console.log(`[bgm] fetch ${url}`);
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

const safe = (v, fallback = '') => (v === undefined || v === null ? fallback : v);

const ensureArray = v => (Array.isArray(v) ? v : (v ? [v] : []));

/**
 * 归一化人物关系，返回分类对象 { directors:[], writers:[], actors:[], others:[] }
 * persons: bangumi persons array
 */
function classifyPersons(persons = []) {
  const directors = [];
  const writers = [];
  const actors = [];
  const others = [];

  for (const p of persons) {
    if (!p) continue;
    const relation = (p.relation || '').toLowerCase();
    const info = {
      id: p.id || '',
      name: p.name || '',
      name_cn: p.name_cn || '',
      relation: p.relation || ''
    };
    if (/导(演|演员)|监督|director/.test(relation)) directors.push(info);
    else if (/编剧|脚本|writer/.test(relation)) writers.push(info);
    else if (/声优|cast|actor|演员/.test(relation)) actors.push(info);
    else others.push(info);
  }

  return { directors, writers, actors, others };
}

/**
 * 处理角色数据，返回字符串数组 ["角色名 (中文): 配音/演员1、演员2", ...]
 */
function formatCharacters(chars = []) {
  const out = [];
  for (const c of chars) {
    if (!c) continue;
    const name = safe(c.name, '');
    const name_cn = safe(c.name_cn, '');
    const actors = ensureArray(c.actors).map(a => (a?.name_cn || a?.name || '')).filter(Boolean);
    const actorText = actors.length ? actors.join('、') : '未知';
    const title = name_cn ? `${name} (${name_cn})` : name || name_cn;
    if (title) out.push(`${title}: ${actorText}`);
  }
  return out;
}

/**
 * 将 subject.type/subject.type_name/subject.type_cn 归一化为可读类型（优先中文）
 * 兼容 numeric code / english name / already localized
 */
function normalizeType(subject) {
  if (!subject) return '';
  // 优先使用已有人类可读字段
  if (subject.type_name && String(subject.type_name).trim()) return String(subject.type_name).trim();
  if (subject.type_cn && String(subject.type_cn).trim()) return String(subject.type_cn).trim();

  const t = subject.type;
  if (typeof t === 'string' && t.trim()) {
    // 已是字符串，尝试常见英文->中文映射
    const s = t.trim();
    const map = {
      'anime': '动画',
      'book': '书籍',
      'game': '游戏',
      'music': '音乐',
      'real': '三次元',
      'tv': '电视',
      'movie': '电影'
    };
    if (map[s.toLowerCase()]) return map[s.toLowerCase()];
    return s;
  }

  if (typeof t === 'number') {
    // 常见 Bangumi numeric type -> 中文映射（覆盖常见值）
    const numMap = {
      1: '书籍',
      2: '动画',
      3: '音乐',
      4: '游戏',
      6: '三次元'
    };
    return numMap[t] || String(t);
  }

  return '';
}

export async function gen_bangumi(sid, env) {
  const data = { site: "bangumi", sid };
  if (!sid) return Object.assign(data, { error: "Invalid Bangumi subject id" });

  const subjectUrl = `${BGM_API_BASE}/subjects/${encodeURIComponent(sid)}`;
  const personsUrl = `${subjectUrl}/persons`;
  const charactersUrl = `${subjectUrl}/characters`;

  try {
    // 请求 subject 主数据
    const subjResp = await fetchWithTimeout(subjectUrl, { headers: BGM_API_HEADERS, timeout: 20000 });
    if (!subjResp) return Object.assign(data, { error: "No response from Bangumi API" });
    if (subjResp.status === 404) return Object.assign(data, { error: NONE_EXIST_ERROR });
    if (!subjResp.ok) {
      const txt = await subjResp.text().catch(() => '');
      return Object.assign(data, { error: `Bangumi subject request failed ${subjResp.status}: ${txt}` });
    }
    const subject = await subjResp.json().catch(() => null);
    if (!subject) return Object.assign(data, { error: "Failed to parse Bangumi subject response" });

    // 并行请求 persons & characters（允许部分失败）
    const [personsRes, charactersRes] = await Promise.allSettled([
      fetchWithTimeout(personsUrl, { headers: BGM_API_HEADERS, timeout: 15000 }),
      fetchWithTimeout(charactersUrl, { headers: BGM_API_HEADERS, timeout: 15000 })
    ]);

    let persons = [];
    if (personsRes.status === 'fulfilled' && personsRes.value && personsRes.value.ok) {
      persons = await personsRes.value.json().catch(() => []);
    } else {
      // silent warn
      // console.warn(`[bgm] persons fetch failed for ${sid}`);
    }

    let characters = [];
    if (charactersRes.status === 'fulfilled' && charactersRes.value && charactersRes.value.ok) {
      characters = await charactersRes.value.json().catch(() => []);
    } else {
      // console.warn(`[bgm] characters fetch failed for ${sid}`);
    }

    // 归一化输出字段
    data.bgm_id = subject.id || sid;
    data.name = safe(subject.name, '');
    data.name_cn = safe(subject.name_cn, '');
    data.summary = safe(subject.summary, '');
    data.poster = subject.images?.large || subject.images?.common || subject.image || '';
    data.bgm_rating_average = subject.rating?.score ?? 0;
    data.bgm_votes = subject.rating?.total ?? 0;
    data.bgm_rating = subject.rating ? `${subject.rating.score}/10 from ${subject.rating.total} users` : '';
    data.date = safe(subject.date, '');
    data.year = data.date ? String(data.date).slice(0, 4) : '';
    data.platform = safe(subject.platform, '');
    data.tags = Array.isArray(subject.tags) ? subject.tags.map(t => t.name) : [];
    data.eps = subject.eps_count ?? subject.eps ?? '';
    // 使用 normalizeType 以保持与旧逻辑兼容的“正确类型”
    data.type = normalizeType(subject) || '';
    data.collection = subject.collection || {};

    // persons classify
    const classified = classifyPersons(ensureArray(persons));
    data.directors = classified.directors;
    data.writers = classified.writers;
    data.actors = classified.actors;
    data.persons_other = classified.others;

    // characters format
    const charList = formatCharacters(ensureArray(characters));
    data.characters = charList;

    // 构建 format 文本（简洁、有回退）
    const lines = [];
    if (data.poster) lines.push(`[img]${data.poster}[/img]`, '');
    const titleLine = data.name_cn || data.name || 'N/A';
    lines.push(`❁ 标题: ${titleLine}`);
    if (data.type) lines.push(`❁ 类型: ${data.type}`);
    if (data.eps) lines.push(`❁ 话数: ${data.eps}`);
    if (data.date) lines.push(`❁ 首播: ${data.date}`);
    if (data.year) lines.push(`❁ 年份: ${data.year}`);
    if (data.platform) lines.push(`❁ 平台: ${data.platform}`);
    if (data.tags && data.tags.length) lines.push(`❁ 标签: ${data.tags.join(' / ')}`);
    if (data.bgm_rating) lines.push(`❁ Bangumi评分: ${data.bgm_rating}`);
    // persons
    if (data.directors && data.directors.length) lines.push(`❁ 导演: ${data.directors.map(d => d.name_cn || d.name).join(' / ')}`);
    if (data.writers && data.writers.length) lines.push(`❁ 编剧: ${data.writers.map(w => w.name_cn || w.name).join(' / ')}`);
    if (data.actors && data.actors.length) lines.push(`❁ 主要人物: ${data.actors.map(a => a.name_cn || a.name).slice(0, 10).join(' / ')}`);
    // characters
    if (data.characters && data.characters.length) {
      lines.push('', '❁ 角色信息:');
      lines.push(...data.characters.slice(0, 20).map(c => `  ${c}`));
    }
    // summary
    if (data.summary) {
      lines.push('', '❁ 简介', `  ${data.summary.replace(/\n/g, '\n  ')}`);
    }

    data.format = lines.join('\n').trim();
    data.success = true;
    return data;
  } catch (err) {
    const message = err?.message || String(err);
    return Object.assign(data, { error: `Bangumi processing error: ${message}` });
  }
}