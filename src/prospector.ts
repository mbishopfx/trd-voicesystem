import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { normalizePhone } from './phone.js';
import { runtimeError, runtimeInfo } from './runtimeLogs.js';
import { withState } from './store.js';
import type { Lead } from './types.js';
import { nowIso } from './utils.js';

export interface ProspectorRunInput {
  icp: string;
  city: string;
  state: string;
}

export interface ProspectorRun {
  id: string;
  icp: string;
  city: string;
  state: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  discovered: number;
  notes?: string;
}

interface PlaceCandidate {
  id?: string;
  name: string;
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  types?: string[];
  source: 'places_new' | 'places_legacy' | 'cse' | 'dataforseo';
  query?: string;
}

interface LeadIntel {
  qualityScore: number;
  opportunityScore: number;
  reason: string;
  angle: string;
  provider: 'xai' | 'gemini' | 'heuristic';
}

interface WebsiteProfile {
  title?: string;
  description?: string;
  snippet?: string;
  email?: string;
  phone?: string;
}

const NON_OWNED_HOST_MARKERS = [
  'facebook.com',
  'instagram.com',
  'yelp.com',
  'mapquest.com',
  'linkedin.com',
  'tiktok.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'thumbtack.com',
  'angi.com',
  'angi.',
  'yellowpages.com',
  'bbb.org'
];

const runs: ProspectorRun[] = [];

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function truncate(text: string, max = 300): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}…`;
}

function slug(value: string): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

function hostFromUrl(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeOwnedWebsite(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (NON_OWNED_HOST_MARKERS.some((marker) => host.includes(marker))) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function parseJsonObjectFromText(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return asObject(parsed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return asObject(parsed);
    } catch {
      return undefined;
    }
  }
}

function extractEmail(text: string): string | undefined {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : undefined;
}

function extractPhone(text: string): string | undefined {
  const matches = text.match(/\+?\d[\d().\s-]{7,}\d/g) || [];
  for (const value of matches) {
    const normalized = normalizePhone(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function buildSearchQueries(icp: string, city: string, state: string): string[] {
  const raw = [
    `${icp} in ${city} ${state}`,
    `${icp} ${city} ${state}`,
    `best ${icp} in ${city} ${state}`,
    `${city} ${state} ${icp} business`,
    `${icp} near ${city} ${state}`,
    `${icp} ${state}`
  ];
  return [...new Set(raw.map((value) => value.trim()).filter(Boolean))].slice(0, 8);
}

async function geocodeMarket(city: string, state: string): Promise<{ lat: number; lng: number } | undefined> {
  if (!config.googleApiKey) return undefined;
  try {
    const address = encodeURIComponent(`${city}, ${state}`);
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${address}&key=${encodeURIComponent(config.googleApiKey)}`
    );
    if (!res.ok) {
      runtimeInfo('agent', 'prospector geocode request failed', { city, state, status: res.status });
      return undefined;
    }
    const data = (await res.json()) as {
      status?: string;
      error_message?: string;
      results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
    };
    const loc = data.results?.[0]?.geometry?.location;
    runtimeInfo('agent', 'prospector geocode response', {
      city,
      state,
      status: data.status || 'unknown',
      results: data.results?.length || 0,
      error: data.error_message || ''
    });
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return undefined;
    return { lat: loc.lat, lng: loc.lng };
  } catch (error) {
    runtimeError('agent', 'prospector geocode failed', error, { city, state });
    return undefined;
  }
}

