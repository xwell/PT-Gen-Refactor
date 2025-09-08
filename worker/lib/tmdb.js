import { NONE_EXIST_ERROR } from "./common.js";

const TMDB_API_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";
const DEFAULT_TIMEOUT = 10000; // ms

const fetchWithTimeout = async (url, opts = {}, timeout = DEFAULT_TIMEOUT) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } catch (error) {
    // 确保超时错误能够正确传递
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

const safe = (v, fallback = '') => (v === undefined || v === null ? fallback : v);

/**
 * 解析 sid，支持 "movie/123", "tv/123" 或直接数字（默认 movie）
 * 返回 { media_type, media_id } 或 null
 */
const parseSid = sid => {
  if (!sid) return null;
  const s = String(sid).trim();
  if (!s) return null;
  if (s.includes('/')) {
    const [type, id] = s.split('/').map(x => x.trim());
    if (!id) return null;
    return { media_type: type || 'movie', media_id: id };
  }
  // 仅数字或字符串id，默认 movie
  return { media_type: 'movie', media_id: s };
};

/**
 * 将 TMDb 返回的数据标准化并生成格式化描述
 */
const buildResult = (tmdb_data, media_type) => {
  const data = {};
  data.tmdb_id = tmdb_data.id;
  data.title = media_type === 'movie' ? safe(tmdb_data.title) : safe(tmdb_data.name);
  data.original_title = media_type === 'movie' ? safe(tmdb_data.original_title) : safe(tmdb_data.original_name);
  data.overview = safe(tmdb_data.overview, '');
  data.poster = tmdb_data.poster_path ? `${TMDB_IMAGE_BASE_URL}${tmdb_data.poster_path}` : '';
  data.backdrop = tmdb_data.backdrop_path ? `${TMDB_IMAGE_BASE_URL}${tmdb_data.backdrop_path}` : '';

  if (media_type === 'movie') {
    data.release_date = safe(tmdb_data.release_date, '');
    data.year = data.release_date ? data.release_date.slice(0, 4) : '';
    data.runtime = tmdb_data.runtime ? `${tmdb_data.runtime} minutes` : '';
  } else {
    data.first_air_date = safe(tmdb_data.first_air_date, '');
    data.last_air_date = safe(tmdb_data.last_air_date, '');
    data.year = data.first_air_date ? data.first_air_date.slice(0, 4) : '';
    data.episode_run_time = (tmdb_data.episode_run_time && tmdb_data.episode_run_time.length > 0) ?
      `${tmdb_data.episode_run_time[0]} minutes` : '';
    data.number_of_episodes = tmdb_data.number_of_episodes || '';
    data.number_of_seasons = tmdb_data.number_of_seasons || '';
  }

  data.tmdb_rating_average = safe(tmdb_data.vote_average, 0);
  data.tmdb_votes = safe(tmdb_data.vote_count, 0);
  data.tmdb_rating = `${data.tmdb_rating_average || 0}/10 from ${data.tmdb_votes || 0} users`;
  data.genres = Array.isArray(tmdb_data.genres) ? tmdb_data.genres.map(g => g.name) : [];
  data.languages = Array.isArray(tmdb_data.spoken_languages) ? tmdb_data.spoken_languages.map(l => l.english_name || l.name) : [];
  data.countries = Array.isArray(tmdb_data.production_countries) ? tmdb_data.production_countries.map(c => c.name) : [];
  data.production_companies = Array.isArray(tmdb_data.production_companies) ? tmdb_data.production_companies.map(c => c.name) : [];

  // credits
  data.directors = [];
  data.producers = [];
  data.cast = [];
  if (tmdb_data.credits) {
    if (Array.isArray(tmdb_data.credits.crew)) {
      tmdb_data.credits.crew.forEach(person => {
        if (person && person.job === 'Director') data.directors.push({ name: person.name, id: person.id });
        else if (person && person.job === 'Producer') data.producers.push({ name: person.name, id: person.id });
      });
    }
    if (Array.isArray(tmdb_data.credits.cast)) {
      data.cast = tmdb_data.credits.cast.map(actor => {
        const name = actor.name || actor.original_name || '';
        // 优先使用 actor.character；若为空则尝试 actor.roles 中的 character（TV 可能在 roles）
        let character = actor.character || '';
        if (!character && Array.isArray(actor.roles) && actor.roles.length > 0) {
          character = actor.roles.map(r => r.character).filter(Boolean).join(' / ');
        }
        // 兼容其他可能字段
        if (!character && (actor.role || actor.roles?.[0]?.role)) {
          character = actor.role || actor.roles[0].role;
        }
        return {
          name,
          character: character || '',
          id: actor.id || ''
        };
      }).slice(0, 15);
    }
  }

  // external ids
  data.imdb_id = tmdb_data.external_ids?.imdb_id || '';
  data.imdb_link = data.imdb_id ? `https://www.imdb.com/title/${data.imdb_id}/` : '';

  // 构建格式化文本
  const lines = [];
  if (data.poster) lines.push(`[img]${data.poster}[/img]`, '');
  lines.push(`❁ Title: ${data.title || 'N/A'}`);
  lines.push(`❁ Original Title: ${data.original_title || 'N/A'}`);
  lines.push(`❁ Genres: ${data.genres.length ? data.genres.join(' / ') : 'N/A'}`);
  lines.push(`❁ Languages: ${data.languages.length ? data.languages.join(' / ') : 'N/A'}`);
  if (media_type === 'movie') {
    lines.push(`❁ Release Date: ${data.release_date || 'N/A'}`);
    lines.push(`❁ Runtime: ${data.runtime || 'N/A'}`);
  } else {
    lines.push(`❁ First Air Date: ${data.first_air_date || 'N/A'}`);
    lines.push(`❁ Number of Episodes: ${data.number_of_episodes || 'N/A'}`);
    lines.push(`❁ Number of Seasons: ${data.number_of_seasons || 'N/A'}`);
    lines.push(`❁ Episode Runtime: ${data.episode_run_time || 'N/A'}`);
  }
  lines.push(`❁ Production Countries: ${data.countries.length ? data.countries.join(' / ') : 'N/A'}`);
  lines.push(`❁ Rating: ${data.tmdb_rating || 'N/A'}`);
  lines.push(`❁ TMDB Link: ${media_type === 'movie' ? `https://www.themoviedb.org/movie/${data.tmdb_id}/` : `https://www.themoviedb.org/tv/${data.tmdb_id}/`}`);
  if (data.imdb_link) lines.push(`❁ IMDb Link: ${data.imdb_link}`);
  if (data.directors.length) lines.push(`❁ Directors: ${data.directors.map(d => d.name).join(' / ')}`);
  if (data.producers.length) lines.push(`❁ Producers: ${data.producers.map(p => p.name).join(' / ')}`);
  if (data.cast.length) {
    lines.push('', '❁ Cast');
    // 如果没有 character 就只显示名字；有的话显示 "name as character"
    lines.push(...data.cast.map(a => `  ${a.name}${a.character ? ' as ' + a.character : ''}`));
  }
  if (data.overview) {
    lines.push('', '❁ Overview', `  ${data.overview.replace(/\n/g, '\n  ')}`);
  }

  lines.push('', '✿ 本内容由 PT-Gen 自动解析生成，请勿手动修改');

  data.format = lines.join('\n').trim();
  data.success = true;
  return data;
};

export async function gen_tmdb(sid, env) {
  const base = { site: "tmdb", sid };
  try {
    const TMDB_API_KEY = env?.TMDB_API_KEY;
    if (!TMDB_API_KEY) {
      return Object.assign(base, { error: "TMDB API key not configured" });
    }

    const parsed = parseSid(sid);
    if (!parsed) {
      return Object.assign(base, { error: "Invalid TMDB ID format. Expected 'movie/12345', 'tv/12345' or numeric ID" });
    }

    const { media_type, media_id } = parsed;
    if (!media_type || !media_id) {
      return Object.assign(base, { error: "Invalid TMDB ID format" });
    }

    const params = `api_key=${encodeURIComponent(TMDB_API_KEY)}&language=zh-CN&append_to_response=credits,release_dates,external_ids`;
    const url = `${TMDB_API_URL}/${encodeURIComponent(media_type)}/${encodeURIComponent(media_id)}?${params}`;
    console.log("TMDB request:", url);

    let resp;
    try {
      resp = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }, DEFAULT_TIMEOUT);
    } catch (fetch_error) {
      console.error("TMDB fetch error:", fetch_error);
      return Object.assign(base, {
        error: `TMDB API fetch error: ${fetch_error.name === 'AbortError' ? 'Request timeout' : fetch_error.message}`
      });
    }

    if (!resp.ok) {
      const status = resp.status;
      let text = '';
      try { text = await resp.text(); } catch (_) { /* ignore */ }
      console.warn("TMDB API non-ok response:", status, text && text.slice(0, 200));
      if (status === 404) return Object.assign(base, { error: NONE_EXIST_ERROR });
      if (status === 401) return Object.assign(base, { error: "TMDB API key invalid" });
      if (status === 429) return Object.assign(base, { error: "TMDB API rate limit exceeded" });
      return Object.assign(base, { error: `TMDB API request failed with status ${status}` });
    }

    let tmdb_data;
    try {
      tmdb_data = await resp.json();
    } catch (json_error) {
      console.error("TMDB JSON parse error:", json_error);
      return Object.assign(base, { error: "TMDB API response parsing failed" });
    }

    const result = buildResult(tmdb_data, media_type);
    console.log("TMDB data generated for:", result.title);
    return result;
  } catch (error) {
    console.error("TMDB processing error:", error);
    return Object.assign(base, { error: `TMDB API processing error: ${error?.message || error}` });
  }
}