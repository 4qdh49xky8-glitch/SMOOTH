#!/usr/bin/env node
// Usage: node youtube-challenge/tracking/report.mjs [tracker.csv] [costs_usd]
// Calcule les KPI par vidéo et au total à partir du tableau de suivi. Aucune dépendance.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? join(here, 'tracker.csv');
const costs = Number(process.argv[3] ?? 0);

const [head, ...rows] = readFileSync(file, 'utf8').trim().split(/\r?\n/);
const cols = head.split(',');
const num = (v) => (v === '' || v === undefined ? 0 : Number(v));
const videos = rows
  .filter((r) => r.trim() && !r.startsWith('#'))
  .map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));

const div = (a, b) => (b > 0 ? a / b : null);
const pct = (x) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
const usd = (x) => (x === null ? '-' : `$${x.toFixed(2)}`);

const stats = (v) => ({
  views: num(v.views),
  clicks: num(v.clicks),
  leads: num(v.leads),
  sales: num(v.sales),
  revenue: num(v.revenue_usd),
});

const lines = videos.map((v) => {
  const s = stats(v);
  return {
    id: v.video_id,
    type: v.type,
    hook: v.hook,
    cta: v.cta,
    retention: num(v.avg_retention_pct),
    ...s,
    clickRate: div(s.clicks, s.views),
    leadRate: div(s.leads, s.clicks),
    saleRate: div(s.sales, s.leads),
    rpm: div(s.revenue * 1000, s.views),
    revPerLead: div(s.revenue, s.leads),
  };
});

const total = lines.reduce(
  (t, l) => ({
    views: t.views + l.views,
    clicks: t.clicks + l.clicks,
    leads: t.leads + l.leads,
    sales: t.sales + l.sales,
    revenue: t.revenue + l.revenue,
  }),
  { views: 0, clicks: 0, leads: 0, sales: 0, revenue: 0 },
);

const withRet = lines.filter((l) => l.retention > 0);
const avgRet = withRet.length ? withRet.reduce((a, l) => a + l.retention, 0) / withRet.length : 0;

console.log('video | type | vues | clics | leads | ventes | revenu | clic% | lead% | vente% | $/1000v | winner?');
for (const l of lines) {
  const winner = avgRet > 0 && l.retention >= avgRet * 1.5 ? 'RETENTION' : l.sales > 0 ? 'REVENU' : '';
  console.log(
    [l.id, l.type, l.views, l.clicks, l.leads, l.sales, usd(l.revenue), pct(l.clickRate), pct(l.leadRate), pct(l.saleRate), usd(l.rpm), winner].join(' | '),
  );
}
console.log('\nTOTAL');
console.log(`vidéos: ${lines.length}  vues: ${total.views}  clics: ${total.clicks}  leads: ${total.leads}  ventes: ${total.sales}`);
console.log(`revenu: ${usd(total.revenue)}  coûts: ${usd(costs)}  bénéfice net: ${usd(total.revenue - costs)}`);
console.log(`revenu/vidéo: ${usd(div(total.revenue, lines.length))}  revenu/lead: ${usd(div(total.revenue, total.leads))}  $/1000 vues: ${usd(div(total.revenue * 1000, total.views))}`);
console.log(`taux clic: ${pct(div(total.clicks, total.views))}  clic→lead: ${pct(div(total.leads, total.clicks))}  lead→vente: ${pct(div(total.sales, total.leads))}`);
console.log(`coût d'acquisition (coûts / ventes): ${usd(div(costs, total.sales))}`);
console.log(`objectif 500 $: ${usd(total.revenue)} (${pct(total.revenue / 500)}), écart ${usd(total.revenue - 500)}`);