async function searchPlacesNew(queries: string[], location?: { lat: number; lng: number }): Promise<PlaceCandidate[]> {
  if (!config.googleApiKey) return [];
  const dedupe = new Map<string, PlaceCandidate>();

  for (const textQuery of queries) {
    const body: Record<string, unknown> = {
      textQuery,
      maxResultCount: 15
    };
    if (location) {
      body.locationBias = {
        circle: {
          center: { latitude: location.lat, longitude: location.lng },
          radius: 45000
        }
      };
    }

    try {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.googleApiKey,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.rating,places.userRatingCount,places.businessStatus,places.types'
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const preview = (await res.text()).slice(0, 240);
        runtimeInfo('agent', 'prospector places(new) request failed', { textQuery, status: res.status, preview });
        continue;
      }

      const data = (await res.json()) as {
        places?: Array<{
          id?: string;
          displayName?: { text?: string };
          formattedAddress?: string;
          nationalPhoneNumber?: string;
          websiteUri?: string;
          googleMapsUri?: string;
          rating?: number;
          userRatingCount?: number;
          businessStatus?: string;
          types?: string[];
        }>;
      };

      for (const place of data.places || []) {
        const candidate: PlaceCandidate = {
          id: asString(place.id),
          name: place.displayName?.text || 'Unknown Business',
          formattedAddress: asString(place.formattedAddress),
          nationalPhoneNumber: asString(place.nationalPhoneNumber),
          websiteUri: asString(place.websiteUri),
          googleMapsUri: asString(place.googleMapsUri),
          rating: asNumber(place.rating),
          userRatingCount: asNumber(place.userRatingCount),
          businessStatus: asString(place.businessStatus),
          types: Array.isArray(place.types) ? place.types.filter((v): v is string => typeof v === 'string') : undefined,
          source: 'places_new',
          query: textQuery
        };
        const key = candidate.id || `${candidate.name}|${candidate.formattedAddress || ''}`;
        if (!dedupe.has(key)) dedupe.set(key, candidate);
      }
    } catch (error) {
      runtimeError('agent', 'prospector places(new) request errored', error, { textQuery });
    }
  }

  return [...dedupe.values()];
}

async function legacyPlaceDetails(placeId: string): Promise<PlaceCandidate | undefined> {
  if (!config.googleApiKey) return undefined;
  try {
    const endpoint =
      'https://maps.googleapis.com/maps/api/place/details/json' +
      `?place_id=${encodeURIComponent(placeId)}` +
      '&fields=place_id,name,formatted_address,formatted_phone_number,website,url,rating,user_ratings_total,business_status,types' +
      `&key=${encodeURIComponent(config.googleApiKey)}`;
    const res = await fetch(endpoint);
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      status?: string;
      result?: Record<string, unknown>;
    };
    const row = asObject(data.result);
    if (!row || data.status !== 'OK') return undefined;
    return {
      id: asString(row.place_id),
      name: asString(row.name) || 'Unknown Business',
      formattedAddress: asString(row.formatted_address),
      nationalPhoneNumber: asString(row.formatted_phone_number),
      websiteUri: asString(row.website),
      googleMapsUri: asString(row.url),
      rating: asNumber(row.rating),
      userRatingCount: asNumber(row.user_ratings_total),
      businessStatus: asString(row.business_status),
      types: Array.isArray(row.types) ? row.types.filter((v): v is string => typeof v === 'string') : undefined,
      source: 'places_legacy'
    };
  } catch {
    return undefined;
  }
}

async function searchPlacesLegacy(queries: string[], location?: { lat: number; lng: number }): Promise<PlaceCandidate[]> {
  if (!config.googleApiKey) return [];
  const dedupe = new Map<string, PlaceCandidate>();

  for (const textQuery of queries) {
    try {
      const endpoint =
        'https://maps.googleapis.com/maps/api/place/textsearch/json' +
        `?query=${encodeURIComponent(textQuery)}` +
        (location ? `&location=${location.lat},${location.lng}&radius=45000` : '') +
        `&key=${encodeURIComponent(config.googleApiKey)}`;

      const res = await fetch(endpoint);
      if (!res.ok) {
        runtimeInfo('agent', 'prospector places(legacy) request failed', { textQuery, status: res.status });
        continue;
      }

      const data = (await res.json()) as {
        status?: string;
        error_message?: string;
        results?: Array<Record<string, unknown>>;
      };
      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        runtimeInfo('agent', 'prospector places(legacy) non-ok', {
          textQuery,
          status: data.status || 'unknown',
          error: data.error_message || ''
        });
      }

      for (const result of data.results || []) {
        const row = asObject(result) || {};
        const placeId = asString(row.place_id);
        const detail = placeId ? await legacyPlaceDetails(placeId) : undefined;
        const candidate: PlaceCandidate = {
          id: detail?.id || placeId,
          name: detail?.name || asString(row.name) || 'Unknown Business',
          formattedAddress: detail?.formattedAddress || asString(row.formatted_address),
          nationalPhoneNumber: detail?.nationalPhoneNumber,
          websiteUri: detail?.websiteUri,
          googleMapsUri: detail?.googleMapsUri,
          rating: detail?.rating || asNumber(row.rating),
          userRatingCount: detail?.userRatingCount || asNumber(row.user_ratings_total),
          businessStatus: detail?.businessStatus || asString(row.business_status),
          types:
            detail?.types ||
            (Array.isArray(row.types) ? row.types.filter((v): v is string => typeof v === 'string') : undefined),
          source: 'places_legacy',
          query: textQuery
        };
        const key = candidate.id || `${candidate.name}|${candidate.formattedAddress || ''}`;
        if (!dedupe.has(key)) dedupe.set(key, candidate);
      }
    } catch (error) {
      runtimeError('agent', 'prospector places(legacy) errored', error, { textQuery });
    }
  }

  return [...dedupe.values()];
}

