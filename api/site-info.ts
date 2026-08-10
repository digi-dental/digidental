// /api/site-info — Vercel serverless function
// Public, read-only JSON summary of Digi Dental for AI agents, answer engines and
// integrations. No dependencies, no secrets, no database — safe to cache at the edge.
// Human-readable equivalent: /llms.txt   Markup equivalent: JSON-LD in the homepage <head>.

const SITE = 'https://www.digidental.us';

const siteInfo = {
  name: 'Digi Dental',
  url: SITE,
  tagline: 'Your phone rings. A patient gets booked. You never lifted a finger.',
  description:
    "A done-for-you AI receptionist for dental practices. It answers every inbound call 24/7 in a human-sounding voice, answers service and insurance questions, and writes appointments straight into the practice's calendar.",
  category: 'AI phone receptionist / answering service for dental practices',
  serves: 'Dental practice owners and office managers',
  disclaimer:
    'Digi Dental sets up the AI receptionist; it is not itself a dental practice and does not provide dental treatment or clinical advice.',

  capabilities: [
    'Answers every inbound call on the first ring, 24/7, including nights, weekends and holidays',
    'Handles multiple simultaneous calls, so no caller waits in a queue',
    "Answers service and insurance questions from the practice's own list",
    'Books, reschedules and confirms appointments directly in the calendar',
    'Reads the booked time back to the caller to confirm it',
  ],

  pricing: {
    currency: 'USD',
    setup: {
      price: 2000,
      billing: 'one-time',
      includes: [
        'Voice AI configured to your practice',
        'Google Calendar setup, appointments written directly',
        'Call scripting for your services and insurance FAQs',
        'Testing, tuning, and go-live',
      ],
    },
    carePlans: [
      { name: 'Google Calendar integration', price: 149, billing: 'monthly', optional: true },
      { name: 'Practice-management (PMS) integration', price: 299, billing: 'monthly', optional: true },
    ],
    carePlanNotes:
      'Care plans buy the ongoing service, not the integration itself: monitoring, updates and script tuning as the practice\u2019s services, insurance list and hours change. Optional, no minimum term, cancel anytime. Without a plan, Google Calendar setup is still included in the setup fee and the receptionist keeps answering.',
    usage: {
      model: 'Billed at cost on the practice’s own voice-platform account; Digi Dental takes no markup.',
      perMinuteUsd: '0.10-0.15',
      typicalMonthlyUsd: '60-150 for a practice handling ~300 answered calls',
    },
    splitStartOption:
      'On request, setup may begin with $1,000 upfront. If the receptionist books a real patient into the practice\u2019s calendar within 14 days of go-live, the remaining $1,000 becomes due, completing the standard $2,000 setup fee. If it does not, the balance is not owed.',
  },

  timeline: 'Days, not months. Most practices are live within one week of the strategy call.',
  timelineDetail:
    'Most practices are live within 7 days of the onboarding call. The 7 days start once the practice has provided its services list, insurance list and calendar access. This is a normal expectation, not a refund-backed guarantee.',
  contractTerms: 'No long-term contract. The setup fee is one-time; care plans cancel anytime.',

  compliance:
    'Call audio is handled by enterprise voice-AI infrastructure and is not shared with Digi Dental unless the practice asks for a call to be reviewed. The assistant is configured not to ask for or repeat protected health information beyond what booking an appointment requires, and the website demo is limited to 60 seconds with no patient data. Digi Dental will sign a BAA or data-processing agreement with the practice where required. No compliance certification is claimed.',

  demo: {
    available: true,
    where: `${SITE}/#demo`,
    description: 'Talk to the AI receptionist directly in the browser.',
    limitSeconds: 60,
    limit: 'One demo per visitor.',
  },

  contact: {
    bookCall: 'https://calendly.com/digidental/digi-dental-inquiry',
    whatsapp: 'https://wa.me/351912859130',
  },

  resources: {
    homepage: `${SITE}/`,
    llmsTxt: `${SITE}/llms.txt`,
    sitemap: `${SITE}/sitemap.xml`,
    robots: `${SITE}/robots.txt`,
  },

  pricesAsOf: '2026-07-24',
};

export default function handler(req: any, res: any) {
  // Open to any origin: this is public marketing data meant to be fetched by agents.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Cache at the edge for a day, serve stale for a week while revalidating.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800');
  return res.status(200).json(siteInfo);
}
