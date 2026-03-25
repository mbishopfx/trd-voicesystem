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

function renderFallbackTemplate(lead: Lead): string {
  const title = lead.company || "Business Name";
  const city = lead.prospectCity || "Local City";
  const summary = (
    lead.prospectSummary ||
    "A premium local brand presence crafted to position your business as the trusted source in your market."
  ).slice(0, 320);
  const industry = inferIndustry(lead);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title} | ${industry}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Noto+Serif:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet"/>
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            body: ["Inter", "sans-serif"],
            headline: ["Noto Serif", "serif"]
          },
          colors: {
            primary: "#2f5a56",
            "primary-container": "#d7ebe8",
            secondary: "#7c6f56",
            "secondary-container": "#efe8d8",
            surface: "#f7f6f3",
            "surface-container": "#eeece7",
            outline: "#b9b4a8",
            "on-surface": "#1f1d18",
            "on-primary": "#ffffff"
          }
        }
      }
    };
  </script>
</head>
<body class="bg-surface text-on-surface font-body">
  <header class="fixed inset-x-0 top-0 z-50 border-b border-outline/30 bg-white/75 backdrop-blur">
    <div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
      <div class="font-headline text-xl">${title}</div>
      <nav class="hidden gap-8 text-xs uppercase tracking-[0.2em] text-on-surface/70 md:flex">
        <a href="#services">Services</a><a href="#about">About</a><a href="#reviews">Reviews</a>
      </nav>
      <a href="#cta" class="rounded-md bg-primary px-4 py-2 text-xs uppercase tracking-[0.2em] text-on-primary">Get Started</a>
    </div>
  </header>
  <main class="pt-20">
    <section class="relative min-h-[80vh]">
      <img src="https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1800&q=80" alt="Editorial brand backdrop" class="absolute inset-0 h-full w-full object-cover"/>
      <div class="absolute inset-0 bg-gradient-to-b from-black/40 via-black/20 to-surface"></div>
      <div class="relative mx-auto max-w-6xl px-6 py-24 text-white">
        <p class="text-xs uppercase tracking-[0.3em]">${city}</p>
        <h1 class="mt-6 max-w-3xl font-headline text-5xl leading-tight md:text-7xl">Premium Digital Presence for ${title}</h1>
        <p class="mt-8 max-w-2xl text-lg text-white/90">${summary}</p>
      </div>
    </section>
  </main>
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
    return { html: renderFallbackTemplate(lead), source: "fallback", promptVersion };
  }

  const basePrompt = await loadProspectorPrompt();
  const userInput = buildBusinessInputBlock(lead);
  const fullPrompt = `${basePrompt}\n\n${userInput}`;
  const candidates = [...new Set([config.geminiProspectorModel, config.geminiModel].filter(Boolean))];

  for (const model of candidates) {
    try {
      const html = await requestGeminiHtml(fullPrompt, model);
      if (html) {
        return { html, source: "gemini", model, promptVersion };
      }
    } catch (error) {
      runtimeError("agent", "prospector gemini generation failed", error, {
        leadId: lead.id,
        model
      });
    }
  }

  return { html: renderFallbackTemplate(lead), source: "fallback", promptVersion };
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