async function searchCseCandidates(queries: string[]): Promise<PlaceCandidate[]> {
  if (!config.googleApiKey || !config.googleCseId) return [];
  const dedupe = new Map<string, PlaceCandidate>();

  for (const query of queries) {
    try {
      const endpoint =
        'https://www.googleapis.com/customsearch/v1' +
        `?key=${encodeURIComponent(config.googleApiKey)}` +
        `&cx=${encodeURIComponent(config.googleCseId)}` +
        `&q=${encodeURIComponent(query)}` +
        '&num=10';
      const res = await fetch(endpoint);
      if (!res.ok) {
        runtimeInfo('agent', 'prospector cse(list) request failed', { query, status: res.status });
        continue;
      }
      const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
      for (const item of data.items || []) {
        const link = normalizeOwnedWebsite(asString(item.link));
        if (!link) continue;
        const title = asString(item.title) || '';
        const name = title.split(/[-|:]/)[0]?.trim() || hostFromUrl(link) || 'Unknown Business';
        const key = hostFromUrl(link) || `${name}|${link}`;
        if (dedupe.has(key)) continue;
        dedupe.set(key, {
          name,
          websiteUri: link,
          source: 'cse',
          query
        });
      }
    } catch (error) {
      runtimeError('agent', 'prospector cse(list) errored', error, { query });
    }
  }

  return [...dedupe.values()];
}

async function searchDataForSeoCandidates(icp: string, city: string, state: string): Promise<PlaceCandidate[]> {
  if (!config.dataForSeoLogin || !config.dataForSeoPassword) return [];
  const dedupe = new Map<string, PlaceCandidate>();
  const queries = buildSearchQueries(icp, city, state).slice(0, 4);
  const tasks = queries.map((keyword) => ({
    keyword,
    location_name: `${city}, ${state}, United States`,
    language_name: 'English'
  }));

  try {
    const auth = Buffer.from(`${config.dataForSeoLogin}:${config.dataForSeoPassword}`).toString('base64');
    const res = await fetch('https://api.dataforseo.com/v3/serp/google/maps/live/advanced', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(tasks)
    });
    if (!res.ok) {
      runtimeInfo('agent', 'prospector dataforseo request failed', { status: res.status });
      return [];
    }

    const payload = (await res.json()) as Record<string, unknown>;
    const taskRows = asArray(payload.tasks).map((row) => asObject(row)).filter((row): row is Record<string, unknown> => Boolean(row));
    for (const task of taskRows) {
      const results = asArray(task.result).map((row) => asObject(row)).filter((row): row is Record<string, unknown> => Boolean(row));
      for (const result of results) {
        const items = asArray(result.items).map((row) => asObject(row)).filter((row): row is Record<string, unknown> => Boolean(row));
        for (const item of items) {
          const title = asString(item.title) || asString(item.name);
          if (!title) continue;
          const domain = asString(item.domain);
          const website = normalizeOwnedWebsite(domain ? `https://${domain.replace(/^https?:\/\//i, '')}` : asString(item.url));
          const ratingNode = asObject(item.rating);
          const rating = asNumber(item.rating) || asNumber(ratingNode?.value);
          const reviewCount = asNumber(item.reviews) || asNumber(item.reviews_count) || asNumber(ratingNode?.votes_count);
          const category = asString(item.category);

          const candidate: PlaceCandidate = {
            id: asString(item.place_id) || asString(item.cid),
            name: title,
            formattedAddress: asString(item.address),
            nationalPhoneNumber: asString(item.phone),
            websiteUri: website,
            googleMapsUri: asString(item.url),
            rating,
            userRatingCount: reviewCount,
            businessStatus: asString(item.business_status),
            types: category ? [category] : undefined,
            source: 'dataforseo'
          };
          const key = candidate.id || `${candidate.name}|${candidate.formattedAddress || ''}|${hostFromUrl(candidate.websiteUri)}`;
          if (!dedupe.has(key)) dedupe.set(key, candidate);
        }
      }
    }
  } catch (error) {
    runtimeError('agent', 'prospector dataforseo errored', error, { icp, city, state });
  }

  return [...dedupe.values()];
}

