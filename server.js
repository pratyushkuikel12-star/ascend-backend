const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const path = require('path');

// ✅ Proper fetch import for CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// ✅ Serve static files (your HTML, CSS, JS) from "public" folder
app.use(express.static(path.join(__dirname, '..', 'seo-demo-site')));

// Default route → serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'seo-demo-site', 'index.html'));
});

// Normalize input (add https:// if missing)
const normalizeUrl = (input) => {
  let url = input.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
};

// Fetch HTML with timeout
const fetchText = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'AscendSEO/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });
    const text = await res.text();
    clearTimeout(timeout);
    return { status: res.status, text };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
};

// Robots.txt
const getRobotsTxt = async (base) => {
  try {
    const robotsUrl = new URL('/robots.txt', base).href;
    const res = await fetch(robotsUrl);
    if (!res.ok) return { ok: false, content: null };
    const content = await res.text();
    return { ok: true, content };
  } catch {
    return { ok: false, content: null };
  }
};

// Sitemap
const getSitemap = async (base) => {
  const candidates = ['/sitemap.xml', '/sitemap_index.xml'];
  for (const path of candidates) {
    try {
      const url = new URL(path, base).href;
      const res = await fetch(url);
      if (res.ok) {
        const xml = await res.text();
        return { ok: true, url, xml };
      }
    } catch {}
  }
  return { ok: false, url: null, xml: null };
};

// Extractors (meta, headings, images, links, etc.)
const extractMeta = ($) => ({
  title: $('title').first().text().trim() || '',
  description: $('meta[name="description"]').attr('content')?.trim() || '',
  keywords: $('meta[name="keywords"]').attr('content')?.trim() || '',
  canonical: $('link[rel="canonical"]').attr('href') || '',
  robots: $('meta[name="robots"]').attr('content')?.trim() || '',
});

const extractHeadings = ($) => ({
  h1: $('h1').map((_, el) => $(el).text().trim()).get(),
  h2: $('h2').map((_, el) => $(el).text().trim()).get(),
  h3: $('h3').map((_, el) => $(el).text().trim()).get(),
});

const extractImages = ($) => {
  const images = [];
  $('img').each((_, el) => {
    images.push({
      src: $(el).attr('src') || '',
      alt: $(el).attr('alt') || '',
    });
  });
  return images;
};

const extractLinks = ($) => {
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('javascript:')) links.push(href);
  });
  return links;
};

const extractLdJson = ($) => {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html();
    try {
      const json = JSON.parse(raw);
      blocks.push(json);
    } catch {
      blocks.push({ parseError: true, raw });
    }
  });
  return blocks;
};

const extractPerformanceHints = ($, html) => {
  const hasViewport = $('meta[name="viewport"]').length > 0;
  const hasPreload = $('link[rel="preload"]').length > 0;
  const hasPreconnect = $('link[rel="preconnect"]').length > 0;
  const inlineCssBytes = (html.match(/<style[^>]*>[\s\S]*?<\/style>/g) || [])
    .reduce((sum, block) => sum + block.length, 0);
  const inlineJsBytes = (html.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [])
    .reduce((sum, block) => sum + block.length, 0);
  return { hasViewport, hasPreload, hasPreconnect, inlineCssBytes, inlineJsBytes };
};

const extractIndexability = ($) => {
  const robotsMeta = $('meta[name="robots"]').attr('content') || '';
  const noindex = /noindex/i.test(robotsMeta);
  const nofollow = /nofollow/i.test(robotsMeta);
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  return { robotsMeta, noindex, nofollow, canonical };
};

const extractSecurity = ($) => {
  const hasHttpsLinks = $('a[href^="https://"]').length;
  const hasHttpLinks = $('a[href^="http://"]').length;
  const mixedContentRisk = hasHttpLinks > 0;
  return { hasHttpsLinks, hasHttpLinks, mixedContentRisk };
};

// Main audit route
app.post('/api/audit', async (req, res) => {
  try {
    const input = req.body.url || '';
    const target = normalizeUrl(input);

    const { status, text } = await fetchText(target);
    const $ = cheerio.load(text);

    // On-page
    const meta = extractMeta($);
    const headings = extractHeadings($);
    const images = extractImages($);
    const links = extractLinks($);
    const ldjson = extractLdJson($);

    // Technical
    const perf = extractPerformanceHints($, text);
    const indexability = extractIndexability($);
    const security = extractSecurity($);

    // Discoverability
    const robots = await getRobotsTxt(target);
    const sitemap = await getSitemap(target);

    // Simple scores
    const score = {
      onPage: Math.min(100,
        (meta.title ? 30 : 0) +
        (meta.description ? 30 : 0) +
        (headings.h1.length ? 20 : 0) +
        (ldjson.length ? 20 : 0)
      ),
      technical: Math.min(100,
        (perf.hasViewport ? 30 : 0) +
        (!indexability.noindex ? 40 : 0) +
        (!security.mixedContentRisk ? 30 : 0)
      ),
      discoverability: Math.min(100,
        (robots.ok ? 40 : 0) +
        (sitemap.ok ? 60 : 0)
      ),
    };

    res.json({
      url: target,
      httpStatus: status,
      meta,
      headings,
      images: {
        total: images.length,
        missingAlt: images.filter(i => !i.alt).length,
        samples: images.slice(0, 5),
      },
      links: {
        total: links.length,
        samples: links.slice(0, 5),
      },
      schema: {
        count: ldjson.length,
        types: ldjson.map(b => (b['@type'] || b['@context'] || 'Unknown')).slice(0, 5),
      },
      performanceHints: perf,
      indexability,
      security,
      crawlability: {
        robotsTxt: { available: robots.ok, sample: robots.content?.slice(0, 300) || null },
        sitemap: { available: sitemap.ok, url: sitemap.url || null },
      },
      score,
      message: `Audit completed for ${target}`,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to audit site', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Ascend audit backend running on http://localhost:${PORT}`);
});
