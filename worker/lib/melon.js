import { NONE_EXIST_ERROR, page_parser } from "./common.js";

// Melon URL配置
const MELOON_ALBUM_INFO_URL = "https://www.melon.com/album/detail.htm";

/**
 * 生成Melon专辑信息
 * @param {string} sid - 专辑ID (格式如 "album/123456")
 * @param {object} env - 环境变量（保留将来使用）
 * @returns {Promise<object>} 专辑信息对象
 */
export async function gen_melon(sid, env) {
  const data = { site: "melon", sid };

  try {
    console.log("Melon request for sid:", sid);

    const parts = String(sid || "").split("/");
    const media_type = parts[0];
    const media_id = parts[1];

    if (media_type !== "album" || !/^\d+$/.test(media_id)) {
      return Object.assign(data, { error: "Invalid Melon ID format. Expected 'album/<digits>'" });
    }

    return await fetchAlbumInfo(media_id);
  } catch (err) {
    console.error("Melon processing error:", err);
    return Object.assign(data, { error: `Melon processing error: ${err && err.message ? err.message : String(err)}` });
  }
}

/**
 * 辅助：安全获取元素文本
 */
function safeText($el) {
  try {
    return $el && $el.length ? $el.text().trim() : "";
  } catch {
    return "";
  }
}

/**
 * 辅助：处理海报 URL（去除额外参数、提高分辨率、补全域名）
 */
