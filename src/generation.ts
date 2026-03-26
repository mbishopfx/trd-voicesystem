import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { runtimeError, runtimeInfo } from "./runtimeLogs.js";
import { withState } from "./store.js";
import type { Lead } from "./types.js";
import { hashShort, nowIso } from "./utils.js";

const PROMPT_PATH = path.resolve(process.cwd(), "prompts", "prospector-ux-template-builder.md");
let cachedPrompt: string | undefined;

function safeFileName(value: string): string {
  return (
    String(value || "lead")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 90) || "lead"
  );
}

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toList(value: string): string[] {
  return value
    .split(/[,/|]| and /gi)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function inferIndustry(lead: Lead): string {
  const icp = toText(lead.prospectIcp).toLowerCase();
  if (icp.includes("med spa") || icp.includes("medical spa")) return "Medical Spa";
  if (icp.includes("dental")) return "Dental Practice";
  if (icp.includes("law")) return "Law Firm";
  if (icp.includes("salon")) return "Salon";
  if (icp.includes("contractor")) return "Contractor";
  if (icp.includes("agency")) return "Marketing Agency";
  return toText(lead.prospectIcp) || "Local Service Business";
}

function inferServices(lead: Lead): string[] {
  const icp = toText(lead.prospectIcp);
  const inferred = toList(icp);
  if (inferred.length > 0) return inferred;
  return ["Primary service", "Specialized offering", "Consultation"];
}

function serviceCards(lead: Lead): [string, string, string] {
  const inferred = inferServices(lead).filter(Boolean);
  const padded = [...inferred, "Client Experience", "Signature Service", "Premium Consult"];
  return [padded[0], padded[1], padded[2]];
}

function buildDeployName(lead: Lead): string {
  const company = safeFileName(lead.company || lead.id);
  const icp = safeFileName(lead.prospectIcp || "local-business");
  const city = safeFileName(lead.prospectCity || "city");
  const state = safeFileName(lead.prospectState || "state");
  return `prospector-${icp}-${city}-${state}-${company}`;
}

function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```$/, "")
    .trim();
}

function ensureHtmlDocument(raw: string): string | undefined {
  const cleaned = stripMarkdownFences(raw);
  if (!cleaned) return undefined;
  const lowered = cleaned.toLowerCase();
  if (!lowered.includes("<html") || !lowered.includes("<body")) return undefined;
  return cleaned;
}

const RELIABLE_PREMIUM_IMAGES = [
  "https://images.unsplash.com/photo-1613490495763-547a569e4a02?ixlib=rb-4.0.3&auto=format&fit=crop&w=2940&q=80",
  "https://images.unsplash.com/photo-1460353581641-37baddab0fa2?auto=format&fit=crop&w=2200&q=80",
  "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=1800&q=80",
  "https://images.unsplash.com/photo-1519710164239-da123dc03ef4?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1505693314120-0d443867891c?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1493666438817-866a91353ca9?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1497215842964-222b430dc094?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1489515217757-5fd1be406fef?auto=format&fit=crop&w=1200&q=80"
];
const EMERGENCY_IMAGE_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjAwIiBoZWlnaHQ9IjkwMCIgdmlld0JveD0iMCAwIDE2MDAgOTAwIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjZWFlNmRlIi8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjY2RjNmI4Ii8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjE2MDAiIGhlaWdodD0iOTAwIiBmaWxsPSJ1cmwoI2cpIi8+PC9zdmc+";

const imageReachabilityCache = new Map<string, boolean>();
let verifiedFallbackPoolPromise: Promise<string[]> | undefined;

function isBadImageSource(src: string): boolean {
  const value = src.trim().toLowerCase();
  if (!value) return true;
  if (value.startsWith("data:")) return false;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    if (value.includes("source.unsplash.com/random")) return true;
    if (value.includes("source.unsplash.com/")) return true;
    return false;
  }
  return true;
}

function hasImageLikeExtension(url: string): boolean {
  const lowered = url.toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"].some((ext) => lowered.includes(ext));
}

function looksLikeImageContentType(value: string | null): boolean {
  if (!value) return false;
  return value.toLowerCase().includes("image/");
}

async function isReachableImageUrl(url: string): Promise<boolean> {
  const normalized = url.trim();
  if (!normalized) return false;
  if (normalized.startsWith("data:")) return true;
  if (!(normalized.startsWith("http://") || normalized.startsWith("https://"))) return false;

  const cached = imageReachabilityCache.get(normalized);
  if (cached !== undefined) return cached;

  const headers = {
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  };

  const checkWith = async (method: "HEAD" | "GET"): Promise<boolean> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(normalized, {
        method,
        headers,
        redirect: "follow",
        signal: controller.signal
      });
      if (!response.ok && response.status !== 206) return false;
      const contentType = response.headers.get("content-type");
      if (looksLikeImageContentType(contentType)) return true;
      if (!contentType && hasImageLikeExtension(normalized)) return true;
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };

  const headOk = await checkWith("HEAD");
  if (headOk) {
    imageReachabilityCache.set(normalized, true);
    return true;
  }

  const getOk = await checkWith("GET");
  imageReachabilityCache.set(normalized, getOk);
  return getOk;
}

async function verifiedFallbackPool(): Promise<string[]> {
  if (verifiedFallbackPoolPromise) return verifiedFallbackPoolPromise;
  verifiedFallbackPoolPromise = (async () => {
    const checks = await Promise.all(
      RELIABLE_PREMIUM_IMAGES.map(async (url) => ((await isReachableImageUrl(url)) ? url : ""))
    );
    const good = checks.filter(Boolean);
    return good.length ? good : [EMERGENCY_IMAGE_DATA_URI];
  })();
  return verifiedFallbackPoolPromise;
}

async function sanitizeImageSources(html: string): Promise<{ html: string; replaced: number }> {
  const regex = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)(\2)/gi;
  const matches = Array.from(html.matchAll(regex));
  if (matches.length === 0) return { html, replaced: 0 };

  const fallbackPool = await verifiedFallbackPool();
  let replacementIdx = 0;
  let replaced = 0;
  let cursor = 0;
  let out = "";

  for (const match of matches) {
    const fullMatch = match[0] || "";
    const prefix = match[1] || "";
    const quote = match[2] || '"';
    const src = String(match[3] || "");
    const start = match.index ?? -1;
    if (start < 0) continue;
    const end = start + fullMatch.length;
    out += html.slice(cursor, start);

    const badByPattern = isBadImageSource(src);
    const reachable = badByPattern ? false : await isReachableImageUrl(src);
    if (!badByPattern && reachable) {
      out += fullMatch;
    } else {
      const replacement = fallbackPool[replacementIdx % fallbackPool.length];
      replacementIdx += 1;
      replaced += 1;
      out += `${prefix}${quote}${replacement}${quote}`;
    }

    cursor = end;
  }

  out += html.slice(cursor);
  return { html: out, replaced };
}

function hasStrongStructure(html: string): boolean {
  const imgCount = (html.match(/<img\b/gi) || []).length;
  const sectionCount = (html.match(/<section\b/gi) || []).length;
  return imgCount >= 5 && sectionCount >= 6;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanProspectSummary(raw: string): string {
  let value = raw || "";
  value = value.replace(/\*\*/g, "");
  value = value.replace(/^#+\s*/gm, "");
  value = value.replace(/\bHomepage Planning Summary\b:?/gi, "");
  value = value.replace(/\bGoal\b\s*:\s*/gi, "");
  value = value.replace(/\bObjective\b\s*:\s*/gi, "");
  value = value.replace(/\bSummary\b\s*:\s*/gi, "");
  value = value.replace(/\bThe homepage will serve[^.]*\.?/gi, "");
  value = cleanText(value);
  if (!value) return "";
  if (value.length > 240) value = `${value.slice(0, 237).trim()}...`;
  return value;
}

function buildHeroTagline(lead: Lead, industry: string): string {
  const city = toText(lead.prospectCity);
  const state = toText(lead.prospectState);
  const market = [city, state].filter(Boolean).join(", ");
  if (market) return `Trusted ${industry} in ${market}`;
  return `Trusted ${industry} Partner`;
}

function buildPunchTagline(lead: Lead): string {
  const root = inferIndustry(lead).split(/\s+/).filter(Boolean)[0] || "Business";
  return `${root} authority that drives better leads`;
}

function enforcePunchTaglineUnderTitle(html: string, lead: Lead): string {
  const tagline = escapeHtml(buildPunchTagline(lead));
  return html.replace(/(<h1\b[^>]*>[\s\S]*?<\/h1>\s*<p\b[^>]*>)([\s\S]*?)(<\/p>)/i, `$1${tagline}$3`);
}

function hasRawPlanningCopy(html: string): boolean {
  const normalized = html.toLowerCase();
  return (
    normalized.includes("homepage planning summary") ||
    normalized.includes("goal: to establish a strong online presence") ||
    normalized.includes("the homepage will serve as the primary entry point") ||
    normalized.includes("**goal:**") ||
    normalized.includes("**")
  );
}

function renderFallbackTemplate(lead: Lead): string {
  const title = escapeHtml(lead.company || "Business Name");
  const city = escapeHtml(lead.prospectCity || "Local City");
  const state = escapeHtml(lead.prospectState || "");
  const industryRaw = inferIndustry(lead);
  const industry = escapeHtml(industryRaw);
  const heroTagline = escapeHtml(buildHeroTagline(lead, industryRaw));
  const punchTagline = escapeHtml(buildPunchTagline(lead));
  const [serviceA, serviceB, serviceC] = serviceCards(lead).map(escapeHtml) as [string, string, string];
  const marketLabel = [city, state].filter(Boolean).join(", ") || "Local Market";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title} | ${industry}</title>
  <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Noto+Serif:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet"/>
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
  <script id="tailwind-config">
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            body: ["Inter", "sans-serif"],
            headline: ["Noto Serif", "serif"],
            label: ["Inter", "sans-serif"]
          },
          colors: {
            primary: "#516447",
            "primary-container": "#8fa382",
            secondary: "#6c5e06",
            "secondary-container": "#f7e382",
            surface: "#f9f9f9",
            "surface-container": "#eeeeee",
            outline: "#74786f",
            "on-surface": "#1a1c1c",
            "on-primary": "#ffffff"
          }
        }
      }
    };
  </script>
  <style>
    body { font-family: "Inter", sans-serif; }
    h1, h2, h3, .serif { font-family: "Noto Serif", serif; }
    .bg-hero-gradient { background: linear-gradient(135deg, rgba(81, 100, 71, 0.16) 0%, rgba(143, 163, 130, 0.04) 100%); }
    .material-symbols-outlined { font-variation-settings: "FILL" 0, "wght" 300, "GRAD" 0, "opsz" 24; }
  </style>
</head>
<body class="bg-surface text-on-surface selection:bg-primary-container">
  <nav class="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-md shadow-sm shadow-black/5">
    <div class="flex justify-between items-center w-full px-8 py-4 max-w-screen-2xl mx-auto">
      <div class="text-xl font-serif tracking-tighter text-primary">${title}</div>
      <div class="hidden md:flex space-x-12 items-center">
        <a class="text-zinc-500 font-medium hover:text-primary-container transition-colors duration-300 tracking-widest uppercase text-[10px] font-label" href="#services">Services</a>
        <a class="text-zinc-500 font-medium hover:text-primary-container transition-colors duration-300 tracking-widest uppercase text-[10px] font-label" href="#about">Experience</a>
        <a class="text-zinc-500 font-medium hover:text-primary-container transition-colors duration-300 tracking-widest uppercase text-[10px] font-label" href="#reviews">Reviews</a>
      </div>
      <div class="flex items-center space-x-6">
        <button class="text-primary transition-all hover:opacity-80"><span class="material-symbols-outlined">calendar_today</span></button>
        <a href="#cta" class="bg-primary text-on-primary px-6 py-2.5 rounded-md font-label text-[11px] uppercase tracking-widest hover:bg-primary-container transition-colors duration-300 shadow-md shadow-primary/10">Book Now</a>
      </div>
    </div>
  </nav>

  <section class="relative min-h-screen flex items-center justify-center pt-20 overflow-hidden">
    <div class="absolute inset-0 z-0">
      <div class="w-full h-full bg-hero-gradient"></div>
      <img class="w-full h-full object-cover opacity-60 grayscale-[20%]" data-alt="premium editorial brand environment" src="${RELIABLE_PREMIUM_IMAGES[0]}" alt="${industry} hero atmosphere"/>
    </div>
    <div class="relative z-10 max-w-5xl mx-auto px-8 text-center">
      <span class="font-label text-[12px] uppercase tracking-[0.3em] text-primary mb-6 block font-medium">${heroTagline}</span>
      <h1 class="text-6xl md:text-8xl font-headline text-on-surface leading-[1.1] mb-8 tracking-tight">Elevating <span class="italic font-normal">${industry}</span> Authority</h1>
      <p class="max-w-2xl mx-auto text-lg text-outline font-body leading-relaxed mb-12">${punchTagline}</p>
      <div class="flex flex-col md:flex-row items-center justify-center gap-6">
        <a href="#cta" class="bg-primary text-on-primary px-10 py-4 rounded-md font-label text-xs uppercase tracking-[0.2em] hover:bg-primary-container transition-all duration-300 min-w-[200px]">Reserve Strategy Session</a>
        <a href="#services" class="text-primary border-b border-primary-container hover:border-primary transition-all font-label text-xs uppercase tracking-[0.2em] py-2">View Services</a>
      </div>
    </div>
  </section>

  <section id="services" class="py-24 bg-surface">
    <div class="max-w-7xl mx-auto px-8">
      <div class="mb-20 text-center md:text-left">
        <span class="font-label text-[11px] uppercase tracking-widest text-primary mb-4 block">Featured Solutions</span>
        <h2 class="text-4xl md:text-5xl font-headline text-on-surface">Premium Service Lines</h2>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-12">
        <div class="group relative overflow-hidden">
          <div class="aspect-[3/4] mb-8 bg-surface-container overflow-hidden"><img class="w-full h-full object-cover grayscale transition-transform duration-700 group-hover:scale-105" data-alt="${serviceA}" src="${RELIABLE_PREMIUM_IMAGES[1]}" alt="${serviceA}"/></div>
          <span class="font-label text-[10px] uppercase tracking-widest text-outline block mb-2">01. Signature</span>
          <h3 class="text-2xl font-headline mb-4">${serviceA}</h3>
          <p class="text-sm text-outline font-body leading-relaxed mb-6">Tailored delivery built around your market position, audience intent, and conversion priorities.</p>
        </div>
        <div class="group relative overflow-hidden md:mt-24">
          <div class="aspect-[3/4] mb-8 bg-surface-container overflow-hidden"><img class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" data-alt="${serviceB}" src="${RELIABLE_PREMIUM_IMAGES[2]}" alt="${serviceB}"/></div>
          <span class="font-label text-[10px] uppercase tracking-widest text-outline block mb-2">02. Growth</span>
          <h3 class="text-2xl font-headline mb-4">${serviceB}</h3>
          <p class="text-sm text-outline font-body leading-relaxed mb-6">Strategic implementation that strengthens AI discoverability and trusted authority signals.</p>
        </div>
        <div class="group relative overflow-hidden">
          <div class="aspect-[3/4] mb-8 bg-surface-container overflow-hidden"><img class="w-full h-full object-cover grayscale transition-transform duration-700 group-hover:scale-105" data-alt="${serviceC}" src="${RELIABLE_PREMIUM_IMAGES[3]}" alt="${serviceC}"/></div>
          <span class="font-label text-[10px] uppercase tracking-widest text-outline block mb-2">03. Positioning</span>
          <h3 class="text-2xl font-headline mb-4">${serviceC}</h3>
          <p class="text-sm text-outline font-body leading-relaxed mb-6">Brand-aligned UX and messaging designed to convert high-intent traffic into booked opportunities.</p>
        </div>
      </div>
    </div>
  </section>

  <section id="about" class="py-24 bg-surface-container">
    <div class="max-w-7xl mx-auto px-8 grid grid-cols-1 md:grid-cols-2 gap-20 items-center">
      <div class="relative order-2 md:order-1">
        <div class="aspect-square bg-white shadow-xl shadow-black/5 p-4 rounded-sm rotate-2"><img class="w-full h-full object-cover" data-alt="${title} brand environment" src="${RELIABLE_PREMIUM_IMAGES[4]}" alt="${title} environment"/></div>
        <div class="absolute -bottom-10 -right-10 w-2/3 aspect-video bg-primary-container hidden md:block z-[-1]"></div>
      </div>
      <div class="order-1 md:order-2">
        <span class="font-label text-[11px] uppercase tracking-widest text-primary mb-6 block">Why ${title}</span>
        <h2 class="text-5xl font-headline text-on-surface leading-tight mb-8">The ${title} <br/><span class="italic">Experience</span></h2>
        <div class="space-y-8">
          <div class="flex gap-6 items-start"><span class="text-secondary font-headline text-3xl opacity-40">01</span><div><h4 class="font-body font-semibold text-lg mb-2">Strategic Discovery</h4><p class="text-outline text-sm leading-relaxed">We map your strengths, audience behavior, and local demand signals before any build begins.</p></div></div>
          <div class="flex gap-6 items-start"><span class="text-secondary font-headline text-3xl opacity-40">02</span><div><h4 class="font-body font-semibold text-lg mb-2">Precision Execution</h4><p class="text-outline text-sm leading-relaxed">Every section is crafted for clarity, trust, and measurable conversion performance.</p></div></div>
          <div class="flex gap-6 items-start"><span class="text-secondary font-headline text-3xl opacity-40">03</span><div><h4 class="font-body font-semibold text-lg mb-2">Authority Positioning</h4><p class="text-outline text-sm leading-relaxed">Your brand is structured so both search engines and AI systems can recognize it as a source of truth.</p></div></div>
        </div>
      </div>
    </div>
  </section>

  <section id="reviews" class="py-24 bg-surface">
    <div class="max-w-7xl mx-auto px-8">
      <div class="text-center mb-16">
        <h2 class="text-4xl font-headline text-on-surface">Client Success Stories</h2>
        <div class="h-0.5 w-16 bg-primary mx-auto mt-6"></div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div class="bg-white p-10 border border-black/5 shadow-sm"><p class="text-on-surface font-body italic leading-relaxed mb-8">“We looked premium overnight and started getting stronger inbound leads almost immediately.”</p><p class="text-[10px] uppercase tracking-widest text-outline">Verified Client</p></div>
        <div class="bg-white p-10 border border-black/5 shadow-sm mt-4 md:mt-0"><p class="text-on-surface font-body italic leading-relaxed mb-8">“The structure feels intentional and high-end, and the messaging finally sounds like our brand.”</p><p class="text-[10px] uppercase tracking-widest text-outline">Growth Partner</p></div>
        <div class="bg-white p-10 border border-black/5 shadow-sm"><p class="text-on-surface font-body italic leading-relaxed mb-8">“The experience now communicates authority clearly across both Google and AI search surfaces.”</p><p class="text-[10px] uppercase tracking-widest text-outline">Market Operator</p></div>
      </div>
    </div>
  </section>

  <section class="py-24 bg-primary text-on-primary">
    <div class="max-w-7xl mx-auto px-8 text-center">
      <span class="font-label text-[11px] uppercase tracking-widest mb-6 block opacity-80">Our Philosophy</span>
      <h2 class="text-4xl md:text-5xl font-headline mb-20 max-w-3xl mx-auto">Modern Luxury. <span class="italic font-normal">Operational Precision.</span></h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-12">
        <div class="space-y-4"><span class="material-symbols-outlined text-4xl">clinical_notes</span><h5 class="font-label text-xs uppercase tracking-[0.2em]">Evidence First</h5></div>
        <div class="space-y-4"><span class="material-symbols-outlined text-4xl">verified</span><h5 class="font-label text-xs uppercase tracking-[0.2em]">Trust Signals</h5></div>
        <div class="space-y-4"><span class="material-symbols-outlined text-4xl">insights</span><h5 class="font-label text-xs uppercase tracking-[0.2em]">Data Driven</h5></div>
        <div class="space-y-4"><span class="material-symbols-outlined text-4xl">palette</span><h5 class="font-label text-xs uppercase tracking-[0.2em]">Brand Crafted</h5></div>
      </div>
    </div>
  </section>

  <section id="cta" class="py-32 bg-surface overflow-hidden relative">
    <div class="absolute inset-0 bg-primary-container opacity-15"></div>
    <div class="max-w-4xl mx-auto px-8 text-center relative z-10">
      <h2 class="text-5xl md:text-7xl font-headline text-on-surface mb-10 leading-tight">Start Your Next <span class="italic">Growth Chapter</span></h2>
      <p class="text-lg text-outline mb-12 font-body">Book a strategy call and see how ${title} can be positioned as the trusted choice in ${marketLabel}.</p>
      <div class="flex flex-col md:flex-row gap-6 justify-center">
        <a href="#" class="bg-secondary-container text-on-surface px-12 py-5 rounded-md font-label text-xs uppercase tracking-[0.3em] hover:opacity-90 transition-all shadow-lg shadow-secondary/10">Book Consultation</a>
        <a href="#" class="bg-primary text-on-primary px-12 py-5 rounded-md font-label text-xs uppercase tracking-[0.3em] hover:bg-primary-container transition-all">View Portfolio</a>
      </div>
    </div>
  </section>

  <footer class="bg-surface-container w-full py-20">
    <div class="grid grid-cols-1 md:grid-cols-4 gap-12 px-8 max-w-7xl mx-auto">
      <div><div class="text-lg font-serif text-primary mb-6">${title}</div><p class="text-sm text-zinc-600 font-body leading-relaxed">A premium digital experience built for authority, conversion, and long-term market trust.</p></div>
      <div><h6 class="font-headline text-on-surface text-sm font-semibold mb-6">Navigation</h6><ul class="space-y-4 font-label text-[10px] uppercase tracking-widest text-zinc-600"><li><a class="hover:text-primary transition-all" href="#services">Services</a></li><li><a class="hover:text-primary transition-all" href="#about">Experience</a></li><li><a class="hover:text-primary transition-all" href="#reviews">Reviews</a></li></ul></div>
      <div><h6 class="font-headline text-on-surface text-sm font-semibold mb-6">Connect</h6><ul class="space-y-4 font-label text-[10px] uppercase tracking-widest text-zinc-600"><li><a class="hover:text-primary transition-all" href="#">Instagram</a></li><li><a class="hover:text-primary transition-all" href="#">Newsletter</a></li><li><a class="hover:text-primary transition-all" href="#">Contact</a></li></ul></div>
      <div><h6 class="font-headline text-on-surface text-sm font-semibold mb-6">Contact</h6><p class="text-sm text-zinc-600 font-body mb-2">${escapeHtml(toText(lead.email) || "info@business.com")}</p><p class="text-sm text-zinc-600 font-body mb-6">${escapeHtml(toText(lead.phone) || "(555) 000-0000")}</p><a href="#cta" class="text-primary text-[10px] uppercase tracking-widest font-label font-bold border-b border-primary-container">Book Appointment</a></div>
    </div>
    <div class="max-w-7xl mx-auto px-8 mt-20 pt-8 border-t border-black/5 text-center md:text-left">
      <p class="text-[10px] tracking-widest uppercase text-zinc-500 font-label">© 2026 ${title}. All rights reserved.</p>
    </div>
  </footer>
</body>
</html>`;
}

