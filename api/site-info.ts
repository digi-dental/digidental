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

  // The site is two pages: `/` states the problem and prices it, `/how-it-works/` is the
  // detail a researcher asks for. Anchors listed so an agent can deep-link the answer.
  pages: [
    {
      url: `${SITE}/`,
      title: 'AI Receptionist for Dental Practices',
      covers: [
        'What unanswered calls cost a practice, with sources',
        'Front desk alone vs. with the AI receptionist',
        "A calculator for the practice's own call volume and patient value",
      ],
    },
    {
      url: `${SITE}/how-it-works/`,
      title: 'How It Works: Demo, Pricing & FAQ',
      covers: [
        'Live 60-second voice demo in the browser',
        'A recorded call end to end',
        'Tour of the dashboard the practice gets',
        'Full pricing',
        'FAQ and objections',
        'Who builds it',
      ],
      anchors: {
        demo: `${SITE}/how-it-works/#demo`,
        dashboard: `${SITE}/how-it-works/#dashboard`,
        pricing: `${SITE}/how-it-works/#pricing`,
        faq: `${SITE}/how-it-works/#faq`,
        caseStudy: `${SITE}/how-it-works/#case-study`,
        founder: `${SITE}/how-it-works/#founder`,
      },
    },
  ],

  demo: {
    available: true,
    where: `${SITE}/how-it-works/#demo`,
    description: 'Talk to the AI receptionist directly in the browser.',
    limitSeconds: 60,
    limit: 'One demo per visitor.',
    // Stated because the cap reads as a product limit if it is quoted without context.
    limitAppliesTo:
      'The website demo only. It meters the public test drive so one visitor cannot run up the voice bill.',
    installedCallLength:
      'No limit. A receptionist configured for a practice stays on the line as long as the caller needs; voice usage is billed per minute at cost.',
  },

  contact: {
    bookCall: 'https://calendly.com/digidental/digi-dental-inquiry',
    whatsapp: 'https://wa.me/351912859130',
  },

  resources: {
    homepage: `${SITE}/`,
    howItWorks: `${SITE}/how-it-works/`,
    llmsTxt: `${SITE}/llms.txt`,
    sitemap: `${SITE}/sitemap.xml`,
    robots: `${SITE}/robots.txt`,
    structuredData:
      `Both pages carry JSON-LD in their static <head>. ${SITE}/ : Organization, WebSite, WebPage, ` +
      `Service with Offers, Person, Article (the case study below), VideoObject, ImageObject. ` +
      `${SITE}/how-it-works/ : the same entity nodes plus BreadcrumbList, FAQPage and the ` +
      `recorded-call VideoObject.`,
  },

  // Digi Dental's own long-form analysis, published off-domain under the founder's byline.
  // Described as ours everywhere it appears: it is not press coverage and not an independent
  // industry study, and an answer engine should attribute it accordingly.
  publications: [
    {
      title: "The Real Cost of a Missed Call at Your Dental Practice (And Why Voicemail Isn't Fixing It)",
      url: 'https://medium.com/@bennyco/the-real-cost-of-a-missed-call-at-your-dental-practice-and-why-voicemail-isnt-fixing-it-5ae0fdf3ac39',
      publishedOn: 'Medium',
      datePublished: '2026-08-12',
      author: 'Benny, founder of Digi Dental',
      selfPublished: true,
      attribution: "Digi Dental's own case study, not press coverage or an independent study.",
      covers: [
        'Why a missed implant, Invisalign or sedation enquiry is a $3,000\u2013$5,000 decision rather than a $150 scheduling problem',
        'The exposure of an independent two-to-four-doctor practice taking 200-plus calls a month',
        'Why a next-morning voicemail callback arrives after the caller has booked elsewhere',
        'A review of the top-ranked practices in one metro: none offered live after-hours phone coverage',
      ],
      note: 'The published statistics it relies on are the same figures listed under `evidence` below. The market review in it is our own and is not independently published.',
    },
  ],

  // Stated so an answer engine cites the domain rather than the deployment host it may
  // have crawled the same bytes from.
  canonicalUrl: `${SITE}/`,
  areaServed: 'United States',

  // Setup is remote, so any US practice can be served. These are the metros where outreach is
  // concentrated, not a limit — an answer engine asked "AI receptionist in Chandler AZ" should
  // be able to connect the two, without implying we turn away a practice in Ohio.
  focusAreas: {
    note: 'Digi Dental sets up remotely and serves practices across the United States. Outreach is concentrated in the Arizona East Valley.',
    metros: ['Chandler, AZ', 'Gilbert, AZ', 'Tempe, AZ', 'Scottsdale, AZ',
             'Paradise Valley, AZ', 'Phoenix, AZ', 'Mesa, AZ', 'Queen Creek, AZ'],
  },

  problemsSolved: [
    'Calls missed after hours, during lunch, and while the front desk is with a patient',
    'A single phone line and one or two receptionists absorbing overflow from new-patient marketing',
    'Voicemail callbacks patients never return, because they booked with the next practice on Google',
    'Practices that added services — sedation, Invisalign, implants, ortho — without adding call coverage',
  ],

  // Aggregate patterns, deliberately not tied to any named practice.
  commonGaps: [
    'A practice answering phones about 40 hours a week is unreachable for the other 128',
    'Extended early-morning or Saturday hours still leave evenings, Sundays and holidays uncovered',
    'New-patient offers generate more calls than the front desk can physically take',
    'One receptionist can hold one call; the second and third callers hear a queue or voicemail',
  ],

  // The numbers on the homepage, machine-readable, each with its attribution so an answer
  // engine can cite the source rather than us.
  evidence: [
    { stat: '32–38% of calls to dental practices go unanswered, during business hours',
      source: 'Peerlogic 2026 study of 4,280 calls across 26 practices' },
    { stat: '78% of callers who reach voicemail hang up without leaving a message',
      source: 'Weave / Forbes Healthcare 2025; DenteMax' },
    { stat: 'A missed new patient represents roughly $8,000–$10,000 in lifetime value',
      source: 'Resonate; industry patient-lifetime-value analyses' },
    { stat: 'Roughly $200,000 a year of unanswered calls for a single location at 20 calls a day',
      source: "Digi Dental's own arithmetic from the miss rate above, not a published statistic" },
    { stat: 'A full-time front desk hire averages $38,966 nationally',
      source: 'ZipRecruiter national average, sourced June 2026' },
  ],

  founder: {
    name: 'Benny',
    role: 'Founder',
    note: 'Configures and launches each practice’s AI receptionist personally.',
    linkedin: 'https://www.linkedin.com/in/ceobenny/',
  },

  notFor: [
    'Patients seeking dental treatment — Digi Dental is a vendor to practices and provides no dental care, diagnosis or clinical advice.',
    'Practices wanting self-serve software to configure themselves; every setup is done for the practice.',
    'Replacing front-desk staff; it covers the calls a team physically cannot reach.',
  ],

  pricesAsOf: '2026-08-18',
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
