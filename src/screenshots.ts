import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { withState } from './store.js';

const SVG_TEMPLATE = (title: string, subtitle: string) => `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1440" height="1024" viewBox="0 0 1440 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="1440" height="1024" fill="#F8FAFC"/>
  <rect x="64" y="64" width="1312" height="896" rx="32" fill="#ffffff" stroke="#E2E8F0"/>
  <rect x="64" y="64" width="1312" height="180" rx="32" fill="url(#g)"/>
  <text x="120" y="180" fill="white" font-size="54" font-family="Arial" font-weight="700">${title}</text>
  <text x="120" y="240" fill="#D1FAE5" font-size="28" font-family="Arial">${subtitle}</text>
  <rect x="120" y="320" width="360" height="220" rx="24" fill="#EEF2FF"/>
  <rect x="520" y="320" width="360" height="220" rx="24" fill="#ECFCCB"/>
  <rect x="920" y="320" width="360" height="220" rx="24" fill="#FCE7F3"/>
  <rect x="120" y="590" width="1160" height="240" rx="24" fill="#F8FAFC" stroke="#E2E8F0"/>
  <defs><linearGradient id="g" x1="64" y1="64" x2="1376" y2="244" gradientUnits="userSpaceOnUse"><stop stop-color="#0F172A"/><stop offset="1" stop-color="#7C3AED"/></linearGradient></defs>
</svg>`;

function safeFileName(value: string): string {
  return String(value || 'lead').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80) || 'lead';
}

export async function createProspectScreenshots(limit = 10): Promise<{ generated: number; leads: string[] }> {
  await fs.mkdir(config.generatedScreenshotsDir, { recursive: true });
  const done: string[] = [];
  await withState(async (state) => {
    const generated = Object.values(state.leads)
      .filter((lead) => lead.sourceFile === 'prospector-dashboard' && lead.generationStatus === 'generated' && !lead.generatedScreenshotPath)
      .slice(0, limit);

    for (const lead of generated) {
      const fileName = `${safeFileName(lead.company || lead.id)}-${safeFileName(lead.id)}.svg`;
      const fullPath = path.resolve(config.generatedScreenshotsDir, fileName);
      const cityState = [lead.prospectCity, lead.prospectState].filter(Boolean).join(', ');
      await fs.writeFile(fullPath, SVG_TEMPLATE(lead.company || 'Business Preview', `${cityState} • AI-generated homepage concept`), 'utf8');
      lead.generatedScreenshotPath = fullPath;
      lead.handoffStatus = 'ready_for_review';
      lead.updatedAt = new Date().toISOString();
      done.push(lead.id);
    }
  });
  return { generated: done.length, leads: done };
}