async function apolloOrganizationByDomain(
  domain: string
): Promise<{ description?: string; phone?: string; industry?: string; employeeCount?: number } | undefined> {
  if (!config.apolloApiKey || !domain) return undefined;

  const cleanDomain = domain.replace(/^www\./, '').toLowerCase();
  const parseOrg = (obj: Record<string, unknown>): { description?: string; phone?: string; industry?: string; employeeCount?: number } => {
    const primaryPhoneNode = asObject(obj.primary_phone);
    return {
      description: asString(obj.short_description) || asString(obj.description),
      phone: asString(primaryPhoneNode?.number) || asString(obj.phone),
      industry: asString(obj.industry),
      employeeCount: asNumber(obj.estimated_num_employees)
    };
  };

  try {
    const enrichRes = await fetch(
      `https://api.apollo.io/api/v1/organizations/enrich?domain=${encodeURIComponent(cleanDomain)}`,
      {
        method: 'GET',
        headers: {
          'x-api-key': config.apolloApiKey,
          Accept: 'application/json'
        }
      }
    );
    if (enrichRes.ok) {
      const payload = (await enrichRes.json()) as Record<string, unknown>;
      const organization = asObject(payload.organization) || asObject(payload);
      if (organization) return parseOrg(organization);
    }
  } catch (error) {
    runtimeError('agent', 'prospector apollo enrich errored', error, { domain: cleanDomain });
  }

  try {
    const searchRes = await fetch('https://api.apollo.io/api/v1/organizations/search', {
      method: 'POST',
      headers: {
        'x-api-key': config.apolloApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        q_organization_domains: [cleanDomain],
        page: 1,
        per_page: 1
      })
    });
    if (!searchRes.ok) return undefined;
    const payload = (await searchRes.json()) as Record<string, unknown>;
    const organizations = asArray(payload.organizations).map((row) => asObject(row)).filter((row): row is Record<string, unknown> => Boolean(row));
    if (organizations[0]) return parseOrg(organizations[0]);
    return undefined;
  } catch (error) {
    runtimeError('agent', 'prospector apollo search errored', error, { domain: cleanDomain });
    return undefined;
  }
}

async function cseLikelyWebsite(
  name: string,
  city: string,
  state: string
): Promise<{ website?: string; snippet?: string } | undefined> {
  if (!config.googleApiKey || !config.googleCseId) return undefined;
  try {
    const q = encodeURIComponent(`${name} ${city} ${state}`);
    const endpoint =
      'https://www.googleapis.com/customsearch/v1' +
      `?key=${encodeURIComponent(config.googleApiKey)}` +
      `&cx=${encodeURIComponent(config.googleCseId)}` +
      `&q=${q}&num=5`;
    const res = await fetch(endpoint);
    if (!res.ok) {
      runtimeInfo('agent', 'prospector cse lookup failed', { name, city, state, status: res.status });
      return undefined;
    }
    const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
    for (const item of data.items || []) {
      const website = normalizeOwnedWebsite(asString(item.link));
      if (!website) continue;
      return { website, snippet: asString(item.snippet) };
    }
    return undefined;
  } catch (error) {
    runtimeError('agent', 'prospector cse lookup errored', error, { name, city, state });
    return undefined;
  }
}