async function loadProspectorPrompt(): Promise<string> {
  if (cachedPrompt) return cachedPrompt;
  const raw = await fs.readFile(PROMPT_PATH, "utf8");
  cachedPrompt = raw.trim();
  return cachedPrompt;
}

function buildBusinessInputBlock(lead: Lead): string {
  const services = inferServices(lead);
  const contactDetails = [
    toText(lead.phone) ? `Phone: ${toText(lead.phone)}` : "",
    toText(lead.email) ? `Email: ${toText(lead.email)}` : "",
    toText(lead.prospectAddress) ? `Address: ${toText(lead.prospectAddress)}` : ""
  ]
    .filter(Boolean)
    .join(" | ");

  return [
    "USER INPUT:",
    `business name: ${toText(lead.company) || "Business Name"}`,
    `industry: ${inferIndustry(lead)}`,
    `services: ${services.join(", ")}`,
    "brand tone: premium, elegant, trustworthy",
    "cta: Book a free strategy consultation",
    `contact details: ${contactDetails || "Not publicly listed"}`,
    "colors: subdued, premium neutrals with confident accent",
    `location: ${[toText(lead.prospectCity), toText(lead.prospectState)].filter(Boolean).join(", ") || "Local market"}`,
    "",
    "Additional context:",
    `- public website status: ${toText(lead.prospectWebsiteStatus) || "unknown"}`,
    `- Google Maps URL: ${toText(lead.prospectGoogleMapsUri) || "n/a"}`,
    `- Existing website URL: ${toText(lead.prospectWebsiteUri) || "none detected"}`,
    `- Prospect findings: ${toText(lead.findings) || "n/a"}`
  ].join("\n");
}

