const STEAM_APP_DETAILS_URL = "https://store.steampowered.com/api/appdetails";
const DEFAULT_TIMEOUT = 10000; // ms
const MAX_SCREENSHOTS = 3;

const fetchWithTimeout = async (url, opts = {}, timeout = DEFAULT_TIMEOUT) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
};

const safe = (v, fallback = '') => (v === undefined || v === null ? fallback : v);

const isNumericString = s => typeof s === 'string' && /^\d+$/.test(s);

const formatPrice = p => {
  if (!p || typeof p !== 'object') return null;
  const currency = p.currency || '';
  const initial = typeof p.initial === 'number' ? (p.initial / 100).toFixed(2) : null;
  const final = typeof p.final === 'number' ? (p.final / 100).toFixed(2) : null;
  const discount = p.discount_percent || 0;
  return { currency, initial, final, discount };
};

const cleanHtml = html => {
  if (!html) return '';
  let s = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  return s;
};

const wrapLines = (text, indent = '  ', max = 80) => {
  if (!text) return '';
  const words = String(text).split(/\s+/);
  let cur = indent;
  let out = '';
  for (const w of words) {
    if ((cur.length + w.length + 1) > max) {
      out += cur + '\n';
      cur = indent + w;
    } else {
      cur += (cur.trim().length > indent.trim().length ? ' ' : '') + w;
    }
  }
  if (cur.trim()) out += cur + '\n';
  return out;
};

/**
 * 处理 Steam PC requirements 字段
 * - 删除标签行（Minimum:/Recommended:）
 * - 在遇到标签时先 flush 缓冲内容
 * - 处理 Additional Notes 特殊段落
 */
const processRequirements = (reqText, title) => {
  if (!reqText) return '';
  const cleaned = cleanHtml(reqText);
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  let result = `❁ ${title}\n`;
  let buffer = [];

  const appendWrapped = (bufLines, indent = '    ', max = 80) => {
    for (const line of bufLines) {
      result += wrapLines(line, indent, max);
    }
  };

  for (const rawLine of lines) {
    if (!rawLine) continue;
    const line = rawLine.trim();
    const lower = line.toLowerCase();

    // 删除/跳过标签行（Minimum:/Recommended:），遇到标签时先 flush 缓冲
    if (lower === 'minimum:' || lower === 'recommended:' || lower === 'minimum' || lower === 'recommended') {
      if (buffer.length) {
        appendWrapped(buffer);
        buffer = [];
      }
      continue;
    }

    // Additional Notes 特殊处理
    if (/additional notes[:：]/i.test(line)) {
      if (buffer.length) {
        appendWrapped(buffer);
        buffer = [];
      }
      result += `  Additional Notes:\n`;
      const noteContent = line.replace(/.*additional notes[:：]?\s*/i, '').trim();
      if (noteContent) result += wrapLines(noteContent, '    ');
      continue;
    }

    // 常规行入缓冲
    buffer.push(line);
  }

  // flush 剩余缓冲
  if (buffer.length) {
    appendWrapped(buffer);
  }

  result += '\n';
  return result;
};