async function scrapeWebsiteProfile(url: string): Promise<WebsiteProfile | undefined> {
  if (!config.firecrawlApiKey) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.firecrawlTimeoutMs);
  try {
    const endpoint = `${config.firecrawlBaseUrl.replace(/\/$/, '')}/v1/scrape`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.firecrawlApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      runtimeInfo('agent', 'prospector firecrawl request failed', { url, status: res.status });
      return undefined;
    }
    const payload = (await res.json()) as Record<string, unknown>;
    const data = asObject(payload.data) || payload;
    const metadata = asObject(data.metadata);
    const title = asString(metadata?.title) || asString(data.title);
    const description = asString(metadata?.description) || asString(data.description);
    const markdown = asString(data.markdown) || asString(data.content) || asString(data.text) || '';
    const combined = [title || '', description || '', markdown].join('\n');
    return {
      title,
      description,
      snippet: truncate(markdown || description || '', 260),
      email: extractEmail(combined),
      phone: extractPhone(combined)
    };
  } catch (error) {
    runtimeError('agent', 'prospector firecrawl errored', error, { url });
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function xaiLeadIntel(input: {
  icp: string;
  city: string;
  state: string;
  place: PlaceCandidate;
  websiteStatus: string;
  websiteProfile?: WebsiteProfile;
}): Promise<LeadIntel | undefined> {
  if (!config.xaiApiKey) return undefined;
  try {
    const endpoint = `${config.xaiBaseUrl.replace(/\/$/, '')}/chat/completions`;
    const prompt = JSON.stringify(
      {
        icp: input.icp,
        market: `${input.city}, ${input.state}`,
        business: input.place.name,
        address: input.place.formattedAddress || '',
        websiteStatus: input.websiteStatus,
        website: input.place.websiteUri || '',
        rating: input.place.rating,
        reviewCount: input.place.userRatingCount,
        businessStatus: input.place.businessStatus || '',
        categories: input.place.types || [],
        websiteTitle: input.websiteProfile?.title || '',
        websiteDescription: input.websiteProfile?.description || ''
      },
      null,
      2
    );
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.xaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.xaiModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You score local business lead quality and opportunity for AI/Google authority campaigns. Return JSON only with keys: qualityScore (0-100), opportunityScore (0-100), reason (string), angle (string).'
          },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!res.ok) {
      runtimeInfo('agent', 'prospector xai score failed', { status: res.status });
      return undefined;
    }
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    const raw =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
        ? content.map((part) => (asObject(part) ? asString(asObject(part)?.text) || '' : '')).join('\n')
        : '';
    const parsed = parseJsonObjectFromText(raw);
    if (!parsed) return undefined;
    const qualityScore = clamp(Math.round(asNumber(parsed.qualityScore) || 0), 0, 100);
    const opportunityScore = clamp(Math.round(asNumber(parsed.opportunityScore) || 0), 0, 100);
    const reason = asString(parsed.reason) || 'xAI scored the lead based on visible authority and growth opportunity.';
    const angle = asString(parsed.angle) || 'Show missing authority signals and offer a short strategy walkthrough.';
    return { qualityScore, opportunityScore, reason: truncate(reason, 220), angle: truncate(angle, 220), provider: 'xai' };
  } catch (error) {
    runtimeError('agent', 'prospector xai score errored', error, { company: input.place.name });
    return undefined;
  }
}

async function geminiLeadIntel(input: {
  icp: string;
  city: string;
  state: string;
  place: PlaceCandidate;
  websiteStatus: string;
  websiteProfile?: WebsiteProfile;
}): Promise<LeadIntel | undefined> {
  if (!config.geminiApiKey) return undefined;
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      config.geminiModel
    )}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
    const prompt = [
      'Score this local business lead for AI + Google authority outreach. Return strict JSON only.',
      '{"qualityScore":0-100,"opportunityScore":0-100,"reason":"...","angle":"..."}',
      `ICP: ${input.icp}`,
      `Market: ${input.city}, ${input.state}`,
      `Business: ${input.place.name}`,
      `Address: ${input.place.formattedAddress || 'unknown'}`,
      `Website status: ${input.websiteStatus}`,
      `Website: ${input.place.websiteUri || 'none'}`,
      `Rating: ${input.place.rating || 0}`,
      `Review count: ${input.place.userRatingCount || 0}`,
      `Business status: ${input.place.businessStatus || 'unknown'}`,
      `Categories: ${(input.place.types || []).join(', ') || 'unknown'}`,
      `Website title: ${input.websiteProfile?.title || ''}`,
      `Website description: ${input.websiteProfile?.description || ''}`
    ].join('\n');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generationConfig: { temperature: 0.15 },
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      })
    });
    if (!res.ok) return undefined;
    const payload = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '';
    const parsed = parseJsonObjectFromText(raw);
    if (!parsed) return undefined;
    const qualityScore = clamp(Math.round(asNumber(parsed.qualityScore) || 0), 0, 100);
    const opportunityScore = clamp(Math.round(asNumber(parsed.opportunityScore) || 0), 0, 100);
    const reason = asString(parsed.reason) || 'Gemini scored the lead based on visible local authority signals.';
    const angle = asString(parsed.angle) || 'Lead with one concrete local signal and send booking SMS.';
    return {
      qualityScore,
      opportunityScore,
      reason: truncate(reason, 220),
      angle: truncate(angle, 220),
      provider: 'gemini'
    };
  } catch (error) {
    runtimeError('agent', 'prospector gemini score errored', error, { company: input.place.name });
    return undefined;
  }
}

