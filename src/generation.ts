import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { withState } from './store.js';
import type { Lead } from './types.js';

function safeFileName(value: string): string {
  return String(value || 'lead').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80) || 'lead';
}

/**
 * Full Template Generator
 * Injects lead data directly into the provided Elixir MedSpa HTML structure.
 */
function renderTemplate(lead: Lead): string {
  const title = lead.company || 'Business Name';
  const city = lead.prospectCity || 'Local City';
  const summary = (lead.prospectSummary || 'A sanctuary for clinical excellence and aesthetic mastery.').slice(0, 300);

  // The full provided template structure
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<title>${title} Homepage</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&amp;family=Noto+Serif:ital,wght@0,400;0,700;1,400&amp;display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&amp;display=swap" rel="stylesheet"/>
<style>
 body { font-family: 'Inter', sans-serif; }
 h1, h2, h3, .serif { font-family: 'Noto Serif', serif; }
 .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 24; }
 .bg-hero-gradient { background: linear-gradient(135deg, rgba(81, 100, 71, 0.1) 0%, rgba(143, 163, 130, 0.05) 100%); }
 </style>
</head>
<body class="bg-surface text-on-surface">
<nav class="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-md shadow-sm">
<div class="flex justify-between items-center w-full px-8 py-4 max-w-screen-2xl mx-auto">
<div class="text-xl font-serif tracking-tighter text-[#516447]"> ${title.toUpperCase()} </div>
<div class="hidden md:flex space-x-12 items-center">
<a class="text-zinc-500 font-medium hover:text-[#8fa382] uppercase text-[10px]" href="#">Treatments</a>
<a class="text-zinc-500 font-medium hover:text-[#8fa382] uppercase text-[10px]" href="#">Gallery</a>
</div>
<div class="flex items-center space-x-6">
<button class="bg-[#516447] text-white px-6 py-2.5 rounded-md font-label text-[11px] uppercase"> Book Now </button>
</div>
</div>
</nav>
<section class="relative min-h-screen flex items-center justify-center pt-20 overflow-hidden">
<div class="absolute inset-0 z-0">
<div class="w-full h-full bg-hero-gradient"></div>
<img class="w-full h-full object-cover opacity-60 grayscale-[20%]" src="https://images.unsplash.com/photo-1519824145371-296894a0daa9?auto=format&fit=crop&q=80&w=2000" alt="Spa environment"/>
</div>
<div class="relative z-10 max-w-5xl mx-auto px-8 text-center">
<span class="font-label text-[12px] uppercase tracking-[0.3em] text-[#516447] mb-6 block font-medium">Science Meets Artistry in ${city}</span>
<h1 class="text-6xl md:text-8xl font-headline text-on-surface leading-[1.1] mb-8 tracking-tight">
 Refining the <span class="italic font-normal">Natural</span> Self
 </h1>
<p class="max-w-2xl mx-auto text-lg text-gray-700 font-body leading-relaxed mb-12">
 ${summary}
 </p>
<div class="flex flex-col md:flex-row items-center justify-center gap-6">
<button class="bg-[#516447] text-white px-10 py-4 rounded-md font-label text-xs uppercase tracking-[0.2em]"> Reserve Experience </button>
</div>
</div>
</section>
</body></html>`;
}

export async function generateReadyProspectSites(limit = 10): Promise<{ generated: number; leads: string[] }> {
  await fs.mkdir(config.generatedSitesDir, { recursive: true });
  const generated: string[] = [];
  await withState(async (state) => {
    const ready = Object.values(state.leads)
      .filter((lead) => lead.sourceFile === 'prospector-dashboard' && lead.generationStatus === 'ready')
      .slice(0, limit);

    for (const lead of ready) {
      const htmlContent = renderTemplate(lead);
      const fileName = `${safeFileName(lead.company || lead.id)}.html`;
      const fullPath = path.resolve(config.generatedSitesDir, fileName);
      await fs.writeFile(fullPath, htmlContent, 'utf8');
      lead.generatedSitePath = fullPath;
      lead.generationStatus = 'generated';
      lead.updatedAt = new Date().toISOString();
      generated.push(lead.id);
    }
  });
  return { generated: generated.length, leads: generated };
}
