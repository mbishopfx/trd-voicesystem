import { randomUUID } from 'node:crypto';
import { withState } from './store.js';
import { config } from './config.js';
import { nowIso } from './utils.js';
import { runtimeInfo } from './runtimeLogs.js';
import type { Lead } from './types.js';

async function geminiSummary(input: { icp: string; city: string; state: string; business: string; address?: string; websiteStatus: string }): Promise<string | undefined> {
  if (!config.geminiApiKey) return undefined;
  const prompt = [
    'Write a concise 500-800 word homepage planning summary for this local business prospect.',
    `Business: ${input.business}`,
    `ICP: ${input.icp}`,
    `Market: ${input.city}, ${input.state}`,
    `Address: ${input.address || 'unknown'}`,
    `Website status: ${input.websiteStatus}`,
    'Cover likely services, trust signals, CTA structure, conversion strategy, and local positioning.',
    'Return plain text only.'
  ].join('\n');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      generationConfig: { temperature: 0.4 },
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    })
  });
  if (!response.ok) return undefined;
  const payload = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n').trim() || undefined;
}

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
  name: string;
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
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

function normalizeOwnedWebsite(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (NON_OWNED_HOST_MARKERS.some((marker) => host.includes(marker))) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

const runs: ProspectorRun[] = [];

function slug(value: string): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

async function geocodeMarket(city: string, state: string): Promise<{ lat: number; lng: number } | undefined> {
  if (!config.googleApiKey) return undefined;
  const address = encodeURIComponent(`${city}, ${state}`);
  const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${address}&key=${encodeURIComponent(config.googleApiKey)}`);
  if (!res.ok) {
    runtimeInfo('agent', 'prospector geocode request failed', { city, state, status: res.status });
    return undefined;
  }
  const data = (await res.json()) as { status?: string; results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }> };
  runtimeInfo('agent', 'prospector geocode response', { city, state, status: data.status || 'unknown', results: data.results?.length || 0 });
  const loc = data.results?.[0]?.geometry?.location;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return undefined;
  return { lat: loc.lat, lng: loc.lng };
}

async function searchPlaces(icp: string, city: string, state: string): Promise<PlaceCandidate[]> {
  if (!config.googleApiKey) return [];
  const location = await geocodeMarket(city, state);
  const queries = [
    `${icp} in ${city} ${state}`,
    `${icp} ${city} ${state}`,
    `${icp} near ${city} ${state}`,
    `${icp} ${state}`
  ];
  const dedupe = new Map<string, PlaceCandidate>();

  for (const textQuery of queries) {
    const body: Record<string, unknown> = {
      textQuery,
      maxResultCount: 10
    };
    if (location) {
      body.locationBias = {
        circle: {
          center: { latitude: location.lat, longitude: location.lng },
          radius: 40000
        }
      };
    }

    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.googleApiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      runtimeInfo('agent', 'prospector places request failed', { textQuery, status: res.status });
      continue;
    }
    const data = (await res.json()) as {
      error?: { message?: string };
      places?: Array<{
        displayName?: { text?: string };
        formattedAddress?: string;
        nationalPhoneNumber?: string;
        websiteUri?: string;
        googleMapsUri?: string;
      }>;
    };
    runtimeInfo('agent', 'prospector places response', { textQuery, count: data.places?.length || 0, error: data.error?.message || '' });

    for (const place of data.places || []) {
      const candidate: PlaceCandidate = {
        name: place.displayName?.text || 'Unknown Business',
        formattedAddress: place.formattedAddress,
        nationalPhoneNumber: place.nationalPhoneNumber,
        websiteUri: place.websiteUri,
        googleMapsUri: place.googleMapsUri
      };
      const key = `${candidate.name}|${candidate.formattedAddress || ''}`;
      if (!dedupe.has(key)) dedupe.set(key, candidate);
    }
  }

  return [...dedupe.values()];
}

async function cseLikelyWebsite(name: string, city: string, state: string): Promise<string | undefined> {
  if (!config.googleApiKey || !config.googleCseId) return undefined;
  const q = encodeURIComponent(`${name} ${city} ${state}`);
  const res = await fetch(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(config.googleApiKey)}&cx=${encodeURIComponent(config.googleCseId)}&q=${q}`);
  if (!res.ok) {
    runtimeInfo('agent', 'prospector cse request failed', { name, city, state, status: res.status });
    return undefined;
  }
  const data = (await res.json()) as { items?: Array<{ link?: string }> };
  runtimeInfo('agent', 'prospector cse response', { name, city, state, count: data.items?.length || 0 });
  for (const item of data.items || []) {
    const normalized = normalizeOwnedWebsite(item.link);
    if (normalized) return normalized;
  }
  return undefined;
}