function heuristicLeadIntel(input: {
  place: PlaceCandidate;
  websiteStatus: string;
  websiteProfile?: WebsiteProfile;
}): LeadIntel {
  let quality = 25;
  let opportunity = 35;

  if (input.place.rating) quality += Math.round(input.place.rating * 5);
  if (input.place.userRatingCount) quality += Math.min(18, Math.round(Math.log10(input.place.userRatingCount + 1) * 9));
  if (input.place.nationalPhoneNumber) quality += 10;
  if (input.websiteStatus === 'present') quality += 12;
  if (input.websiteStatus === 'missing') opportunity += 35;
  if (input.place.rating && input.place.rating >= 4.3) opportunity += 10;
  if ((input.place.userRatingCount || 0) >= 50) opportunity += 10;
  if (input.websiteProfile?.email) quality += 8;
  if (input.websiteProfile?.phone) quality += 6;
  if (input.place.businessStatus && input.place.businessStatus.toUpperCase() === 'OPERATIONAL') quality += 6;

  quality = clamp(quality, 0, 100);
  opportunity = clamp(opportunity, 0, 100);
  return {
    qualityScore: quality,
    opportunityScore: opportunity,
    reason:
      input.websiteStatus === 'missing'
        ? 'No website detected with local business signals present; strong vision-site opportunity.'
        : 'Existing footprint detected; evaluate authority gaps and conversion flow quality.',
    angle:
      input.websiteStatus === 'missing'
        ? 'Lead with missing-site risk and offer a fast live vision link.'
        : 'Lead with authority-signal gaps and offer an AI + Google trust walkthrough.',
    provider: 'heuristic'
  };
}

async function generateLeadIntel(input: {
  icp: string;
  city: string;
  state: string;
  place: PlaceCandidate;
  websiteStatus: string;
  websiteProfile?: WebsiteProfile;
}): Promise<LeadIntel> {
  const xai = await xaiLeadIntel(input);
  if (xai) return xai;
  const gemini = await geminiLeadIntel(input);
  if (gemini) return gemini;
  return heuristicLeadIntel(input);
}

async function geminiSummary(input: {
  icp: string;
  city: string;
  state: string;
  business: string;
  address?: string;
  websiteStatus: string;
}): Promise<string | undefined> {
  if (!config.geminiApiKey) return undefined;
  try {
    const prompt = [
      'Write a concise 450-700 word homepage planning summary for this local business prospect.',
      `Business: ${input.business}`,
      `ICP: ${input.icp}`,
      `Market: ${input.city}, ${input.state}`,
      `Address: ${input.address || 'unknown'}`,
      `Website status: ${input.websiteStatus}`,
      'Cover likely services, trust signals, CTA structure, conversion strategy, and local positioning.',
      'Return plain text only.'
    ].join('\n');

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      config.geminiModel
    )}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generationConfig: { temperature: 0.35 },
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      })
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n').trim() || undefined;
  } catch (error) {
    runtimeError('agent', 'prospector gemini summary failed', error, { business: input.business });
    return undefined;
  }
}

