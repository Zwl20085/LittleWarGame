// Soak with round-7 switches (A/B): R7_OFF=hqPoint,eta,assault,counter|all npx tsx scripts/challenge/soak-ab.ts 45 7
// Sets ROUND7_AB (src/sim/homeguard.ts) in this process, then runs scripts/soak.ts unchanged.
import { ROUND7_AB } from '../../src/sim/homeguard';

const off = (process.env.R7_OFF ?? '').split(',').filter(Boolean);
for (const k of Object.keys(ROUND7_AB) as (keyof typeof ROUND7_AB)[]) if (off.includes(k) || off.includes('all')) ROUND7_AB[k] = false;
await import('../soak');
