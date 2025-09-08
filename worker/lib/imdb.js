import { NONE_EXIST_ERROR, page_parser } from "./common.js";

const DEFAULT_TIMEOUT = 10000;
const TITLE_REGEX = /<title[^>]*>([^<]+)<\/title>/;
const JSONLD_SELECTOR = 'script[type="application/ld+json"]';
const NEXT_DATA_SELECTOR = 'script#__NEXT_DATA__';

const HOURS_REGEX = /(\d+)H/;
const MINUTES_REGEX = /(\d+)M/;
const NEWLINE_CLEAN_RE = /[\r\n]/g;

function getHeaders(env) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Cache-Control': 'max-age=0',
    'Priority': 'u=0, i'
  };
}

function convertDuration(duration) {
  if (!duration || typeof duration !== 'string') return '';
  const hoursMatch = duration.match(HOURS_REGEX);
  const minutesMatch = duration.match(MINUTES_REGEX);
  const hours = hoursMatch ? parseInt(hoursMatch[1]) : 0;
  const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
  if (hours > 0 && minutes > 0) return `${hours}H ${minutes}Min`;
  if (hours > 0) return `${hours}H`;
  if (minutes > 0) return `${minutes}Min`;
  return '';
}

async function fetchWithTimeout(url, opts = {}, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function safeTrim(s) {
  return s == null ? '' : String(s).trim();
}

function pickFirstString(val) {
  if (Array.isArray(val)) return val[0] ?? '';
  if (typeof val === 'string') return val;
  return '';
}

export async function gen_imdb(sid, env) {
  const data = { site: "imdb", sid: sid };
  try {
    if (!sid) return Object.assign(data, { error: "Invalid IMDB id" });

    // normalize sid to ttNNNNNNN format
    let raw = String(sid).trim();
    if (raw.startsWith('tt')) raw = raw.slice(2);
    const imdb_id = 'tt' + raw.padStart(7, '0');
    const imdb_url = `https://www.imdb.com/title/${imdb_id}/`;
    console.log("IMDb request URL:", imdb_url);

    let pageResp;
    try {
      pageResp = await fetchWithTimeout(imdb_url, { headers: getHeaders(env) }, DEFAULT_TIMEOUT);
    } catch (err) {
      console.error("IMDb fetch error:", err);
      return Object.assign(data, {
        error: "Failed to fetch IMDb page. This may be due to network issues or Cloudflare protection."
      });
    }

    // 处理 204（No Content）或被动拦截的情况：尝试回退策略（移动端页面、suggestion JSON）
    if (pageResp && pageResp.status === 204) {
      console.warn("IMDb returned 204 for", imdb_url, "- trying fallbacks");

      // 1) 尝试移动端页面
      try {
        const mobileUrl = `https://m.imdb.com/title/${imdb_id}/`;
        const mobileResp = await fetchWithTimeout(mobileUrl, { headers: getHeaders(env) }, DEFAULT_TIMEOUT);
        if (mobileResp && mobileResp.ok) {
          const mobileHtml = await mobileResp.text();
          console.log("Fetched mobile IMDb page length:", mobileHtml.length);
          pageResp = { ok: true, status: 200, text: async () => mobileHtml };
        } else {
          console.warn("Mobile page fallback failed, status:", mobileResp ? mobileResp.status : 'no response');
        }
      } catch (e) {
        console.warn("Mobile fallback error:", e);
      }

      // 2) 如果移动端没拿到，再尝试 IMDb suggestion JSON（可基于 id 首字母或 id）
      if (pageResp && pageResp.status === 204) {
        try {
          // suggestion endpoint expects a first-letter path segment; use imdb_id[2] (first char after 'tt')
          const firstLetter = imdb_id[2] ? imdb_id[2].toLowerCase() : 't';
          const suggestionUrl = `https://v2.sg.media-imdb.com/suggestion/${firstLetter}/${encodeURIComponent(imdb_id)}.json`;
          const sugResp = await fetchWithTimeout(suggestionUrl, { headers: { 'Accept': 'application/json' } }, 5000);
          if (sugResp && sugResp.ok) {
            const sugJson = await sugResp.json().catch(() => null);
            if (sugJson && Array.isArray(sugJson.d) && sugJson.d.length > 0) {
              const first = sugJson.d[0];
              if (!data.name) data.name = first.l || '';
              if (!data.poster && first.i && first.i[0]) data.poster = first.i[0];
              if (!data.imdb_link && first.id) data.imdb_link = `https://www.imdb.com/title/${first.id}/`;
              console.log("Suggestion fallback succeeded for", imdb_id);
              data.format = `${data.name}\n${data.imdb_link}`.trim();
              data.success = true;
              return data;
            }
          } else {
            console.warn("Suggestion fallback failed, status:", sugResp ? sugResp.status : 'no response');
          }
        } catch (e) {
          console.warn("Suggestion fallback error:", e);
        }
      }
    }

    if (!pageResp || !pageResp.ok) {
      const status = pageResp ? pageResp.status : 'no response';
      if (pageResp && pageResp.status === 404) return Object.assign(data, { error: NONE_EXIST_ERROR });
      return Object.assign(data, {
        error: `IMDb page request failed with status ${status}. This may be due to Cloudflare protection.`
      });
    }

    const html = await pageResp.text();
    console.log("IMDb page length:", html.length);
    console.log("Page title:", (html.match(TITLE_REGEX) || [])[1] || "No title found");

    // parse DOM
    const $ = page_parser(html);

    // Helper to safely parse JSON candidate text
    const tryParseJson = text => {
      if (!text) return null;
      const cleaned = text.replace(NEWLINE_CLEAN_RE, '').trim();
      try {
        return JSON.parse(cleaned);
      } catch {
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          try {
            return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
          } catch (_) { return null; }
        }
        return null;
      }
    };

    // 1) parse ld+json
    let page_json = {};
    try {
      const scripts = $(JSONLD_SELECTOR);
      if (scripts.length > 0) {
        let jsonText = scripts.first().html();
        const parsed = tryParseJson(jsonText);
        if (parsed && typeof parsed === 'object') page_json = parsed;
      }
    } catch (e) {
      console.warn("Error parsing ld+json:", e);
    }

    // base fields
    data.imdb_id = imdb_id;
    data.imdb_link = imdb_url;

    // copy simple fields from page_json if present
    const copyItems = ["@type", "name", "genre", "contentRating", "datePublished", "description", "duration", "image"];
    for (const key of copyItems) {
      if (key in page_json) data[key] = page_json[key];
    }
    if (data.image && !data.poster) data.poster = pickFirstString(data.image);

    if (data.datePublished) data.year = String(data.datePublished).slice(0, 4);

    // persons: actor, director, creator
    const personItems = ["actor", "director", "creator"];
    for (const p of personItems) {
      if (!(p in page_json)) continue;
      let rawPersons = page_json[p];
      if (!Array.isArray(rawPersons)) rawPersons = [rawPersons];
      const persons = rawPersons
        .filter(d => d && d["@type"] === "Person")
        .map(d => {
          const copy = { ...d };
          delete copy["@type"];
          copy.name = copy.name || copy['@name'] || copy.name || '';
          let character = '';
          if (copy.role && typeof copy.role === 'object') {
            character = copy.role.characterName || copy.role.name || copy.role.role || '';
          } else if (typeof copy.role === 'string') {
            character = copy.role;
          }
          if (!character && copy.roleName) character = copy.roleName;
          if (!character && copy.character) character = copy.character;
          if (!character && copy['@role']) character = copy['@role'];
          copy.character = (character || '').toString();
          return copy;
        });
      if (persons.length) data[p + "s"] = persons;
    }

    // fallback: if actors not found in JSON-LD, try extracting from HTML cast lists
    if (!Array.isArray(data.actors) || data.actors.length === 0) {
      try {
        const cast = [];
        const tableRows = $('.cast_list tr');
        if (tableRows.length > 0) {
          tableRows.each(function () {
            const cols = $(this).find('td');
            if (cols.length < 2) return;
            const name = cols.eq(1).find('a').text().trim() || cols.eq(1).text().trim();
            let character = '';
            const charCell = $(this).find('td.character').first();
            if (charCell && charCell.length) character = charCell.text().trim();
            else if (cols.length >= 4) character = cols.eq(3).text().trim();
            if (name) cast.push({ name, character: character || '' });
          });
        } else {
          const castItems = $('[data-testid="title-cast-item"]');
          castItems.each(function () {
            const actorName = $(this).find('[data-testid="title-cast-item__actor"]').first().text().trim();
            const characterName = $(this).find('[data-testid="title-cast-item__characters"]').first().text().trim()
              || $(this).find('.CharacterName__CharacterNameText-sc-1s7j7a0-0').first().text().trim();
            if (actorName) cast.push({ name: actorName, character: characterName || '' });
          });
        }
        if (cast.length) data.actors = cast.slice(0, 15);
      } catch (e) {
        console.warn("HTML cast fallback failed:", e);
      }
    }

    // keywords
    if ("keywords" in page_json) {
      data.keywords = typeof page_json.keywords === 'string' ? page_json.keywords.split(",").map(s => s.trim()).filter(Boolean) : page_json.keywords;
    } else {
      data.keywords = [];
    }

    const aggregate_rating = page_json.aggregateRating || {};
    data.imdb_votes = aggregate_rating.ratingCount || 0;
    data.imdb_rating_average = aggregate_rating.ratingValue || 0;
    data.imdb_rating = `${data.imdb_rating_average}/10 from ${data.imdb_votes} users`;

    // 2) try parse __NEXT_DATA__
    let nextData = {};
    try {
      const nd = $(NEXT_DATA_SELECTOR);
      if (nd.length > 0) {
        const parsed = tryParseJson(nd.first().html());
        if (parsed) nextData = parsed;
      }
    } catch (e) {
      console.warn("Error parsing __NEXT_DATA__:", e);
    }

    // extract metrics from nextData if available
    try {
      if (nextData.props && nextData.props.urqlState) {
        for (const [, value] of Object.entries(nextData.props.urqlState)) {
          if (value && value.data && value.data.title && value.data.title.id === imdb_id) {
            const td = value.data.title;
            if (td.metacritic?.metascore?.score) data.metascore = td.metacritic.metascore.score;
            if (td.reviews?.total) data.reviews = td.reviews.total;
            if (td.criticReviewsTotal?.total) data.critic = td.criticReviewsTotal.total;
            if (td.meterRanking?.currentRank) data.popularity = td.meterRanking.currentRank;
          }
        }
      }
    } catch (e) {
      console.warn("Error extracting metrics from nextData:", e);
    }

    // 3) Details section scraping
    try {
      const detailsSection = $("section[cel_widget_id='StaticFeature_Details']");
      const details = {};
      if (detailsSection.length > 0) {
        detailsSection.find("li.ipc-metadata-list__item").each(function () {
          const label = $(this).find(".ipc-metadata-list-item__label").first().text().trim();
          if (!label) return;
          const values = [];
          $(this).find(".ipc-metadata-list-item__list-content-item").each(function () {
            const el = $(this);
            if (el.attr("href") && el.attr("href").startsWith("http")) {
              values.push(`${el.text().trim()} - ${el.attr("href")}`);
            } else {
              values.push(el.text().trim());
            }
          });
          if (values.length) details[label] = values;
        });
      }
      data.details = details;
    } catch (e) {
      console.warn("Error scraping details:", e);
      data.details = {};
    }

    // 4) releaseinfo (external page)
    try {
      const releaseResp = await fetchWithTimeout(`${imdb_url}releaseinfo`, { headers: getHeaders(env) }, DEFAULT_TIMEOUT);
      if (releaseResp && releaseResp.ok) {
        const releaseHtml = await releaseResp.text();
        const $rel = page_parser(releaseHtml);
        const releaseItems = $rel("tr.release-date-item");
        const releases = [];
        releaseItems.each(function () {
          const that = $rel(this);
          const country = that.find("td.release-date-item__country-name").first().text().trim();
          const date = that.find("td.release-date-item__date").first().text().trim();
          if (country && date) releases.push({ country, date });
        });
        data.release_date = releases;

        const akaItems = $rel("tr.aka-item");
        const akas = [];
        akaItems.each(function () {
          const that = $rel(this);
          const country = that.find("td.aka-item__name").first().text().trim();
          const title = that.find("td.aka-item__title").first().text().trim();
          if (country && title) akas.push({ country, title });
        });
        data.aka = akas;
      } else {
        data.release_date = [];
        data.aka = [];
      }
    } catch (e) {
      console.warn("Error fetching releaseinfo:", e);
      data.release_date = data.release_date || [];
      data.aka = data.aka || [];
    }

    // Build formatted description (format)
    let descr = "";
    if (data.poster) descr += `[img]${data.poster}[/img]\n\n`;
    if (data.name) descr += `❁ Title: ${data.name}\n`;
    if (data["@type"]) descr += `❁ Type: ${data["@type"]}\n`;
    if (data.keywords && data.keywords.length) descr += `❁ Keywords: ${data.keywords.join(", ")}\n`;
    if (data.datePublished) descr += `❁ Date Published: ${data.datePublished}\n`;
    if (data.imdb_rating) descr += `❁ IMDb Rating: ${data.imdb_rating}\n`;
    if (data.imdb_link) descr += `❁ IMDb Link: ${data.imdb_link}\n`;
    if (data.duration) {
      const dur = convertDuration(data.duration);
      if (dur) descr += `❁ Duration: ${dur}\n`;
    }
    if (data.directors && data.directors.length) descr += `❁ Directors: ${data.directors.map(i => i.name).join(" / ")}\n`;
    if (data.creators && data.creators.length) descr += `❁ Creators: ${data.creators.map(i => i.name).join(" / ")}\n`;

    // Actors - if actors available show names; try to include roles if present
    if (data.actors && data.actors.length) {
      descr += `❁ Actors: ${data.actors.map(a => {
        const role = a.character || a.role || a['@role'] || '';
        return role ? `${a.name} as ${role}` : `${a.name}`;
      }).join(" / ")}\n`;
    }

    if (data.description) {
      descr += `\n❁ Introduction\n    ${String(data.description).replace(/\n/g, "\n" + "　".repeat(2))}\n`;
    }

    data.format = descr.trim();
    data.success = true;
    console.log("IMDb data successfully generated");
    return data;
  } catch (error) {
    console.error("IMDb processing error:", error);
    return Object.assign({ site: "imdb", sid }, {
      error: `IMDb processing error: ${error?.message || error}`
    });
  }
}