async function searchPlaces(icp: string, city: string, state: string): Promise<PlaceCandidate[]> {
  const queries = buildSearchQueries(icp, city, state);
  const location = await geocodeMarket(city, state);
  const all = new Map<string, PlaceCandidate>();

  const newResults = await searchPlacesNew(queries, location);
  for (const row of newResults) {
    const key = row.id || `${row.name}|${row.formattedAddress || ''}|${hostFromUrl(row.websiteUri)}`;
    if (!all.has(key)) all.set(key, row);
  }

  if (all.size < 8) {
    const legacyResults = await searchPlacesLegacy(queries, location);
    for (const row of legacyResults) {
      const key = row.id || `${row.name}|${row.formattedAddress || ''}|${hostFromUrl(row.websiteUri)}`;
      if (!all.has(key)) all.set(key, row);
    }
  }

  if (all.size < 5) {
    const cseResults = await searchCseCandidates(queries);
    for (const row of cseResults) {
      const key = row.id || `${row.name}|${row.formattedAddress || ''}|${hostFromUrl(row.websiteUri)}`;
      if (!all.has(key)) all.set(key, row);
    }
  }

  if (all.size < 30) {
    const dfsResults = await searchDataForSeoCandidates(icp, city, state);
    for (const row of dfsResults) {
      const key = row.id || `${row.name}|${row.formattedAddress || ''}|${hostFromUrl(row.websiteUri)}`;
      if (!all.has(key)) all.set(key, row);
    }
  }

  const out = [...all.values()].slice(0, 80);
  runtimeInfo('agent', 'prospector source merge complete', {
    icp,
    city,
    state,
    total: out.length,
    placesNew: out.filter((row) => row.source === 'places_new').length,
    placesLegacy: out.filter((row) => row.source === 'places_legacy').length,
    cse: out.filter((row) => row.source === 'cse').length,
    dataforseo: out.filter((row) => row.source === 'dataforseo').length
  });
  return out;
}

async function buildLead(input: ProspectorRunInput, place: PlaceCandidate, idx: number): Promise<Lead> {
  const createdAt = nowIso();
  const placeWebsite = normalizeOwnedWebsite(place.websiteUri);
  const cseFallback = placeWebsite ? undefined : await cseLikelyWebsite(place.name, input.city, input.state);
  const fallbackWebsite = placeWebsite || cseFallback?.website;
  const websiteStatus: Lead['prospectWebsiteStatus'] = fallbackWebsite ? 'present' : 'missing';
  const websiteProfile = fallbackWebsite ? await scrapeWebsiteProfile(fallbackWebsite) : undefined;
  const apolloProfile = fallbackWebsite ? await apolloOrganizationByDomain(hostFromUrl(fallbackWebsite)) : undefined;
  const leadIntel = await generateLeadIntel({
    icp: input.icp,
    city: input.city,
    state: input.state,
    place,
    websiteStatus,
    websiteProfile
  });
  const summary =
    websiteStatus === 'missing'
      ? await geminiSummary({
          icp: input.icp,
          city: input.city,
          state: input.state,
          business: place.name,
          address: place.formattedAddress,
          websiteStatus
        })
      : undefined;
  const normalizedPhone =
    normalizePhone(place.nationalPhoneNumber || websiteProfile?.phone || '') ||
    normalizePhone(apolloProfile?.phone || '') ||
    place.nationalPhoneNumber ||
    apolloProfile?.phone ||
    websiteProfile?.phone ||
    '';
  const sourceTags = [
    ...new Set([
      place.source,
      fallbackWebsite ? 'website_detected' : 'website_missing',
      cseFallback ? 'cse_website_lookup' : '',
      websiteProfile ? 'firecrawl' : '',
      apolloProfile ? 'apollo' : ''
    ])
  ].filter(Boolean);
  const findingsParts = [
    `Address: ${place.formattedAddress || 'n/a'}`,
    `Maps: ${place.googleMapsUri || 'n/a'}`,
    `Website: ${fallbackWebsite || 'missing'}`,
    `Rating: ${typeof place.rating === 'number' ? place.rating : 'n/a'}`,
    `Reviews: ${typeof place.userRatingCount === 'number' ? place.userRatingCount : 'n/a'}`,
    `Source: ${place.source}`,
    websiteProfile?.title ? `Site Title: ${websiteProfile.title}` : '',
    websiteProfile?.description ? `Site Desc: ${truncate(websiteProfile.description, 120)}` : '',
    cseFallback?.snippet ? `Search Snippet: ${truncate(cseFallback.snippet, 120)}` : '',
    apolloProfile?.industry ? `Apollo Industry: ${apolloProfile.industry}` : '',
    apolloProfile?.employeeCount ? `Apollo Employees: ${apolloProfile.employeeCount}` : ''
  ].filter(Boolean);
  const id =
    `prospector-${slug(input.icp)}-${slug(input.city)}-${slug(input.state)}-${slug(place.name).slice(0, 24)}-${idx}`.slice(
      0,
      120
    );

  return {
    id,
    phone: normalizedPhone,
    firstName: undefined,
    lastName: undefined,
    company: place.name,
    email: websiteProfile?.email,
    timezone: config.defaultTimezone,
    campaign: `Prospector ${input.icp} ${input.city} ${input.state}`,
    sourceFile: 'prospector-dashboard',
    sourceRow: idx,
    findings: findingsParts.join(' | '),
    notes:
      `Multi-source prospecting complete. quality=${leadIntel.qualityScore}, opportunity=${leadIntel.opportunityScore}, provider=${leadIntel.provider}. ` +
      `${leadIntel.reason}${apolloProfile?.description ? ` Apollo: ${truncate(apolloProfile.description, 140)}` : ''}`,
    prospectAddress: place.formattedAddress,
    prospectGoogleMapsUri: place.googleMapsUri,
    prospectWebsiteUri: fallbackWebsite,
    prospectWebsiteStatus: websiteStatus,
    prospectWebsiteTitle: websiteProfile?.title,
    prospectWebsiteDescription: websiteProfile?.description,
    prospectWebsiteSnippet: websiteProfile?.snippet,
    prospectWebsiteEmail: websiteProfile?.email,
    prospectWebsitePhone: websiteProfile?.phone,
    prospectWebsiteAnalyzedAt: websiteProfile ? nowIso() : undefined,
    prospectIcp: input.icp,
    prospectCity: input.city,
    prospectState: input.state,
    prospectRating: place.rating,
    prospectReviewCount: place.userRatingCount,
    prospectBusinessStatus: place.businessStatus,
    prospectCategories: place.types,
    prospectDataSources: sourceTags,
    prospectScore: leadIntel.qualityScore,
    prospectOpportunityScore: leadIntel.opportunityScore,
    prospectScoreReason: leadIntel.reason,
    prospectScoreProvider: leadIntel.provider,
    prospectSummary: summary || leadIntel.angle,
    prospectorPhase: 1,
    prospectorPhaseStatus: 'phase1_collected',
    generationStatus: websiteStatus === 'missing' ? 'ready' : 'not_started',
    optIn: false,
    dnc: false,
    status: 'blocked',
    attempts: 0,
    createdAt,
    updatedAt: createdAt
  };
}

