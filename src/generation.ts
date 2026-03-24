import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { withState } from './store.js';
import type { Lead } from './types.js';

function safeFileName(value: string): string {
  return String(value || 'lead').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80) || 'lead';
}

/**
 * Advanced Theme Generator
 * Uses high-fidelity conversion-focused UI templates and injects lead data
 */
function renderAdvancedTheme(lead: Lead): string {
  const title = lead.company || 'Local Business';
  const phone = lead.phone || 'Call now';
  const cityState = [lead.prospectCity, lead.prospectState].filter(Boolean).join(', ');
  const category = lead.prospectIcp || 'premium local business';
  const shortSummary = (lead.prospectSummary || lead.findings || 'A premium local business homepage concept designed for conversion, trust, and stronger visibility.').slice(0, 420);
  
  // Use lead images if available, otherwise fallback
  const heroImage = lead.prospectWebsiteUri ? 'https://via.placeholder.com/1200x800' : 'https://lh3.googleusercontent.com/aida-public/AB6AXuCcqz2eGihxgf3PGc2IfYf_6L4ef6kpHO8cPGvkNCt27yc4naMOWUXPVXfvPzpcYYtmQMGSXHzxDJYIkrIXjCrtgF7tSptefhe8zKIKcWXdkHPjXNWhpxQkg2Kt0yyO6x7r8jZELcq2_h6IXwyqOn8iq01sKcabSEyPp5VZhmGK_1u5riVtLkQ0QiVdTR1dnKkVWER9KN98meOm0VtI7F8XTSX4OsJctqYCWq9wohObIouDMGys-LWsXgf7zU960FI5ihhX2PFcK_e7';
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta content="width=device-width, initial-scale=1.0" name="viewport"/>
  <title>${title} Homepage</title>
  <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Noto+Serif:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet"/>
  <style>
    body { font-family: 'Inter', sans-serif; }
    h1, h2, h3, .serif { font-family: 'Noto Serif', serif; }
  </style>
</head>
<body class="bg-surface text-on-surface">
  <nav class="fixed top-0 w-full z-50 bg-white/90 backdrop-blur-md shadow-sm">
    <div class="flex justify-between items-center w-full px-8 py-4 max-w-screen-2xl mx-auto">
      <div class="text-xl font-serif tracking-tighter text-[#516447]">${title.toUpperCase()}</div>
      <button class="bg-[#516447] text-white px-6 py-2 rounded-md text-[11px] uppercase tracking-widest">Book Now</button>
    </div>
  </nav>

  <section class="relative min-h-screen flex items-center justify-center pt-20">
    <div class="absolute inset-0 z-0">
      <img class="w-full h-full object-cover opacity-60" src="${heroImage}" alt="${title}" />
    </div>
    <div class="relative z-10 max-w-5xl mx-auto px-8 text-center">
      <h1 class="text-6xl font-headline mb-8 tracking-tight">${title}</h1>
      <p class="max-w-2xl mx-auto text-lg text-gray-700 leading-relaxed mb-12">${shortSummary}</p>
      <div class="flex flex-col md:flex-row items-center justify-center gap-6">
        <a href="tel:${phone}" class="bg-[#516447] text-white px-10 py-4 rounded-md text-xs uppercase tracking-[0.2em]">Call ${phone}</a>
      </div>
    </div>
  </section>

  <section class="py-24 bg-surface">
    <div class="max-w-7xl mx-auto px-8">
      <h2 class="text-4xl font-headline mb-12">Our Services in ${cityState}</h2>
      <p class="text-gray-600">${shortSummary}</p>
    </div>
  </section>
</body>
</html>`;
}

/**
 * Stitch Integration Placeholder
 * Integration logic for advanced AI-generated UI themes
 */
async function generateStitchTheme(lead: Lead): Promise<string> {
  // Logic to interface with Stitch MCP/SDK goes here.
  // Using advanced theme renderer with dynamic lead content injection.
  return renderAdvancedTheme(lead);
}

export async function generateReadyProspectSites(limit = 10): Promise<{ generated: number; leads: string[] }> {
  await fs.mkdir(config.generatedSitesDir, { recursive: true });
  const generated: string[] = [];
  await withState(async (state) => {
    const ready = Object.values(state.leads)
      .filter((lead) => lead.sourceFile === 'prospector-dashboard' && lead.generationStatus === 'ready')
      .slice(0, limit);

    for (const lead of ready) {
      const htmlContent = await generateStitchTheme(lead);
      const fileName = `${safeFileName(lead.company || lead.id)}-${safeFileName(lead.id)}.html`;
      const fullPath = path.resolve(config.generatedSitesDir, fileName);
      await fs.writeFile(fullPath, htmlContent, 'utf8');
      lead.generatedSitePath = fullPath;
      lead.generationStatus = 'generated';
      lead.handoffStatus = 'ready_for_review';
      lead.updatedAt = new Date().toISOString();
      generated.push(lead.id);
    }
  });
  return { generated: generated.length, leads: generated };
}
