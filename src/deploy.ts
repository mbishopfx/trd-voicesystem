import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withState } from './store.js';

const execFileAsync = promisify(execFile);

function safeSlug(value: string): string {
  return String(value || 'prospect-site').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/(^-|-$)/g, '').slice(0, 80) || 'prospect-site';
}

async function deployStaticFile(htmlPath: string): Promise<string> {
  const source = path.resolve(htmlPath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trd-prospect-'));
  await fs.copyFile(source, path.join(tempDir, 'index.html'));
  const projectName = safeSlug(path.basename(source, path.extname(source)));
  const { stdout, stderr } = await execFileAsync('vercel', ['deploy', '--yes', '--prod', '--name', projectName], { cwd: tempDir, env: process.env, maxBuffer: 1024 * 1024 * 8 });
  const combined = `${stdout}\n${stderr}`;
  const url = combined.split(/\s+/).find((token) => token.startsWith('https://'));
  if (!url) throw new Error(`Could not parse Vercel URL from output: ${combined}`);
  return url.trim();
}

export async function deployGeneratedProspects(limit = 10): Promise<{ deployed: number; leads: string[] }> {
  const done: string[] = [];
  await withState(async (state) => {
    const ready = Object.values(state.leads)
      .filter((lead) => lead.sourceFile === 'prospector-dashboard' && lead.generatedSitePath && !lead.deployedSiteUrl)
      .slice(0, limit);

    for (const lead of ready) {
      const url = await deployStaticFile(lead.generatedSitePath!);
      lead.deployedSiteUrl = url;
      lead.generationStatus = 'deployed';
      lead.handoffStatus = lead.handoffStatus === 'ready_for_review' ? 'ready_for_review' : lead.handoffStatus;
      lead.updatedAt = new Date().toISOString();
      done.push(lead.id);
    }
  });
  return { deployed: done.length, leads: done };
}