export async function startProspectorRun(input: ProspectorRunInput): Promise<ProspectorRun> {
  const createdAt = nowIso();
  const run: ProspectorRun = {
    id: randomUUID(),
    icp: input.icp.trim(),
    city: input.city.trim(),
    state: input.state.trim(),
    status: 'running',
    createdAt,
    updatedAt: createdAt,
    discovered: 0,
    notes: 'Multi-source prospecting run started.'
  };
  runs.unshift(run);

  try {
    const places = await searchPlaces(input.icp, input.city, input.state);
    const leads: Lead[] = [];
    let failed = 0;

    for (const [idx, place] of places.entries()) {
      try {
        const lead = await buildLead(input, place, idx + 1);
        leads.push(lead);
      } catch (error) {
        failed += 1;
        runtimeError('agent', 'prospector lead build failed', error, {
          runId: run.id,
          company: place.name,
          source: place.source
        });
      }
    }

    await withState((state) => {
      for (const lead of leads) {
        state.leads[lead.id] = lead;
      }
      state.updatedAt = nowIso();
      return state;
    });

    run.discovered = leads.length;
    run.status = 'completed';
    run.updatedAt = nowIso();
    const sourceCounts = leads.reduce<Record<string, number>>((acc, lead) => {
      for (const source of lead.prospectDataSources || []) {
        acc[source] = (acc[source] || 0) + 1;
      }
      return acc;
    }, {});
    run.notes =
      `Fetched ${places.length} candidates; built ${leads.length} leads; missing-website ${run.discovered}; failed-build ${failed}. ` +
      `Sources: ${Object.entries(sourceCounts)
        .map(([key, value]) => `${key}:${value}`)
        .join(', ') || 'none'}.`;

    runtimeInfo('agent', 'prospector run completed', {
      runId: run.id,
      icp: run.icp,
      city: run.city,
      state: run.state,
      discovered: run.discovered,
      fetched: places.length,
      built: leads.length,
      failed
    });

    return run;
  } catch (error) {
    run.status = 'failed';
    run.updatedAt = nowIso();
    run.notes = `Prospecting failed: ${String(error).slice(0, 500)}`;
    runtimeError('agent', 'prospector run failed', error, {
      runId: run.id,
      icp: run.icp,
      city: run.city,
      state: run.state
    });
    return run;
  }
}

export function listProspectorRuns(): ProspectorRun[] {
  return [...runs];
}