async function requestGeminiHtml(prompt: string, model: string): Promise<string | undefined> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0.45,
        topP: 0.92
      },
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    runtimeInfo("agent", "prospector gemini request failed", {
      model,
      status: response.status,
      body: body.slice(0, 300)
    });
    return undefined;
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const merged =
    payload.candidates?.[0]?.content?.parts?.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n") ||
    "";
  return ensureHtmlDocument(merged);
}

async function generateProspectorHomepageHtml(lead: Lead): Promise<{
  html: string;
  source: "gemini" | "fallback";
  model?: string;
  promptVersion: string;
}> {
  const promptVersion = hashShort(await loadProspectorPrompt());
  if (!config.geminiApiKey) {
    const fallback = renderFallbackTemplate(lead);
    const sanitized = await sanitizeImageSources(fallback);
    return { html: sanitized.html, source: "fallback", promptVersion };
  }

  const basePrompt = await loadProspectorPrompt();
  const userInput = buildBusinessInputBlock(lead);
  const fullPrompt = `${basePrompt}\n\n${userInput}`;
  const candidates = [...new Set([config.geminiProspectorModel, config.geminiModel].filter(Boolean))];

  for (const model of candidates) {
    try {
      const raw = await requestGeminiHtml(fullPrompt, model);
      if (raw) {
        const withTagline = enforcePunchTaglineUnderTitle(raw, lead);
        const sanitized = await sanitizeImageSources(withTagline);
        const cleaned = sanitized.html;
        if (hasRawPlanningCopy(cleaned)) {
          runtimeInfo("agent", "prospector gemini html rejected for planning/raw copy", {
            leadId: lead.id,
            model
          });
          continue;
        }
        if (!hasStrongStructure(cleaned)) {
          runtimeInfo("agent", "prospector gemini html rejected for weak structure", {
            leadId: lead.id,
            model,
            replacedImages: sanitized.replaced
          });
          continue;
        }
        return { html: cleaned, source: "gemini", model, promptVersion };
      }
    } catch (error) {
      runtimeError("agent", "prospector gemini generation failed", error, {
        leadId: lead.id,
        model
      });
    }
  }

  const fallback = renderFallbackTemplate(lead);
  const sanitized = await sanitizeImageSources(fallback);
  return { html: sanitized.html, source: "fallback", promptVersion };
}