export async function gen_steam(sid, env) {
  let data = { site: "steam", sid: sid };

  try {
    if (!sid || (!isNumericString(String(sid)))) {
      return Object.assign(data, { error: "Invalid Steam ID format. Expected numeric appid" });
    }
    const appid = String(sid);

    const steam_api_url = `${STEAM_APP_DETAILS_URL}?appids=${encodeURIComponent(appid)}&l=english`;
    let steam_response;
    try {
      steam_response = await fetchWithTimeout(steam_api_url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }, DEFAULT_TIMEOUT);
    } catch (err) {
      return Object.assign(data, { error: `Steam API fetch error: ${err?.name === 'AbortError' ? 'Request timeout' : err?.message || err}` });
    }

    if (!steam_response || !steam_response.ok) {
      const status = steam_response ? steam_response.status : 'no response';
      return Object.assign(data, { error: `Steam API request failed with status ${status}` });
    }

    let steam_data;
    try {
      steam_data = await steam_response.json();
    } catch (err) {
      return Object.assign(data, { error: "Failed to parse Steam API response" });
    }

    const entry = safe(steam_data[appid], {});
    if (!entry.success) {
      return Object.assign(data, { error: "Failed to retrieve Steam app details" });
    }

    const app_data = safe(entry.data, {});
    data.name = safe(app_data.name, "N/A");
    data.type = safe(app_data.type, "N/A");
    data.short_description = safe(app_data.short_description, "");
    data.header_image = safe(app_data.header_image, "");
    data.website = safe(app_data.website, "");
    data.developers = Array.isArray(app_data.developers) ? app_data.developers : [];
    data.publishers = Array.isArray(app_data.publishers) ? app_data.publishers : [];
    data.release_date = app_data.release_date ? safe(app_data.release_date.date, "N/A") : "N/A";
    data.coming_soon = !!(app_data.release_date && app_data.release_date.coming_soon);

    // price
    if (app_data.price_overview) {
      const p = formatPrice(app_data.price_overview);
      if (p) data.price = p;
    }

    data.supported_languages = safe(app_data.supported_languages, "");
    if (app_data.platforms) {
      data.platforms = {
        windows: !!app_data.platforms.windows,
        mac: !!app_data.platforms.mac,
        linux: !!app_data.platforms.linux
      };
    } else {
      data.platforms = { windows: false, mac: false, linux: false };
    }

    data.categories = Array.isArray(app_data.categories) ? app_data.categories.map(c => c.description) : [];
    data.genres = Array.isArray(app_data.genres) ? app_data.genres.map(g => g.description) : [];

    // requirements
    if (app_data.pc_requirements) {
      data.pc_requirements = {
        minimum: safe(app_data.pc_requirements.minimum, ""),
        recommended: safe(app_data.pc_requirements.recommended, "")
      };
    } else {
      data.pc_requirements = { minimum: "", recommended: "" };
    }

    // screenshots
    if (Array.isArray(app_data.screenshots)) {
      data.screenshots = app_data.screenshots.slice(0, MAX_SCREENSHOTS).map(s => ({
        id: s.id,
        path_thumbnail: s.path_thumbnail,
        path_full: s.path_full
      }));
    } else {
      data.screenshots = [];
    }

    // build description
    let descr = "";
    if (data.header_image) descr += `[img]${data.header_image}[/img]\n\n`;

    descr += `❁ 游戏名称: ${data.name}\n`;
    descr += `❁ 游戏类型: ${data.type}\n`;
    descr += `❁ 发行日期: ${data.release_date}\n`;

    if (data.developers && data.developers.length) {
      descr += `❁ 开 发 商: ${data.developers.join(", ")}\n`;
    }
    if (data.publishers && data.publishers.length) {
      descr += `❁ 发 行 商: ${data.publishers.join(", ")}\n`;
    }
    if (data.genres && data.genres.length) {
      descr += `❁ 游戏类型: ${data.genres.join(", ")}\n`;
    }
    if (data.categories && data.categories.length) {
      descr += `❁ 分类标签: ${data.categories.join(", ")}\n`;
    }

    if (data.price) {
      if (data.price.discount > 0 && data.price.initial) {
        descr += `❁ 原　　价: ${data.price.initial} ${data.price.currency}\n`;
        descr += `❁ 现　　价: ${data.price.final} ${data.price.currency} (折扣${data.price.discount}%)\n`;
      } else if (data.price.final) {
        descr += `❁ 价　　格: ${data.price.final} ${data.price.currency}\n`;
      }
    }

    if (data.platforms) {
      const platforms = [];
      if (data.platforms.windows) platforms.push("Windows");
      if (data.platforms.mac) platforms.push("Mac");
      if (data.platforms.linux) platforms.push("Linux");
      if (platforms.length) descr += `❁ 支持平台: ${platforms.join(", ")}\n`;
    }

    descr += `❁ Steam链接: https://store.steampowered.com/app/${appid}/\n\n`;

    if (data.short_description) {
      descr += `❁ 简介\n  ${String(data.short_description).replace(/\n/g, '\n  ')}\n\n`;
    }

    // requirements text
    if (data.pc_requirements && data.pc_requirements.minimum) {
      descr += processRequirements(data.pc_requirements.minimum, "最低配置");
    }
    if (data.pc_requirements && data.pc_requirements.recommended) {
      descr += processRequirements(data.pc_requirements.recommended, "推荐配置");
    }

    // screenshots
    if (data.screenshots && data.screenshots.length) {
      descr += `❁ 游戏截图\n`;
      for (const s of data.screenshots) {
        if (s.path_full) descr += `[img]${s.path_full}[/img]\n`;
      }
      descr += `\n`;
    }

    data.format = descr.trim();
    data.success = true;

    return data;
  } catch (error) {
    return Object.assign(data, { error: `Steam app processing error: ${error?.message || error}` });
  }
}