async function buildLead(input: ProspectorRunInput, place: PlaceCandidate, idx: number): Promise<Lead> {
  const createdAt = nowIso();
  const placeWebsite = normalizeOwnedWebsite(place.websiteUri);
  const fallbackWebsite = placeWebsite || (await cseLikelyWebsite(place.name, input.city, input.state));
  const websiteStatus = fallbackWebsite ? 'present' : 'missing';
  const summary = websiteStatus === 'missing'
    ? await geminiSummary({ icp: input.icp, city: input.city, state: input.state, business: place.name, address: place.formattedAddress, websiteStatus })
    : undefined;
  const id = `prospector-${slug(input.icp)}-${slug(input.city)}-${slug(input.state)}-${idx}`;
  return {
    id,
    phone: place.nationalPhoneNumber || '',
    firstName: undefined,
    lastName: undefined,
    company: place.name,
    email: undefined,
    timezone: config.defaultTimezone,
    campaign: `Prospector ${input.icp} ${input.city} ${input.state}`,
    sourceFile: 'prospector-dashboard',
    sourceRow: idx,
    findings: `Address: ${place.formattedAddress || 'n/a'} | Maps: ${place.googleMapsUri || 'n/a'} | Website: ${fallbackWebsite || 'missing'}`,
    notes: fallbackWebsite ? 'Prospected from Google Places/CSE. Website detected.' : 'Prospected from Google Places. Missing website candidate.',
    prospectAddress: place.formattedAddress,
    prospectGoogleMapsUri: place.googleMapsUri,
    prospectWebsiteUri: fallbackWebsite,
    prospectWebsiteStatus: websiteStatus,
    prospectIcp: input.icp,
    prospectCity: input.city,
    prospectState: input.state,
    prospectSummary: summary,
    prospectorPhase: 1,
    prospectorPhaseStatus: 'phase1_collected',
    generationStatus: websiteStatus === 'missing' ? 'ready' : 'not_started',
    optIn: false,
    dnc: false,
    status: 'blocked',
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
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
    notes: 'Google-powered prospecting run created from dashboard.'
  };
  runs.unshift(run);

  try {
    const places = await searchPlaces(input.icp, input.city, input.state);
    const leads = await Promise.all(places.map((place, idx) => buildLead(input, place, idx + 1)));

    await withState((state) => {
      for (const lead of leads) {
        state.leads[lead.id] = lead;
      }
      state.updatedAt = nowIso();
      return state;
    });

    run.discovered = leads.filter((lead) => lead.prospectWebsiteStatus === 'missing').length;
    run.status = 'completed';
    run.updatedAt = nowIso();
    run.notes = `Fetched ${places.length} places across fallback Google queries; queued ${run.discovered} missing-website candidates.`;
    runtimeInfo('agent', 'prospector run completed', {
      runId: run.id,
      icp: run.icp,
      city: run.city,
      state: run.state,
      discovered: run.discovered,
      fetched: places.length
    });
    return run;
  } catch (error) {
    run.status = 'failed';
    run.updatedAt = nowIso();
    run.notes = String(error);
    throw error;
  }
}

export function listProspectorRuns(): ProspectorRun[] {
  return [...runs];
}