export async function generateReadyProspectSites(
  limit = 10
): Promise<{ generated: number; leads: string[]; failed: number; failedLeads: Array<{ leadId: string; error: string }> }> {
  await fs.mkdir(config.generatedSitesDir, { recursive: true });
  const generated: string[] = [];
  const failedLeads: Array<{ leadId: string; error: string }> = [];

  await withState(async (state) => {
    const ready = Object.values(state.leads)
      .filter((lead) => lead.sourceFile === "prospector-dashboard" && lead.generationStatus === "ready")
      .slice(0, limit);

    for (const lead of ready) {
      try {
        const built = await generateProspectorHomepageHtml(lead);
        const deployName = buildDeployName(lead);
        const fileName = `${safeFileName(deployName)}.html`;
        const fullPath = path.resolve(config.generatedSitesDir, fileName);
        await fs.writeFile(fullPath, built.html, "utf8");

        lead.generatedSitePath = fullPath;
        lead.generationStatus = "generated";
        lead.prospectDeployName = deployName;
        lead.prospectorPhase = 2;
        lead.prospectorPhaseStatus = "phase2_generated";
        lead.prospectorTemplateSource = built.source;
        lead.prospectorTemplateModel = built.model;
        lead.prospectorPromptVersion = built.promptVersion;
        lead.updatedAt = nowIso();
        generated.push(lead.id);

        runtimeInfo("agent", "prospector site generated", {
          leadId: lead.id,
          deployName,
          generatedSitePath: fullPath,
          source: built.source,
          model: built.model || ""
        });
      } catch (error) {
        const message = String(error).slice(0, 500);
        lead.prospectorPhase = 2;
        lead.prospectorPhaseStatus = "phase2_generation_error";
        lead.generationStatus = "ready";
        lead.lastError = message;
        lead.updatedAt = nowIso();
        failedLeads.push({ leadId: lead.id, error: message });
        runtimeError("agent", "prospector site generation failed", error, { leadId: lead.id });
      }
    }
  });

  return { generated: generated.length, leads: generated, failed: failedLeads.length, failedLeads };
}
