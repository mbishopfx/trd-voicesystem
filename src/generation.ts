import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { withState } from './store.js';
import type { Lead } from './types.js';

function safeFileName(value: string): string {
  return String(value || 'lead').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80) || 'lead';
}

function renderLeadHomepage(lead: Lead): string {
  const title = lead.company || 'Local Business';
  const phone = lead.phone || 'Call now';
  const cityState = [lead.prospectCity, lead.prospectState].filter(Boolean).join(', ');
  const category = lead.prospectIcp || 'premium local business';
  const shortSummary = (lead.prospectSummary || lead.findings || 'A premium local business homepage concept designed for conversion, trust, and stronger visibility.').slice(0, 420);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <meta name="description" content="${shortSummary.replace(/"/g, '&quot;')}" />
  <style>
    :root{--bg:#081120;--ink:#e5eefc;--muted:#9fb2d1;--card:#ffffff;--line:rgba(148,163,184,.18);--text:#0f172a;--soft:#f8fafc;--brand:#8b5cf6;--brand2:#06b6d4;--accent:#22c55e;--shadow:0 18px 60px rgba(2,8,23,.12)}
    *{box-sizing:border-box} body{margin:0;font-family:Inter,Arial,sans-serif;background:linear-gradient(180deg,#f8fafc,#eef2ff);color:var(--text)}
    .shell{max-width:1180px;margin:0 auto;padding:0 24px}.hero{position:relative;overflow:hidden;background:radial-gradient(circle at top left,rgba(139,92,246,.35),transparent 28%),radial-gradient(circle at 85% 10%,rgba(6,182,212,.24),transparent 22%),linear-gradient(135deg,#081120,#111c34 55%,#1e1b4b);color:var(--ink);padding:92px 0 74px}
    .hero-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:28px;align-items:center}.eyebrow{display:inline-flex;gap:10px;align-items:center;padding:8px 14px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(255,255,255,.06);color:#dbeafe;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
    h1{font-size:clamp(42px,6vw,72px);line-height:.96;margin:18px 0 18px;letter-spacing:-.04em}.lede{max-width:760px;color:#d6e2f3;font-size:18px;line-height:1.7}.actions{display:flex;flex-wrap:wrap;gap:14px;margin-top:28px}.btn{display:inline-flex;align-items:center;justify-content:center;padding:15px 22px;border-radius:999px;text-decoration:none;font-weight:800}.btn-primary{background:linear-gradient(135deg,var(--accent),#86efac);color:#052e16}.btn-secondary{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#fff}
    .hero-card{background:linear-gradient(180deg,rgba(255,255,255,.1),rgba(255,255,255,.05));border:1px solid rgba(255,255,255,.12);border-radius:28px;padding:24px;box-shadow:0 18px 50px rgba(0,0,0,.28);backdrop-filter:blur(12px)}
    .stat{display:flex;justify-content:space-between;padding:16px 0;border-bottom:1px solid rgba(255,255,255,.1)} .stat:last-child{border-bottom:none}
    .trustbar{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:-34px}.trust{background:rgba(255,255,255,.85);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.8);border-radius:20px;padding:18px;box-shadow:var(--shadow)}
    .section{padding:84px 0}.section.alt{background:rgba(255,255,255,.55);backdrop-filter:blur(6px);border-top:1px solid rgba(255,255,255,.7);border-bottom:1px solid rgba(226,232,240,.8)}
    .section-head{max-width:760px;margin-bottom:28px}.kicker{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#64748b;font-weight:800}.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.card{background:var(--card);border-radius:28px;padding:26px;border:1px solid rgba(226,232,240,.85);box-shadow:var(--shadow)}
    .service{position:relative;overflow:hidden}.service:before{content:'';position:absolute;inset:auto -40px -40px auto;width:160px;height:160px;background:radial-gradient(circle,rgba(139,92,246,.18),transparent 65%)}
    h2{font-size:32px;line-height:1.05;margin:10px 0 12px;letter-spacing:-.03em} h3{font-size:22px;margin:0 0 10px;letter-spacing:-.02em} p{margin:0;color:#475569;line-height:1.75}
    .feature-list,.faq-list{display:grid;gap:14px;margin-top:18px}.feature-item,.faq-item{padding:18px 20px;border-radius:20px;background:#fff;border:1px solid rgba(226,232,240,.9);box-shadow:0 10px 30px rgba(15,23,42,.06)}
    .cta-band{background:linear-gradient(135deg,#0f172a,#312e81);color:#fff;border-radius:32px;padding:34px;display:grid;grid-template-columns:1.2fr .8fr;gap:20px;align-items:center;box-shadow:var(--shadow)}
    .mini{font-size:13px;color:#94a3b8}.footer{padding:26px 0 60px;color:#64748b;font-size:14px}.tag{display:inline-flex;padding:8px 12px;border-radius:999px;background:#eef2ff;color:#4338ca;font-weight:700;font-size:12px;margin:0 8px 8px 0}
    @media (max-width:980px){.hero-grid,.cta-band,.trustbar,.grid-3{grid-template-columns:1fr}.trustbar{margin-top:24px}}
  </style>
</head>
<body>
  <section class="hero">
    <div class="shell hero-grid">
      <div>
        <span class="eyebrow">${cityState || 'Local Market'} · ${category}</span>
        <h1>${title}</h1>
        <p class="lede">A premium vision-site designed to show what this brand could look like with stronger positioning, modern UI, and a team that knows how to turn attention into booked conversations.</p>
        <div class="actions">
          <a class="btn btn-primary" href="tel:${phone}">Call ${phone}</a>
          <a class="btn btn-secondary" href="#consult">See the Vision</a>
        </div>
      </div>
      <div class="hero-card">
        <div class="stat"><strong>Brand Positioning</strong><span>Elevated</span></div>
        <div class="stat"><strong>Conversion Flow</strong><span>Consult-first</span></div>
        <div class="stat"><strong>Experience Style</strong><span>Premium UI</span></div>
        <div class="stat"><strong>Built For</strong><span>${cityState || 'Local Growth'}</span></div>
      </div>
    </div>
  </section>

  <section class="shell trustbar">
    <div class="trust"><strong>Premium presentation</strong><p>Cleaner first impression, clearer offer, stronger trust.</p></div>
    <div class="trust"><strong>Designed to convert</strong><p>Structured for calls, consults, and high-intent action.</p></div>
    <div class="trust"><strong>Built for local visibility</strong><p>Sharper market positioning across search and referral traffic.</p></div>
    <div class="trust"><strong>Ready for scale</strong><p>A homepage foundation a real team can expand quickly.</p></div>
  </section>

  <section class="section">
    <div class="shell">
      <div class="section-head"><div class="kicker">Why this works</div><h2>Advanced UI with a real conversion structure</h2><p>${shortSummary}</p></div>
      <div class="grid-3">
        <article class="card service"><h3>Hero that actually sells</h3><p>Clear headline, polished visual hierarchy, and immediate trust-building above the fold instead of a wall of raw text.</p></article>
        <article class="card service"><h3>Offer clarity</h3><p>The visitor immediately understands what the business does, why it matters, and how to take the next step.</p></article>
        <article class="card service"><h3>High-end visual feel</h3><p>Gradient depth, rounded containers, modern spacing, and premium card design push this well past a basic placeholder page.</p></article>
      </div>
    </div>
  </section>

  <section class="section alt">
    <div class="shell">
      <div class="section-head"><div class="kicker">Core sections</div><h2>A homepage layout a serious team can build on fast</h2><p>This vision is structured to feel credible, polished, and conversion-oriented from the first scroll.</p></div>
      <div class="grid-3">
        <article class="card"><h3>Signature Services</h3><p>Lead with 3–6 key services, each framed around buyer intent instead of generic descriptions.</p></article>
        <article class="card"><h3>Why Choose Us</h3><p>Local proof, confidence markers, and buyer reassurance that reduce hesitation before contact.</p></article>
        <article class="card"><h3>Consult CTA</h3><p>Strong contact section that directs visitors toward the most valuable next step without friction.</p></article>
      </div>
      <div class="feature-list">
        <div class="feature-item"><strong>Service Area Coverage</strong><p>${cityState || 'Primary local market'} and nearby communities.</p></div>
        <div class="feature-item"><strong>Trust Layer</strong><p>Positioning ready for reviews, before/after assets, proof points, and future AI-search optimization.</p></div>
        <div class="feature-item"><strong>Scalable Foundation</strong><p>The visual system can expand into deeper pages, booking flows, FAQs, and stronger lead capture.</p></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="shell">
      <div class="section-head"><div class="kicker">FAQ</div><h2>Answer objections before they slow the sale</h2></div>
      <div class="faq-list">
        <div class="faq-item"><strong>Is this a final site?</strong><p>No — this is a live vision of what we can create on the fly to show positioning, design quality, and conversion direction.</p></div>
        <div class="faq-item"><strong>Can this be customized further?</strong><p>Yes. A real production build would refine copy, imagery, proof points, and local SEO assets around the business.</p></div>
        <div class="faq-item"><strong>What happens next?</strong><p>If the vision feels aligned, the next step is a short conversation about polishing it into a full growth-ready site.</p></div>
      </div>
    </div>
  </section>

  <section class="shell section" id="consult">
    <div class="cta-band">
      <div>
        <div class="kicker" style="color:#c4b5fd">Next step</div>
        <h2 style="color:white">This is the kind of on-the-fly vision a serious team can turn into revenue</h2>
        <p style="color:#dbeafe">If this brand deserves a cleaner, sharper, more modern online presence, the next move is a short strategy conversation and a real execution plan.</p>
      </div>
      <div>
        <a class="btn btn-primary" href="tel:${phone}">Call ${phone}</a>
        <p class="mini" style="margin-top:14px">Vision-site generated by TRD Voice Ops for live concept demonstration.</p>
      </div>
    </div>
  </section>

  <footer class="shell footer">
    <span class="tag">Premium UI direction</span>
    <span class="tag">Conversion-focused structure</span>
    <span class="tag">Live concept build</span>
  </footer>
</body>
</html>`;
}

export async function generateReadyProspectSites(limit = 10): Promise<{ generated: number; leads: string[] }> {
  await fs.mkdir(config.generatedSitesDir, { recursive: true });
  const generated: string[] = [];
  await withState(async (state) => {
    const ready = Object.values(state.leads)
      .filter((lead) => lead.sourceFile === 'prospector-dashboard' && lead.generationStatus === 'ready')
      .slice(0, limit);

    for (const lead of ready) {
      const fileName = `${safeFileName(lead.company || lead.id)}-${safeFileName(lead.id)}.html`;
      const fullPath = path.resolve(config.generatedSitesDir, fileName);
      await fs.writeFile(fullPath, renderLeadHomepage(lead), 'utf8');
      lead.generatedSitePath = fullPath;
      lead.generationStatus = 'generated';
      lead.handoffStatus = 'ready_for_review';
      lead.updatedAt = new Date().toISOString();
      generated.push(lead.id);
    }
  });
  return { generated: generated.length, leads: generated };
}