function normalizePoster(src) {
  if (!src) return null;
  // 有些 src 可能是 data-src 或相对路径
  src = String(src).split('?')[0];
  const jpgIndex = src.indexOf('.jpg');
  if (jpgIndex !== -1) src = src.substring(0, jpgIndex + 4);
  src = src.replace(/500\.jpg$/, '1000.jpg');
  if (!/^https?:\/\//i.test(src)) src = `https://www.melon.com${src.startsWith('/') ? '' : '/'}${src}`;
  return src;
}

/**
 * 获取专辑信息
 * @param {string} albumId
 */
async function fetchAlbumInfo(albumId) {
  const data = { site: "melon", sid: `${albumId}` };

  try {
    const melon_url = `${MELOON_ALBUM_INFO_URL}?albumId=${encodeURIComponent(albumId)}`;
    const resp = await fetch(melon_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
      }
    });

    if (!resp.ok) {
      if (resp.status === 404) return Object.assign(data, { error: NONE_EXIST_ERROR });
      throw new Error(`请求失败，状态码 ${resp.status}`);
    }

    const html = await resp.text();
    const $ = page_parser(html);

    const $info = $('.wrap_info');
    if (!$info || $info.length === 0) {
      return Object.assign(data, { error: "未找到专辑信息容器" });
    }

    data.melon_id = albumId;
    data.melon_link = melon_url;
    data.type = "album";

    // 标题
    const titleElem = $info.find('.song_name').first();
    let title = safeText(titleElem).replace(/^앨범명\s*/i, '').trim();
    if (title) data.title = title;

    // 艺术家（去重）
    const artistElems = $info.find('.artist a[href*="goArtistDetail"]');
    if (artistElems && artistElems.length) {
      const artists = [];
      artistElems.each(function () {
        const name = $(this).text().trim();
        if (name && !artists.includes(name)) artists.push(name);
      });
      if (artists.length) data.artists = artists;
    }

    // 优先使用 nth-child 的固定位置提取（兼容旧结构）
    const $infoWrapper = $info;
    const date_elem = $infoWrapper.find('.meta dl:nth-child(1) dd').first();
    if (date_elem && date_elem.length > 0) {
      data.release_date = date_elem.text().trim();
    }

    const genre_elem = $infoWrapper.find('.meta dl:nth-child(2) dd').first();
    if (genre_elem && genre_elem.length > 0) {
      data.genres = genre_elem.text().trim().split(',').map(g => g.trim()).filter(Boolean);
    }

    const publisher_elem = $infoWrapper.find('.meta dl:nth-child(3) dd').first();
    if (publisher_elem && publisher_elem.length > 0) {
      data.publisher = publisher_elem.text().trim();
    }

    const type_elem = $infoWrapper.find('.meta dl:nth-child(4) dd').first();
    if (type_elem && type_elem.length > 0) {
      data.album_type = type_elem.text().trim();
    }

    // 备选：从 .meta dl.list dt / dd 列表中按标签解析（覆盖或补全）
    let meta_items = $infoWrapper.find('.meta dl.list dt');
    if (!meta_items || meta_items.length === 0) {
      meta_items = $infoWrapper.find('.meta dl dt');
    }
    meta_items.each(function () {
      const $dt = $(this);
      const label = $dt.text().trim();
      const $dd = $dt.next('dd');
      const value = $dd.text().trim();

      switch (label) {
        case '발매일':
          if (value) data.release_date = value;
          break;
        case '장르':
          if (value) data.genres = value.split(',').map(g => g.trim()).filter(Boolean);
          break;
        case '발매사':
          if (value) data.publisher = value;
          break;
        case '기획사':
          if (value) data.planning = value;
          break;
        case '유형':
          if (value) data.album_type = value;
          break;
      }
    });

    // 海报（合并一次处理）
    const posterElem = $info.find('.thumb img').first();
    if (posterElem && posterElem.length) {
      const src = posterElem.attr('src') || posterElem.attr('data-src') || '';
      const poster = normalizePoster(src);
      if (poster) data.poster = poster;
    }

    // 专辑描述
    const albumInfo = $('.dtl_albuminfo').first();
    if (albumInfo && albumInfo.length) {
      const raw = albumInfo.html() || "";
      data.description = raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
    }

    // 曲目列表（多种选择器备选）
    let rows = $('#frm .tbl_song_list tbody tr');
    if (!rows || rows.length === 0) rows = $('.tbl_song_list tbody tr');
    if (!rows || rows.length === 0) rows = $('table:has(caption:contains("곡 리스트")) tbody tr');

    if (rows && rows.length) {
      const tracks = [];
      rows.each(function () {
        const $row = $(this);
        // 号码/排名
        const number = safeText($row.find('.rank')).replace(/\D+/g, '') || safeText($row.find('.no'));
        // 标题：优先可点击标题或 title 属性解析
        let t = '';
        const aPlay = $row.find('a[title*="재생"]').first();
        if (aPlay && aPlay.length) t = safeText(aPlay);
        if (!t) {
          const aInfo = $row.find('a[title*="곡정보"]').first();
          if (aInfo && aInfo.length) {
            const titleAttr = aInfo.attr('title') || '';
            const m = titleAttr.match(/^(.*?)\s+(재생|곡정보)/);
            if (m && m[1]) t = m[1].trim();
            else {
              const candidate = aInfo.closest('.ellipsis').find('a').first();
              t = safeText(candidate);
            }
          }
        }
        if (!t) {
          // 兜底：查找 .ellipsis 或 .song_name 文本
          t = safeText($row.find('.ellipsis a').first()) || safeText($row.find('.song_name').first());
        }
        if (!t) return; // 跳过无标题行

        // 艺术家（去重）
        const artLinks = $row.find('a[href*="goArtistDetail"]');
        const trackArtists = [];
        artLinks.each(function () {
          const n = $(this).text().trim();
          if (n && !trackArtists.includes(n)) trackArtists.push(n);
        });

        tracks.push({ number: number || '', title: t, artists: trackArtists });
      });

      if (tracks.length) data.tracks = tracks;
    }

    // 生成格式化描述
    let descr = '';
    if (data.poster) descr += `[img]${data.poster}[/img]\n\n`;
    descr += `❁ 专辑名称: ${data.title || 'N/A'}\n`;
    descr += `❁ 歌　　手: ${data.artists && data.artists.length ? data.artists.join(' / ') : 'N/A'}\n`;
    descr += `❁ 发行日期: ${data.release_date || 'N/A'}\n`;
    descr += `❁ 类　　型: ${data.genres && data.genres.length ? data.genres.join(' / ') : (data.album_type || 'N/A')}\n`;
    descr += `❁ 发 行 商: ${data.publisher || 'N/A'}\n`;
    descr += `❁ 制作公司: ${data.planning || 'N/A'}\n`;
    descr += `❁ 专辑链接: ${data.melon_link}\n`;

    if (data.description) descr += `\n❁ 专辑介绍\n  ${data.description.replace(/\n/g, '\n  ')}\n`;
    if (data.tracks && data.tracks.length) {
      descr += `\n❁ 歌曲列表\n`;
      data.tracks.forEach(t => {
        const artists = t.artists && t.artists.length ? ` (${t.artists.join(', ')})` : '';
        descr += `  ${t.number || '-'}. ${t.title}${artists}\n`;
      });
    }

    data.format = descr.trim();
    data.success = true;

    return data;
  } catch (err) {
    console.error("Melon 专辑处理错误:", err);
    return Object.assign(data, { error: `Melon 专辑处理错误: ${err && err.message ? err.message : String(err)}` });
  }
}