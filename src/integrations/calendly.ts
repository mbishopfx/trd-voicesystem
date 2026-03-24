import { config } from "../config.js";

const CALENDLY_BASE_URL = "https://api.calendly.com";

export interface CalendlyEventType {
  uri: string;
  name?: string;
  slug?: string;
  active?: boolean;
  duration?: number;
  schedulingUrl?: string;
  kind?: string;
  poolingType?: string;
}

export interface CalendlyAvailableTime {
  startTime: string;
  status?: string;
  inviteesRemaining?: number;
}

export interface CalendlyInviteeResult {
  uri?: string;
  status?: string;
  event?: string;
  cancelUrl?: string;
  rescheduleUrl?: string;
  timezone?: string;
  startTime?: string;
  raw: Record<string, unknown>;
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(asObject(item)));
}

function headers(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

function resolveAccessToken(override?: string): string {
  const token = safeString(override) || config.calendlyAccessToken;
  if (!token) {
    throw new Error("Missing CALENDLY_ACCESS_TOKEN");
  }
  return token;
}

async function calendlyRequest(
  path: string,
  input?: {
    accessToken?: string;
    method?: string;
    query?: Record<string, string | undefined>;
    body?: Record<string, unknown>;
  }
): Promise<Record<string, unknown>> {
  const token = resolveAccessToken(input?.accessToken);
  const url = new URL(`${CALENDLY_BASE_URL}${path}`);
  if (input?.query) {
    for (const [key, value] of Object.entries(input.query)) {
      if (safeString(value)) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url, {
    method: input?.method || "GET",
    headers: headers(token),
    body: input?.body ? JSON.stringify(input.body) : undefined
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Calendly API request failed (${response.status}): ${raw.slice(0, 800)}`);
  }

  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

export function normalizeCalendlyEventTypeUri(input: string): string {
  const raw = input.trim();
  if (!raw) return raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw;
  }
  return `https://api.calendly.com/event_types/${raw.replace(/^\/+/, "")}`;
}

export async function getCalendlyContext(input?: {
  accessToken?: string;
}): Promise<{ userUri?: string; organizationUri?: string }> {
  const response = await calendlyRequest("/users/me", input);
  const resource = asObject(response.resource) || {};
  return {
    userUri: safeString(resource.uri),
    organizationUri: safeString(resource.current_organization)
  };
}

export async function listCalendlyEventTypes(input?: {
  accessToken?: string;
  organizationUri?: string;
  userUri?: string;
  count?: number;
  active?: boolean;
}): Promise<CalendlyEventType[]> {
  let organizationUri = safeString(input?.organizationUri);
  let userUri = safeString(input?.userUri);
  if (!organizationUri && !userUri) {
    const context = await getCalendlyContext({ accessToken: input?.accessToken });
    organizationUri = context.organizationUri;
    userUri = context.userUri;
  }

  const count = Math.max(1, Math.min(100, Math.trunc(input?.count || 20)));
  const query: Record<string, string | undefined> = {
    count: String(count),
    active: String(input?.active ?? true),
    organization: organizationUri,
    user: organizationUri ? undefined : userUri
  };

  const response = await calendlyRequest("/event_types", {
    accessToken: input?.accessToken,
    query
  });

  return asArray(response.collection).map((item) => ({
    uri: safeString(item.uri) || "",
    name: safeString(item.name),
    slug: safeString(item.slug),
    active: item.active === true,
    duration: typeof item.duration === "number" ? item.duration : undefined,
    schedulingUrl: safeString(item.scheduling_url),
    kind: safeString(item.kind),
    poolingType: safeString(item.pooling_type)
  }));
}

export async function listCalendlyEventTypeAvailableTimes(input: {
  accessToken?: string;
  eventTypeUri: string;
  startTime: string;
  endTime: string;
  timezone?: string;
}): Promise<CalendlyAvailableTime[]> {
  const response = await calendlyRequest("/event_type_available_times", {
    accessToken: input.accessToken,
    query: {
      event_type: normalizeCalendlyEventTypeUri(input.eventTypeUri),
      start_time: input.startTime,
      end_time: input.endTime,
      timezone: safeString(input.timezone)
    }
  });

  return asArray(response.collection).map((item) => ({
    startTime: safeString(item.start_time) || "",
    status: safeString(item.status),
    inviteesRemaining: typeof item.invitees_remaining === "number" ? item.invitees_remaining : undefined
  }));
}

export async function createCalendlyInvitee(input: {
  accessToken?: string;
  eventTypeUri: string;
  startTime: string;
  invitee: {
    name: string;
    email: string;
    timezone: string;
    firstName?: string;
    lastName?: string;
  };
  location?: {
    kind: string;
    location?: string;
  };
  eventGuests?: string[];
  notes?: string;
  tracking?: Record<string, string>;
}): Promise<CalendlyInviteeResult> {
  const body: Record<string, unknown> = {
    event_type: normalizeCalendlyEventTypeUri(input.eventTypeUri),
    start_time: input.startTime,
    invitee: {
      name: input.invitee.name,
      email: input.invitee.email,
      timezone: input.invitee.timezone,
      first_name: safeString(input.invitee.firstName),
      last_name: safeString(input.invitee.lastName)
    }
  };

  if (input.location?.kind) {
    body.location = {
      kind: input.location.kind,
      location: safeString(input.location.location)
    };
  }

  if (Array.isArray(input.eventGuests) && input.eventGuests.length) {
    const guests = input.eventGuests
      .map((item) => safeString(item))
      .filter((item): item is string => Boolean(item));
    if (guests.length) {
      body.event_guests = guests;
    }
  }

  const note = safeString(input.notes);
  if (note) {
    body.questions_and_answers = [
      {
        question: "Notes",
        answer: note,
        position: 1
      }
    ];
  }

  if (input.tracking && typeof input.tracking === "object") {
    body.tracking = input.tracking;
  }

  const response = await calendlyRequest("/invitees", {
    accessToken: input.accessToken,
    method: "POST",
    body
  });

  const resource = asObject(response.resource) || response;
  return {
    uri: safeString(resource.uri),
    status: safeString(resource.status),
    event: safeString(resource.event),
    cancelUrl: safeString(resource.cancel_url),
    rescheduleUrl: safeString(resource.reschedule_url),
    timezone: safeString(resource.timezone),
    startTime: safeString(resource.start_time),
    raw: resource
  };
}
