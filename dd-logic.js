/* =============================================================================
   Digi Dental — the page logic, shared by both pages of the site.

   The site is two documents: `/` raises a hand (hero, the cost of missed calls,
   before/after, the calculator, one CTA) and `/how-it-works/` is the deep dive
   for researchers (live demo, dashboard tour, pricing, FAQ, founder, final CTA).
   There is no build step here, so "shared" has to mean one real file: this one.
   Both pages load it and their `<script data-dc-script>` is a single line —

       const Component = DDLogic.create(DCLogic);

   — which is exactly why the FAQ text, the pricing numbers, the booking flow and
   the legal copy cannot drift between the two pages. They only exist here.

   Page-specific behaviour keys off `document.documentElement.dataset.page`
   ('home' | 'deep'), read once into this.PAGE. Everything else is written to
   no-op when the elements it drives are not in the document, because the same
   class mounts against two different templates.

   The class is handed the runtime's DCLogic base as an argument rather than
   extending a global: the runtime evaluates the page's dc-script with
   `new Function('DCLogic', ...)`, so DCLogic is a parameter there, not a global.
   ============================================================================= */
(function () {
  'use strict';

  window.DDLogic = {
    create: function (DCLogic) {
      return (
class extends DCLogic {
  state = {
    heroPhase: 0, heroIdx: 0,
    scrolled: false, showSticky: false, navOpen: false,
    calcSize: '1', calcCalls: '20', calcValue: '850', faqOpen: -1,
    modal: null, // null | 'booking' | 'privacy' | 'terms' | 'exit'
    step: 0, bName: '', bPractice: '', bCountry: '', bVolume: '', bLocations: '', bEmail: '', bPhone: '',
    founderPhotoOk: false, // flipped true only once uploads/profile.jpg has actually loaded
    bWebsite: '', // honeypot — must stay empty; anything in it means a bot filled the form
    formError: '', shake: false,
    toothy: 'idle', // idle | connecting | live | ended | limited
    remaining: 60, bubble: '', demoUsed: false, sendState: null,
    // Voice demo plumbing. `starting` disables the button between the click and the first state
    // change; `micState` drives the permission panel; `micWarn` is the "we cannot hear you" hint.
    dashActive: 0, // which dashboard screenshot is expanded
    starting: false, micState: 'unknown', // unknown | granted | denied | error
    micWarn: false, micDeviceId: null
  };

  // Which of the two documents this instance is driving, from <html data-page="...">.
  // Anything unrecognised is treated as the deep page, because that template is the
  // superset: a missing section costs nothing, a missing behaviour would.
  PAGE = (() => {
    try { return document.documentElement.getAttribute('data-page') === 'home' ? 'home' : 'deep'; }
    catch (e) { return 'deep'; }
  })();

  // Where the live demo, the pricing card and the FAQ actually live. Every "hear it"
  // control routes through scrollToEl(), which scrolls when the anchor is in this
  // document and navigates here when it is not — so no CTA can dead-end on an anchor
  // that moved to the other page.
  DEEP_URL = '/how-it-works/';

  // Diagnostics are development-only: localhost, a Vercel preview URL, or ?debug=1 on the page.
  // Production visitors never see voice logging in their console.
  DEV = (() => {
    try {
      return /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ||
             /vercel\.app$/.test(location.hostname) && /-git-|-[a-z0-9]{9}-/.test(location.hostname) ||
             new URLSearchParams(location.search).get('debug') === '1';
    } catch (e) { return false; }
  })();

  // The practice owner's console, as four real captures. Served through /api/image so the page
  // carries no expiring Supabase token; see api/image.ts.
  DASH_SHOTS = [
    { id: 'dash-metrics', title: 'Call volume', note: 'How many calls came in, when they came in, and how they ended.' },
    { id: 'dash-call', title: 'A single call', note: 'The full transcript and recording of one conversation, start to finish.' },
    { id: 'dash-logs', title: 'Call log', note: 'Every call the receptionist has taken, searchable, with its outcome.' },
    { id: 'dash-assistant', title: 'Your setup', note: 'Exactly how your receptionist is configured, in plain view.' }
  ];

  // Real customer quotes only — see the SOCIAL PROOF SLOT comment in the markup. While this is
  // empty the section does not render at all, which is the correct state until a practice
  // agrees to be quoted. Add entries as { quote, name, practice }.
  SOCIAL_PROOF = [];

  CALLERS = [
    { tag: 'New patient, 7:42 PM, after hours', l1: '\u201CHi, I chipped a tooth at dinner. Can I get in tomorrow?\u201D', l2: '\u201CDr. Patel has 2:00 PM Tuesday open. Shall I book it?\u201D', booked: 'Booked: Tuesday 2:00 PM', cap: 'Booked while the office was closed.' },
    { tag: 'New patient, 12:15 PM, lunch rush', l1: '\u201CDo you take Delta Dental? I need a cleaning.\u201D', l2: '\u201CWe do. Thursday 10:30 AM is available. Shall I book it?\u201D', booked: 'Booked: Thursday 10:30 AM', cap: 'Booked while the line was busy.' },
    { tag: 'New patient, 9:03 PM, Sunday', l1: '\u201CMy crown came off. How soon can someone see me?\u201D', l2: '\u201CMonday 8:00 AM, first slot. Shall I book it?\u201D', booked: 'Booked: Monday 8:00 AM', cap: 'Booked before the week began.' }
  ];

  // Denty sprite frames (user-provided pixel art in uploads/)
  FRAMES = {
    neutral: 'uploads/denty_neutral.png',
    half: 'uploads/denty_half_mouth_yap.png',
    full: 'uploads/denty_full_mouth_yap.png',
    happy: 'uploads/denty_happy.png'
  };
  YAP_CYCLE = ['neutral', 'half', 'full', 'half'];

  // Direct-to-Supabase fallback for static hosting (RLS insert-only policy required on `leads`).
  // BUG-9 / VERIFY (Benny): this is a new-style publishable key, which really is this short —
  // the `sb_publishable_<random>` format replaced the long legacy JWT anon key, so its length
  // is not evidence of truncation. It still needs one live check, because if it is wrong the
  // browser fallback fails silently and leads only ever arrive through /api/notify-lead:
  //   curl -i "https://hctpvnqanwhxlmpmfmme.supabase.co/rest/v1/leads?select=id&limit=1" \
  //     -H "apikey: <key>" -H "Authorization: Bearer <key>"
  // 401 "Invalid API key" = wrong key, replace it from Supabase → Settings → API Keys.
  // 403 / permission denied = key is valid and RLS is doing its job (reads blocked, inserts allowed).
  SUPABASE_URL = 'https://hctpvnqanwhxlmpmfmme.supabase.co';
  SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_MWPe84PkAw7Zo1T_MMvlFg_ppAOL';

  // ---- Legal copy -------------------------------------------------------------------
  // Both pages carry the privacy and terms dialogs in their footer, and two hand-written
  // copies of a legal document is how a site ends up promising different things on
  // different URLs. The paragraphs live here and both templates loop over them.
  //
  // LEGAL REVIEW REQUIRED (Benny): this is final, non-placeholder copy written to be honest
  // and to claim no certification of any kind. It has NOT been reviewed by a lawyer. Before
  // treating it as final, have counsel check the subprocessor list against your actual
  // vendors, whether you need CCPA/GDPR-specific sections, and governing law / entity name
  // (deliberately left out here rather than invented).
  //
  // The Terms state two commercial promises you must be willing to honour exactly as
  // written: the split start ($1,000 up front, the second $1,000 due only if a real patient
  // is booked within 14 days of go-live) and the go-live timeline (stated as a normal
  // expectation, with no refund remedy, because that promise was never confirmed). The same
  // wording appears in the pricing section, llms.txt and api/site-info.ts — change all
  // four together.
  LEGAL = {
    privacyNote: 'Last updated 6 August 2026. Digi Dental is a business-to-business service for dental practices. If you are a patient of a practice that uses Digi Dental, contact that practice directly about your records, as we do not hold them.',
    privacy: [
      { term: 'What we collect.', text: "What you type into the form on this page: your name, practice name, email, phone, country, rough monthly call volume, and number of locations. Nothing more, and nothing you haven't typed." },
      { term: 'Demo calls.', text: "The in-browser demo is a live call: your microphone audio is streamed to the third-party voice-AI platform that powers the conversation, processed there under that platform's own security and data-processing terms, and used to generate the assistant's replies. Demo calls are capped at 60 seconds. Please don't share patient, health, or payment information during the demo. The assistant is not configured to receive it, and neither are we." },
      { term: 'Demo limits and your IP address.', text: 'The free demo is one per visitor. To enforce that without keeping a record of who you are, we store a one-way salted hash of your IP address, never the address itself, and the hash cannot be reversed back into an IP.' },
      { term: 'Usage measurement.', text: 'We record anonymous events about how this page is used: for example that a demo was started, that a section was viewed, or which button was clicked, together with a coarse timestamp. To count returning visits without knowing who you are, your browser stores a random first-party identifier. It is a random string, it holds no name or email, it is never shared with anyone and it is never used for advertising. Clearing your browser storage removes it. These events carry no advertising identifier and no third-party tracker, and are used only to understand which parts of the page work.' },
      { term: 'Who else touches it.', text: 'We use a small number of established service providers to run this: a voice-AI platform (live call audio), a hosted database (your form details and usage events), an email delivery service (so your enquiry reaches our inbox), a hosting provider (serving this page), and a scheduling tool (booking your strategy call). Each processes data only to provide its part of the service. We do not sell your information, we do not share it for advertising, and we run no advertising trackers on this page.' },
      { term: 'How long we keep it.', text: "Enquiry details are kept while we're in touch and for as long as we may need them to answer you. Ask us to delete them and we delete them." },
      { term: 'Your choices.', text: 'Email us to see what we hold, correct it, or have it deleted. One message is enough, and there is no form to fill in.' },
      { term: 'Working with your practice.', text: "When we set up a receptionist for a practice, how call data is handled is agreed in writing with that practice before go-live, including a BAA or data-processing agreement where the practice requires one. This page's policy covers this website and its demo only." }
    ],
    termsNote: "Last updated 6 August 2026. These terms cover the setup service sold on this site. Anything agreed in writing with your practice takes precedence over what's here.",
    terms: [
      { term: 'What the setup fee covers.', text: '$2,000, one-time: the voice assistant configured to your practice, Google Calendar setup so appointments are written directly, call scripting for your services and insurance list, and testing, tuning and go-live. One practice location unless we agree otherwise in writing.' },
      { term: 'Split start.', text: 'On request, setup begins with $1,000. If the receptionist books a real patient appointment into your calendar within 14 days of go-live, the remaining $1,000 falls due, completing the standard $2,000 setup fee. If it does not, the balance is not owed.' },
      { term: 'Go-live timeline.', text: "Your receptionist is normally live within 7 days of the onboarding call. The 7 days start once we have what we need from you: your services list, your insurance list, and calendar access. Delays caused by waiting on those, or by a third party we don't control (your phone carrier or practice-management vendor), pause the clock, and we'll tell you in writing when that happens and why." },
      { term: 'Usage.', text: "Voice-AI usage is billed at cost on the practice's own platform account, typically $0.10–$0.15 per minute of live conversation. Digi Dental applies no markup and never bills you for usage." },
      { term: 'Care plans.', text: 'Ongoing care plans ($149/month for Google Calendar integration, $299/month for practice-management integration) cover monitoring, updates, and ongoing script refinement. Optional, no minimum term, cancel anytime effective at the end of the current billing month. Without a plan, Google Calendar setup remains included in the setup fee and the receptionist keeps running, we simply stop actively tuning it.' },
      { term: 'What we need from you.', text: 'Accurate service and insurance information, calendar access, and a named person who can approve the script. The assistant answers from what you give us; if the underlying information is wrong, its answers will be too.' },
      { term: 'What this is not.', text: 'Digi Dental sets up an AI receptionist. It is not a dental practice, gives no clinical or diagnostic advice, and is not an emergency service. Your scripts must direct urgent callers to appropriate care, and the practice remains responsible for the clinical and regulatory side of every patient interaction.' },
      { term: 'Availability.', text: "The receptionist runs on third-party voice and telephony infrastructure. We monitor it and fix what we can, but we can't guarantee those platforms never have an outage, and the practice should keep its existing phone path in place as a fallback." },
      { term: 'Changes.', text: 'Prices and terms on this page can change for new customers at any time. What was agreed with you when you paid is what applies to you.' }
    ]
  };
  // The one piece of Digi Dental writing that lives off this domain. It is our own
  // long-form case study, published on Medium under the founder's byline — not press,
  // not a third-party study, and it is described that way everywhere it appears. It
  // earns its place in the SEO/AEO surface because it is a second indexable document
  // making the same claims with the same numbers, which is what an answer engine
  // corroborates against. Referenced by both pages' JSON-LD, llms.txt and
  // /api/site-info, so the URL and title live in exactly one place.
  CASE_STUDY = {
    url: 'https://medium.com/@bennyco/the-real-cost-of-a-missed-call-at-your-dental-practice-and-why-voicemail-isnt-fixing-it-5ae0fdf3ac39',
    title: "The Real Cost of a Missed Call at Your Dental Practice (And Why Voicemail Isn't Fixing It)",
    author: 'Benny',
    published: '2026-08-12',
    where: 'Medium'
  };
  CALENDLY_URL = 'https://calendly.com/digidental/digi-dental-inquiry';
  // Served through /api/image so the page never carries the Supabase signed token, which expires
  // 2027-08-10. If uploads/profile.jpg is ever committed, point this back at it and the route
  // stops mattering. The monogram remains the fallback if the image fails to load.
  FOUNDER_PHOTO = '/api/image?name=profile';

  // Analytics (BUG-12). Events always go first-party to /api/event. Plausible and GA4 are
  // optional extras: set PLAUSIBLE_DOMAIN to the live domain to load Plausible automatically,
  // or drop a GA4 gtag snippet in and every event below mirrors to it with no further wiring.
  PLAUSIBLE_DOMAIN = '';

  // Cheap bot deterrent for /api/notify-lead (BUG-7): the page knows this string, a drive-by
  // curl does not. Enforced only when SITE_TOKEN is set on the server, so it can never lock
  // real leads out by accident. Rotate both sides together.
  SITE_TOKEN = 'dd-site-2026';

  // Vapi voice agent. PUBLIC web key — safe in the browser. In the Vite build these come from
  // import.meta.env.VITE_VAPI_PUBLIC_KEY / VITE_VAPI_ASSISTANT_ID (.env, gitignored); this static
  // build inlines them since there is no bundler to substitute import.meta.env.
  VAPI_PUBLIC_KEY = 'fd2dddbc-3c7d-4eed-9cea-cf4fc9828d9f';
  VAPI_ASSISTANT_ID = 'e3c3d544-3023-4725-bc7a-cbe78b35d36c';

  componentDidMount() {
    this._timers = [];
    this.initAnalytics();
    if (this.PAGE === 'deep') {
      // The yap frames only ever animate on the demo page. Preloading them on the home
      // page would spend ~50KB of its budget on sprites it never draws.
      Object.values(this.FRAMES).forEach(src => { const im = new Image(); im.src = src; });
      // Founder portrait: probed in JS so a missing file never renders a broken image, and never
      // fires a request during the raw-HTML pass. Drop the photo at uploads/profile.jpg.
      const fp = new Image();
      fp.onload = () => this.setState({ founderPhotoOk: true });
      fp.src = this.FOUNDER_PHOTO;
    }

    this._mq = window.matchMedia('(prefers-reduced-motion: reduce)'); // useReducedMotion equivalent, live-updating
    this._reduced = this._mq.matches;
    this._onMq = e => { this._reduced = e.matches; if (e.matches) clearInterval(this._yapTimer); this.forceUpdate(); };
    if (this._mq.addEventListener) this._mq.addEventListener('change', this._onMq);
    const heroReady = () => { if (!this.state.heroReady) this.setState({ heroReady: true }); };
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(heroReady);
    this._timers.push(setTimeout(heroReady, 1200)); // cap: never skeleton longer than 1.2s
    this._demoTotal = this.props.demoSeconds ?? 60;
    this.setState({ demoUsed: !!localStorage.getItem('dd_demo_used'), formDone: !!localStorage.getItem('dd_form_done'), remaining: this._demoTotal });
    if (this.PAGE === 'home') this.cycleHero();
    this._onScroll = () => {
      const y = window.scrollY;
      const scrolled = y > 60;
      const showSticky = window.innerWidth < 768 && y > window.innerHeight * 0.9 && !this.state.modal && this.state.toothy !== 'live' && this.state.toothy !== 'connecting';
      if (scrolled !== this.state.scrolled || showSticky !== this.state.showSticky) this.setState({ scrolled, showSticky });
    };
    window.addEventListener('scroll', this._onScroll, { passive: true });
    this._onKey = (e) => {
      if (e.key === 'Escape' && this.state.navOpen) { this.setState({ navOpen: false }); return; }
      if (e.key === 'Escape' && this.state.modal) { this.setState({ modal: null }); return; }
      // Focus trap (react-focus-lock equivalent): Tab cycles inside the open dialog
      if (e.key === 'Tab' && this.state.modal) {
        const d = document.querySelector('[role="dialog"]');
        if (!d) return;
        const f = Array.from(d.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')).filter(el => !el.disabled && el.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || !d.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !d.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', this._onKey);
    // Exit intent — desktop only, once per session (tweakable via exitIntent prop)
    this._onMouseOut = (e) => {
      if ((this.props.exitIntent ?? true) && !e.relatedTarget && e.clientY <= 0 && window.innerWidth >= 1024 &&
          !sessionStorage.getItem('dd_exit_shown') && !this.state.modal) {
        sessionStorage.setItem('dd_exit_shown', '1');
        this.setState({ modal: 'exit' });
        this.track('exit_intent_shown');
        this.notifyLead('exit_intent'); // row in Supabase; no owner email unless they left contact details
      }
    };
    document.addEventListener('mouseout', this._onMouseOut);
    // Scroll reveals (fade + 16px rise, once)
    if (!this._reduced && 'IntersectionObserver' in window) {
      // Staggered child reveal: each block's children rise, de-blur, and settle in sequence
      const els = document.querySelectorAll('[data-reveal]');
      const ease = 'cubic-bezier(.22,1,.36,1)';
      els.forEach(el => Array.from(el.children).forEach((ch, i) => {
        ch.style.opacity = '0';
        ch.style.transform = 'translateY(28px) scale(.96)';
        ch.style.filter = 'blur(8px)';
        ch.style.transition = `opacity .9s ${ease} ${i * 0.14}s, transform .9s ${ease} ${i * 0.14}s, filter .9s ${ease} ${i * 0.14}s`;
      }));
      this._rio = new IntersectionObserver(es => es.forEach(en => {
        if (en.isIntersecting) {
          Array.from(en.target.children).forEach(ch => { ch.style.opacity = '1'; ch.style.transform = 'none'; ch.style.filter = 'none'; });
          this._rio.unobserve(en.target);
        }
      }), { threshold: 0.2 });
      els.forEach(el => this._rio.observe(el));
    }
    // Count-up statistics
    const counts = document.querySelectorAll('[data-count]');
    if ('IntersectionObserver' in window) {
      this._cio = new IntersectionObserver(es => es.forEach(en => {
        if (en.isIntersecting) { this._cio.unobserve(en.target); this.animateCount(en.target); }
      }), { threshold: 0.6 });
      counts.forEach(el => this._cio.observe(el));
    }
    // Toothy idle bubble after 3s in view
    if ('IntersectionObserver' in window) {
      const t = document.querySelector('[data-toothy]');
      if (t) {
        this._tio = new IntersectionObserver(es => es.forEach(en => {
          if (en.isIntersecting) {
            this._tio.unobserve(en.target);
            this._timers.push(setTimeout(() => {
              if (this.state.toothy === 'idle' && !this.state.bubble) {
                this.setState({ bubble: this.state.demoUsed ? "You've had your free call. Want one answering your practice's phone?" : 'Click me. Talk to the actual AI receptionist. 60 seconds, free.' });
              }
            }, 3000));
          }
        }), { threshold: 0.5 });
        this._tio.observe(t);
      }
    }
    if (window.matchMedia && window.matchMedia('(hover:hover)').matches) this.initLinkPreviews();
    // Handle for the automated voice-call tests, which drive the real component rather than a
    // re-implementation of it. Harmless in production: it exposes no keys and no visitor data.
    try { window.__ddRoot = this; } catch (e) {}

    // The SDK is an ES module, so it may already be present or still loading. Cover both, and
    // build the client exactly once for the lifetime of the page (see initVapi). Only the deep
    // page loads the SDK at all, so on the home page this whole branch is skipped.
    if (this.PAGE !== 'deep') return;
    if (window.DentyVapiCtor) this.initVapi();
    else {
      this._onVapiReady = () => this.initVapi();
      window.addEventListener('denty-vapi-ready', this._onVapiReady, { once: true });
      // If the CDN never answers, the demo quietly falls back to the simulated call.
      this._timers.push(setTimeout(() => {
        if (!this._vapi) this.vlog('SDK did not load within 20s; demo will simulate.');
      }, 20000));
    }
  }

  // Development-only diagnostics. Nothing here may carry personal data: no transcripts, no audio,
  // no keys, no visitor identifiers — only configuration state, device labels and lifecycle.
  vlog() {
    if (!this.DEV) return;
    try { console.log.apply(console, ['[denty-voice]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }

  // Is the assistant actually configured? A blank, placeholder or malformed id must never reach
  // start(): the SDK's assistant argument is optional, so start(undefined) happily creates a call
  // with no assistant attached — which is precisely the "call exists, no assistant, no transcript"
  // symptom. Vapi ids are UUIDs, so the shape is worth checking before we spend a call on it.
  vapiConfigError() {
    const key = String(this.VAPI_PUBLIC_KEY || '').trim();
    const id = String(this.VAPI_ASSISTANT_ID || '').trim();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!key || /^(your|xxx|placeholder)/i.test(key)) return 'The voice demo is not configured yet (missing public key).';
    if (!id || /^(your|xxx|placeholder)/i.test(id)) return 'The voice demo is not configured yet (missing assistant).';
    if (!uuid.test(id)) return 'The voice demo is misconfigured (the assistant id is not valid).';
    return null;
  }

  // One client per page. Recreating it mid-connection is a known way to lose the microphone
  // track, so this runs once and the instance is never torn down between calls.
  initVapi() {
    if (this._vapi || this._vapiInit) return;
    const configError = this.vapiConfigError();
    if (configError) { this.vlog('not initialising:', configError); return; }
    this._vapiInit = true;
    try {
      // alwaysIncludeMicInPermissionPrompt keeps the mic in the browser prompt even when the
      // call starts muted, so a visitor cannot end up connected with no input track.
      this._vapi = new window.DentyVapiCtor(this.VAPI_PUBLIC_KEY, undefined,
        { alwaysIncludeMicInPermissionPrompt: true });
      this.vlog('client ready · assistant configured:', true);

      // Listeners are attached here and only here. Retrying a failed call reuses this same
      // instance, so handlers can never stack up and fire twice.
      this._vapi.on('call-start', () => { this._vapiLive = true; this.goLive(); });
      this._vapi.on('call-end', () => {
        this._vapiLive = false;
        this.releaseMic();
        if (this.state.toothy === 'live' || this.state.toothy === 'connecting') { clearInterval(this._callTimer); this.finishDemo(); }
      });
      this._vapi.on('error', e => {
        this._vapiLive = false;
        this.vlog('sdk error:', e && (e.errorMsg || e.message || e));
        this.failCall("Couldn't connect the call. Please try again.");
      });
      // Lifecycle detail the old wrapper never exposed. Invaluable when a call dies at a
      // specific stage rather than failing outright.
      this._vapi.on('call-start-progress', ev => this.vlog('start progress:', ev && ev.stage, ev && ev.status));
      this._vapi.on('call-start-success', ev => this.vlog('start success in', ev && ev.totalDuration, 'ms'));
      this._vapi.on('call-start-failed', ev => {
        this.vlog('start FAILED at stage:', ev && ev.stage, ev && ev.error);
        this.failCall("Couldn't start the call. Please try again.");
      });
    } catch (e) {
      this._vapiInit = false;
      console.error('Voice SDK init failed; the demo will simulate instead:', e);
    }
  }

  // Ask for the microphone explicitly, before the call, and inspect what we actually got.
  // Doing this ourselves (rather than letting the SDK trigger it mid-connect) means a denial or a
  // dead device is a clear message instead of a call that connects and hears silence.
  ensureMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.resolve({ ok: false, reason: 'unsupported',
        message: 'This browser cannot access a microphone. Try Chrome, Edge or Safari.' });
    }
    // Reuse a live track rather than opening a second one: two streams on one device is how you
    // get NotReadableError on Windows.
    if (this._micStream) {
      const t = this._micStream.getAudioTracks()[0];
      if (t && t.readyState === 'live' && t.enabled) return Promise.resolve({ ok: true, reused: true });
      this.releaseMic();
    }
    const constraints = { audio: this.state.micDeviceId
      ? { deviceId: { exact: this.state.micDeviceId }, echoCancellation: true, noiseSuppression: true }
      : { echoCancellation: true, noiseSuppression: true }, video: false };

    return navigator.mediaDevices.getUserMedia(constraints).then(stream => {
      this._micStream = stream;
      const track = stream.getAudioTracks()[0];
      if (!track) return { ok: false, reason: 'no-track', message: 'No microphone input was found.' };
      this.vlog('mic granted ·', track.label || '(unnamed device)',
        '· readyState:', track.readyState, '· enabled:', track.enabled, '· muted:', track.muted);
      // A track that arrives already ended or disabled will produce a connected call with no
      // audio, which is the exact Vapi error being investigated.
      if (track.readyState !== 'live' || !track.enabled) {
        return { ok: false, reason: 'inactive',
          message: 'Your microphone is not active. Close other apps using it and try again.' };
      }
      if (track.muted) {
        // `muted` here is the browser telling us the source is not delivering data — usually the
        // OS has it muted. Warn, but let the call proceed; it can recover mid-call.
        this.vlog('WARNING: track reports muted — the OS may have the input muted.');
      }
      this.setState({ micState: 'granted' });
      return { ok: true, track };
    }).catch(err => {
      const name = (err && err.name) || '';
      this.vlog('getUserMedia failed:', name);
      this.setState({ micState: name === 'NotAllowedError' ? 'denied' : 'error' });
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return { ok: false, reason: 'denied',
          message: 'Microphone access is blocked. Allow it for this site, then try again.' };
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        return { ok: false, reason: 'missing',
          message: 'No microphone was found. Plug one in or pick another input, then try again.' };
      }
      if (name === 'NotReadableError' || name === 'AbortError') {
        return { ok: false, reason: 'busy',
          message: 'Your microphone is in use by another app. Close it and try again.' };
      }
      return { ok: false, reason: 'unknown', message: 'Could not access the microphone. Please try again.' };
    });
  }

  // Tracks are released only once a call is genuinely over. Stopping them during setup is another
  // way to hand the SDK a dead device.
  releaseMic() {
    if (!this._micStream) return;
    try { this._micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    this._micStream = null;
    this.vlog('microphone released');
  }

  // One place to unwind a failed attempt, so every failure path leaves identical state and the
  // next click starts genuinely clean.
  failCall(message) {
    if (this.state.toothy !== 'connecting' && this.state.toothy !== 'live') return;
    clearInterval(this._callTimer); clearInterval(this._yapTimer); clearInterval(this._silenceTimer);
    this._claimed = false; // an attempt that never connected must not burn the free demo
    this.releaseMic();
    this.setState({ toothy: 'idle', starting: false, bubble: message });
    this.track('demo_error', { stage: this.state.toothy });
  }

  // ---- Instrumentation (BUG-12) ----
  // One funnel, one taxonomy, three sinks. /api/event is first-party and always on (no cookies,
  // no personal data — an anonymous per-tab id so steps of the same visit can be joined).
  // Plausible and GA4 mirror the same events automatically if either is present.
  initAnalytics() {
    // Identity is three separate things, and conflating them is what made the old numbers wrong:
    //   visitor_id  persistent, anonymous, localStorage. Counts PEOPLE and survives tabs.
    //   session_id  one visit, sessionStorage, with a 30-minute idle rollover so a visit
    //               interrupted by lunch counts as two sessions instead of one six-hour outlier.
    //   ip_hash     server-side only, for abuse control. Never identity: IPs rotate on mobile
    //               networks and are shared across an office.
    // Both ids are random, carry no personal data, and are never sent anywhere but this site.
    const rid = () => (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      this._vid = localStorage.getItem('dd_vid');
      if (!this._vid) { this._vid = rid(); localStorage.setItem('dd_vid', this._vid); }
    } catch (e) { this._vid = null; } // storage blocked: fall back to session-only identity
    try {
      const IDLE_MS = 30 * 60 * 1000;
      const last = parseInt(sessionStorage.getItem('dd_sid_at') || '0', 10);
      this._sid = sessionStorage.getItem('dd_sid');
      if (!this._sid || !last || (Date.now() - last) > IDLE_MS) this._sid = rid();
      sessionStorage.setItem('dd_sid', this._sid);
      sessionStorage.setItem('dd_sid_at', String(Date.now()));
      this._touchSession = () => { try { sessionStorage.setItem('dd_sid_at', String(Date.now())); } catch (e) {} };
    } catch (e) { this._sid = 'nostore'; this._touchSession = () => {}; }

    // Campaign tags are parsed once here rather than stored raw and unpicked in SQL later.
    try {
      const p = new URLSearchParams(location.search);
      this._utm = {
        source: p.get('utm_source') || null,
        medium: p.get('utm_medium') || null,
        campaign: p.get('utm_campaign') || null
      };
    } catch (e) { this._utm = {}; }

    if (this.PLAUSIBLE_DOMAIN && !window.plausible) {
      const sc = document.createElement('script');
      sc.defer = true; sc.dataset.domain = this.PLAUSIBLE_DOMAIN; sc.src = 'https://plausible.io/js/script.js';
      document.head.appendChild(sc);
      window.plausible = window.plausible || function () { (window.plausible.q = window.plausible.q || []).push(arguments); };
    }

    if ('IntersectionObserver' in window) {
      const hero = document.querySelector('header');
      if (hero) {
        this._hio = new IntersectionObserver(es => es.forEach(en => {
          if (en.isIntersecting) { this._hio.unobserve(en.target); this.track('view_hero'); }
        }), { threshold: 0.25 });
        this._hio.observe(hero);
      }
    }

    this._t0 = Date.now();
    this.track('page_view', {
      referrer_host: (() => { try { return document.referrer ? new URL(document.referrer).hostname : 'direct'; } catch (e) { return 'direct'; } })(),
      viewport: window.innerWidth < 768 ? 'mobile' : (window.innerWidth < 1200 ? 'tablet' : 'desktop'),
      utm: location.search.slice(0, 200)
    });

    // Scroll depth: how far down the page people actually get, once per threshold.
    this._depth = {}; this._maxDepth = 0;
    this._onDepth = () => {
      const doc = document.documentElement;
      const pct = Math.min(100, Math.round(((window.scrollY + window.innerHeight) / doc.scrollHeight) * 100));
      if (pct > this._maxDepth) this._maxDepth = pct;
      [25, 50, 75, 90].forEach(t => {
        if (pct >= t && !this._depth[t]) { this._depth[t] = true; this.track('scroll_depth', { depth: t }); }
      });
    };
    window.addEventListener('scroll', this._onDepth, { passive: true });

    // Dwell time per section: which parts of the page hold attention. Accumulated while a
    // section is at least half on screen, and sent as one event at the end of the visit.
    //
    // section_view fires the first time each section is actually seen. That used to be inferred
    // at query time from section_time, which only arrives at the very end of a visit, so the
    // "reached the demo" funnel step silently missed every session that did not close cleanly.
    // A reach event has to be its own event.
    this._dwell = {}; this._dwellFrom = {}; this._seenSection = {};
    if ('IntersectionObserver' in window) {
      this._sio = new IntersectionObserver(es => es.forEach(en => {
        const name = en.target.getAttribute('data-section');
        if (!name) return;
        if (en.isIntersecting) {
          this._dwellFrom[name] = Date.now();
          if (!this._seenSection[name]) { this._seenSection[name] = true; this.track('section_view', { section: name }); }
        }
        else if (this._dwellFrom[name]) {
          this._dwell[name] = (this._dwell[name] || 0) + (Date.now() - this._dwellFrom[name]);
          delete this._dwellFrom[name];
        }
      }), { threshold: 0.5 });
      document.querySelectorAll('[data-section]').forEach(el => this._sio.observe(el));

      // CTA impressions: the denominator click-through rate never had. Without it you can only
      // see which button gets clicked most in absolute terms, which mostly reflects which one
      // sits highest on the page. Fires once per placement per visit.
      this._seenCta = {};
      this._cio = new IntersectionObserver(es => es.forEach(en => {
        const where = en.target.getAttribute('data-cta');
        if (!en.isIntersecting || !where || this._seenCta[where]) return;
        this._seenCta[where] = true;
        this._cio.unobserve(en.target);
        this.track('cta_impression', { location: where });
      }), { threshold: 0.6 });
      document.querySelectorAll('[data-cta]').forEach(el => this._cio.observe(el));
    }

    // Video watch time: real seconds watched, plus quarter milestones per clip.
    // The clip name is read from the element rather than inferred from DOM order — index-based
    // naming meant reordering the page silently relabelled historical data.
    this._watch = {};
    document.querySelectorAll('video').forEach((v, i) => {
      const clip = v.getAttribute('data-clip') || ('video_' + (i + 1));
      const w = this._watch[clip] = { seconds: 0, last: 0, marks: {} };
      v.addEventListener('timeupdate', () => {
        const d = v.currentTime - w.last;
        if (d > 0 && d < 1.5) w.seconds += d; // ignore seeks
        w.last = v.currentTime;
        if (v.duration) {
          const pct = Math.round((v.currentTime / v.duration) * 100);
          [25, 50, 75, 95].forEach(t => {
            if (pct >= t && !w.marks[t]) { w.marks[t] = true; this.track('video_progress', { clip, percent: t }); }
          });
        }
      });
      v.addEventListener('seeked', () => { w.last = v.currentTime; });
    });

    // Total click coverage, via one delegated listener on the document.
    //
    // The per-button handlers only fire on the controls someone remembered to wire up: of the
    // contact links on this page, fewer than half had a handler, so "how many people emailed
    // me" was unanswerable. Delegation catches everything, including anything added later, and
    // it keeps working when a control is re-rendered.
    //
    // Two events, deliberately:
    //   element_click  every link and button, for raw interaction counts
    //   contact_click  WhatsApp, email and phone only, because those are outcomes, not clicks
    // The existing cta_click handlers still fire and are unaffected: they measure placement
    // performance, which is a different question from reach.
    this._onAnyClick = e => {
      const el = e.target && e.target.closest ? e.target.closest('a,button,[role="button"]') : null;
      if (!el) return;

      const href = el.getAttribute('href') || '';
      const section = (el.closest('[data-section]') || {}).getAttribute
        ? el.closest('[data-section]').getAttribute('data-section') : null;

      // A stable, readable label that survives copy changes better than raw text alone.
      const label = (el.getAttribute('data-cta') || el.getAttribute('aria-label') ||
        el.getAttribute('title') || (el.textContent || '').trim().slice(0, 60) || el.tagName).toString();

      let channel = null;
      if (/^mailto:/i.test(href)) channel = 'email';
      else if (/^tel:/i.test(href)) channel = 'phone';
      else if (/(^https?:)?\/\/(wa\.me|api\.whatsapp\.com)/i.test(href)) channel = 'whatsapp';

      this.track('element_click', { label, section: section || 'unknown', kind: channel || (href ? 'link' : 'button') });
      if (channel) this.track('contact_click', { channel, label, section: section || 'unknown' });
    };
    document.addEventListener('click', this._onAnyClick, true); // capture: runs even if a handler stops propagation

    // One summary per visit, on the way out.
    //
    // This used to be a one-shot guarded by a flag, fired on the first `visibilitychange →
    // hidden`. On a phone, switching apps for a second ended the measured visit permanently, so
    // time on page and scroll depth were systematically undercounted for the mobile majority.
    //
    // Now: hiding the page flushes what we have so far, and coming back resumes measuring.
    // Repeat flushes send only the time accrued since the last one, so a visitor who switches
    // apps five times contributes five partial summaries that add up to the real total rather
    // than one truncated one. `_sent` tracks what has already been reported per section.
    this._sent = {}; this._sentSeconds = 0; this._sentWatch = {};
    this._flush = final => {
      const now = Date.now();
      // Close any open dwell windows without discarding them: the section is still on screen.
      Object.keys(this._dwellFrom).forEach(n => {
        this._dwell[n] = (this._dwell[n] || 0) + (now - this._dwellFrom[n]);
        this._dwellFrom[n] = now;
      });
      const delta = {};
      Object.keys(this._dwell).forEach(n => {
        const whole = Math.round(this._dwell[n] / 1000);
        const already = this._sent[n] || 0;
        if (whole > already) { delta[n] = whole - already; this._sent[n] = whole; }
      });
      if (Object.keys(delta).length) this.track('section_time', delta);

      Object.keys(this._watch).forEach(clip => {
        const whole = Math.round(this._watch[clip].seconds);
        const already = this._sentWatch[clip] || 0;
        if (whole > already + 0.5) {
          this.track('video_watch', { clip, seconds: whole - already });
          this._sentWatch[clip] = whole;
        }
      });

      const total = Math.round((now - this._t0) / 1000);
      if (total > this._sentSeconds) {
        this.track('session_end', {
          seconds: total - this._sentSeconds,
          max_depth: this._maxDepth,
          final: !!final
        });
        this._sentSeconds = total;
      }
    };
    this._onLeave = () => this._flush(true);
    window.addEventListener('pagehide', this._onLeave);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this._flush(false);
      else { this._t0 = Date.now() - this._sentSeconds * 1000; this._touchSession(); } // resume measuring
    });
  }

  track(name, props) {
    try {
      const p = props || {};
      if (window.plausible) window.plausible(name, { props: p });
      if (window.gtag) window.gtag('event', name, p);
      if (this._touchSession) this._touchSession(); // any activity keeps the session alive
      const body = JSON.stringify({
        event: name, props: p,
        vid: this._vid, sid: this._sid, utm: this._utm || {},
        path: location.pathname, ref: document.referrer || '', ts: Date.now()
      });
      // Beacon survives the page being closed mid-event (exit intent, outbound Calendly click).
      if (navigator.sendBeacon) navigator.sendBeacon('/api/event', new Blob([body], { type: 'application/json' }));
      else fetch('/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    } catch (e) { /* analytics must never break the page */ }
  }

  openBookingFrom(where) {
    this.track('cta_click', { location: where });
    this.track('form_open', { location: where, step: this.state.step });
    this.setState({ modal: 'booking', formError: '' });
  }

  // Debounced: dragging a slider is one intent, not forty events.
  trackCalc(field) {
    clearTimeout(this._calcT);
    this._calcT = setTimeout(() => this.track('calc_interact', { field }), 800);
    this._timers.push(this._calcT);
  }

  // ---- Lead delivery ----
  leadPayload(source) {
    const s = this.state;
    return {
      name: s.bName, practice_name: s.bPractice, email: s.bEmail, phone: s.bPhone,
      country: s.bCountry, monthly_call_volume: s.bVolume, locations: s.bLocations,
      website: s.bWebsite, // honeypot: server drops anything with this filled
      source,
      // Attribution rides along so a lead can be tied back to the visit and campaign that
      // produced it. The direct-to-Supabase fallback ignores the fields it has no columns for.
      vid: this._vid, sid: this._sid, utm: this._utm || {}, ref: document.referrer || ''
    };
  }

  // BUG-3: a completed demo call is the strongest buying signal on the page and used to reach
  // nobody. Fired once per source per session; failures stay silent for the visitor.
  notifyLead(source) {
    this._sentSources = this._sentSources || {};
    if (this._sentSources[source]) return;
    this._sentSources[source] = true;
    try {
      fetch('/api/notify-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dd-site': this.SITE_TOKEN },
        body: JSON.stringify(this.leadPayload(source)),
        keepalive: true
      }).catch(() => {});
    } catch (e) { /* nothing the visitor should ever see */ }
  }

  // Citation hover previews: microlink screenshot card, vanilla equivalent of the LinkPreview
  // component (spring-in card above the link, subtle x-follow on mousemove). No dependencies.
  initLinkPreviews() {
    const links = document.querySelectorAll('[data-linkpreview]');
    if (!links.length) return;
    const card = document.createElement('div');
    card.setAttribute('aria-hidden', 'true');
    card.style.cssText = 'position:fixed;z-index:90;pointer-events:none;opacity:0;transform:translate(-50%,10px) scale(.7);transition:opacity .28s cubic-bezier(.22,1,.36,1),transform .32s cubic-bezier(.34,1.56,.64,1);background:#FFFFFF;border:1px solid #E8E4DA;border-radius:12px;padding:4px;box-shadow:0 18px 44px rgba(10,26,47,0.2)';
    const img = document.createElement('img');
    img.style.cssText = 'display:block;width:200px;height:125px;object-fit:cover;object-position:top;border-radius:8px;background:#F1EEE6';
    img.alt = '';
    const cap = document.createElement('div');
    cap.style.cssText = 'font-size:11px;color:#5A6E86;padding:5px 4px 2px;text-align:center;font-family:Inter,system-ui,sans-serif';
    card.appendChild(img); card.appendChild(cap);
    document.body.appendChild(card);
    this._lpCard = card;
    let xTarget = 0, xCur = 0;
    const tick = () => { xCur += (xTarget - xCur) * 0.14; card.style.marginLeft = xCur.toFixed(1) + 'px'; this._lpRaf = requestAnimationFrame(tick); };
    links.forEach(a => {
      a.addEventListener('mouseenter', () => {
        const url = a.getAttribute('data-linkpreview');
        const r = a.getBoundingClientRect();
        img.src = 'https://api.microlink.io/?' + new URLSearchParams({ url, screenshot: 'true', meta: 'false', embed: 'screenshot.url', 'viewport.width': '800', 'viewport.height': '500' }).toString();
        cap.textContent = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
        card.style.left = (r.left + r.width / 2) + 'px';
        card.style.top = Math.max(8, r.top - 178) + 'px';
        xTarget = 0; xCur = 0; card.style.marginLeft = '0px';
        card.style.opacity = '1';
        card.style.transform = 'translate(-50%,0) scale(1)';
        if (!this._lpRaf) tick();
      });
      a.addEventListener('mousemove', e => {
        const r = a.getBoundingClientRect();
        xTarget = (e.clientX - (r.left + r.width / 2)) / 2;
      });
      a.addEventListener('mouseleave', () => {
        card.style.opacity = '0';
        card.style.transform = 'translate(-50%,10px) scale(.7)';
        if (this._lpRaf) { cancelAnimationFrame(this._lpRaf); this._lpRaf = null; }
      });
    });
  }

  componentWillUnmount() {
    (this._timers || []).forEach(clearTimeout);
    clearInterval(this._callTimer);
    clearInterval(this._yapTimer);
    window.removeEventListener('scroll', this._onScroll);
    document.removeEventListener('keydown', this._onKey);
    document.removeEventListener('mouseout', this._onMouseOut);
    if (this._mq && this._mq.removeEventListener) this._mq.removeEventListener('change', this._onMq);
    [this._rio, this._cio, this._tio, this._hio, this._sio].forEach(o => o && o.disconnect());
    window.removeEventListener('scroll', this._onDepth);
    window.removeEventListener('pagehide', this._onLeave);
    if (this._lpRaf) cancelAnimationFrame(this._lpRaf);
    if (this._lpCard) this._lpCard.remove();
    clearInterval(this._silenceTimer);
    if (this._onVapiReady) window.removeEventListener('denty-vapi-ready', this._onVapiReady);
    // Only tear the call down if one is genuinely live. Listeners are removed and the microphone
    // released here because the component is going away — never mid-connection.
    if (this._vapi) {
      try { this._vapi.removeAllListeners(); } catch (e) {}
      if (this._vapiLive) { try { Promise.resolve(this._vapi.stop()).catch(() => {}); } catch (e) {} }
    }
    this.releaseMic();
  }

  animateCount(el) {
    const end = parseFloat(el.dataset.count);
    const fmt = v => Math.round(v).toLocaleString('en-US');
    const final = fmt(end);
    if (this._reduced) { el.textContent = final; return; }

    // The count grows the STRING as well as the number: "0" -> "8,000" is four characters
    // wider, and the stat around it reads "$<count>–$10,000". On a phone that whole line
    // fits on one row at "$0–$10,000" and needs two at "$8,000–$10,000", so the line count
    // flips partway through the count and the block jumps — worse on Android, where Chrome
    // re-runs font boosting when the layout changes.
    //
    // Fix: keep the rendered width constant for the whole animation by drawing the
    // characters not yet reached as hidden copies of the real ones. Identical glyphs in the
    // identical font means the width is exact without measuring anything, so it stays
    // correct when Fraunces finishes loading and swaps the metrics underneath us.
    //
    // Desktop columns are wide enough that the line never re-wraps, and there the number
    // growing outward from centre is the nicer read, so this is scoped to narrow layouts.
    const hold = window.matchMedia('(max-width:900px)').matches;
    let live = null;
    if (hold) {
      // A hidden copy of the FINAL string holds the box open; the running value is painted
      // over it, out of flow, so it cannot contribute width. Reserving with the real final
      // glyphs rather than a measured pixel value means this stays exact when Fraunces
      // finishes loading and the metrics change underneath us, and it does not depend on
      // the font carrying tabular figures.
      const ghost = document.createElement('span');
      ghost.textContent = final;
      ghost.style.visibility = 'hidden';
      ghost.setAttribute('aria-hidden', 'true');
      live = document.createElement('span');
      live.style.cssText = 'position:absolute;left:0;right:0;top:0;text-align:center';
      el.style.position = 'relative';
      el.style.display = 'inline-block';
      el.textContent = '';
      el.append(ghost, live);
    }
    const paint = v => {
      if (hold) live.textContent = v; else el.textContent = v;
    };

    const t0 = performance.now(), dur = 3400;
    const step = t => {
      const p = Math.min(1, (t - t0) / dur);
      paint(fmt(end * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
      else if (hold) {                          // collapse back to plain text
        el.textContent = final;
        el.style.position = ''; el.style.display = '';
      }
    };
    paint('0');
    requestAnimationFrame(step);
  }

  cycleHero() {
    const durs = [2400, 4200, 2800];
    const tick = () => {
      this.setState(s => {
        const nextPhase = (s.heroPhase + 1) % 3;
        return { heroPhase: nextPhase, heroIdx: nextPhase === 0 ? (s.heroIdx + 1) % this.CALLERS.length : s.heroIdx };
      }, () => this._timers.push(setTimeout(tick, durs[this.state.heroPhase])));
    };
    this._timers.push(setTimeout(tick, durs[0]));
  }

  // Scroll to a section on this page — or navigate to it on the deep page when this
  // document does not contain it. The demo, pricing and FAQ all moved to /how-it-works/,
  // and this is the single place that knows it.
  scrollToEl(id) {
    const el = document.getElementById(id);
    if (el) {
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 20, behavior: this._reduced ? 'auto' : 'smooth' });
      return;
    }
    location.href = this.DEEP_URL + '#' + id;
  }

  // ---- Demo call ----
  // Live voice via the Vapi HTML script-tag SDK (loaded in helmet, initialized in componentDidMount).
  // Clicking Toothy starts a real in-browser call on the visitor's microphone. Duration limits and
  // end messages are handled on the assistant side; the client countdown is a visual + safety net.
  // If the SDK hasn't loaded (offline preview), a simulated call plays instead. Never a raw error.
  startDemo() {
    const s = this.state;
    // Two guards, not one: `toothy` covers the visible call states, `starting` covers the gap
    // between the click and the first state change, where a fast double-click used to slip
    // through and create a second call.
    if (s.toothy === 'live' || s.toothy === 'connecting' || s.starting) return;
    this.setState({ starting: true });
    // After the form is in, the gate lifts: let them call and test the receptionist right here.
    if (s.demoUsed && !s.formDone) {
      this.setState({ toothy: 'limited', bubble: "You've had your free call. Want one answering your practice's phone?", modal: 'booking' });
      this.track('demo_blocked', { by: 'device' });
      return;
    }
    const total = this.props.demoSeconds ?? 60;
    this.setState({ toothy: 'connecting', bubble: 'Connecting…', remaining: total });
    this.gateDemo().then(gate => {
      if (this.state.toothy !== 'connecting') return; // visitor navigated away mid-check
      if (!gate.ok && gate.reason !== 'already_demoed') {
        // Our own gate could not answer. Refuse this attempt so an outage cannot uncap voice
        // spend, but leave no mark on the visitor — they get a retry, not a spent demo.
        this.failCall("We couldn't start the demo just now. Give it a moment and try again.");
        this.track('demo_blocked', { by: gate.reason || 'unavailable' });
        return;
      }
      if (!gate.ok) {
        try { localStorage.setItem('dd_demo_used', '1'); } catch (e) {}
        this.setState({ toothy: 'limited', demoUsed: true, modal: 'booking',
          bubble: "Looks like this line already had its free call. Want one answering your practice's phone?" });
        this.track('demo_blocked', { by: 'ip' });
        return;
      }
      // Configuration is checked before anything else: better an honest message than a call with
      // no assistant on it.
      const configError = this.vapiConfigError();
      if (configError && this._vapi) { this.failCall(configError); return; }

      this.setState({ bubble: 'Checking your microphone…' });
      this.ensureMic().then(mic => {
        if (this.state.toothy !== 'connecting') { this.releaseMic(); return; } // they navigated away
        if (!mic.ok) {
          this.setState({ starting: false });
          this.failCall(mic.message);
          this.track('demo_blocked', { by: 'mic', reason: mic.reason });
          return;
        }

        this.setState({ bubble: 'Calling…' });
        this.track('demo_start');

        if (!this._vapi) { // SDK unavailable (offline preview): simulate rather than show an error
          this._timers.push(setTimeout(() => this.goLive(), 1600));
          return;
        }

        // start() is async and the assistant argument is optional. The old code called it inside
        // a try/catch and returned immediately, so a rejected promise escaped the catch, the
        // fallback never ran, and the UI sat on "Connecting…" forever. Both paths are handled now,
        // and the assistant id is always passed explicitly.
        let started;
        try { started = this._vapi.start(this.VAPI_ASSISTANT_ID); }
        catch (e) { this.vlog('start threw synchronously:', e); this.failCall("Couldn't start the call. Please try again."); return; }

        Promise.resolve(started).then(call => {
          // A null result means no call was created — never treat that as connected.
          if (!call) { this.vlog('start resolved without a call'); this.failCall("Couldn't start the call. Please try again."); return; }
          this.vlog('call created ·', call && call.id ? 'id received' : 'no id');
          // Connected state is driven by the SDK's call-start event, never by start() resolving.
        }).catch(e => {
          this.vlog('start rejected:', e && (e.message || e));
          this.failCall("Couldn't connect the call. Please try again.");
        });
      });
    });
  }

  // BUG-2: the only gate used to be a localStorage flag any visitor could clear. The real check
  // lives in /api/demo-session (one call per hashed IP); localStorage stays as the instant,
  // no-round-trip layer above it.
  //
  // Returns { ok, reason } rather than a bare boolean, because the two ways a call can be
  // refused need opposite handling. 'already_demoed' is the visitor's own second attempt and
  // should stick. 'unavailable' means OUR lookup failed — blocking that attempt caps voice
  // spend during an outage, but it must never mark the visitor as having used a demo they
  // never got. A transport error still fails open: a hot lead is not turned away because our
  // endpoint hiccuped.
  gateDemo() {
    if (this.state.formDone) return Promise.resolve({ ok: true }); // already a lead: let them keep testing
    try {
      return fetch('/api/demo-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(r => (r.ok ? r.json() : null))
        .then(j => {
          if (!j) return { ok: true };
          this._gateToken = j.token || '';
          return j.approved === false ? { ok: false, reason: j.reason || 'blocked' } : { ok: true };
        })
        .catch(() => ({ ok: true }));
    } catch (e) { return Promise.resolve({ ok: true }); }
  }

  // Spends the demo, once, at the moment the call connects — not when the button is clicked.
  // A denied microphone or a dropped connection therefore costs the visitor nothing.
  // Carries the short-lived token minted by the check above, which ties this claim to a gate
  // decision made seconds ago for the same IP.
  claimDemo() {
    if (this._claimed || this.state.formDone) return;
    this._claimed = true;
    try {
      fetch('/api/demo-session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim: true, token: this._gateToken || '' }), keepalive: true
      }).catch(() => {});
    } catch (e) {}
  }

  goLive() {
    if (this.state.toothy !== 'connecting') return;
    this.setState({ toothy: 'live', starting: false, bubble: '' });
    this.watchMicLevel();
    this.claimDemo(); // the call is actually connected — only now does it count as their demo
    if (!this._reduced) this._yapTimer = setInterval(() => this.setState(st => ({ yapIdx: ((st.yapIdx || 0) + 1) % this.YAP_CYCLE.length })), 150);
    this._callTimer = setInterval(() => {
      this.setState(st => {
        const r = st.remaining - 1;
        if (r <= 0) { clearInterval(this._callTimer); this.hangUp(); return { remaining: 0 }; }
        return { remaining: r, bubble: r === 10 ? '10 seconds left' : st.bubble };
      });
    }, 1000);
  }

  // The reported Vapi failure is "the assistant received no customer audio". The SDK exposes the
  // live input level, so we can notice that from the visitor's side and say so, instead of them
  // talking into a dead microphone for sixty seconds and concluding the product does not work.
  watchMicLevel() {
    clearInterval(this._silenceTimer);
    if (!this._vapi || typeof this._vapi.getLocalAudioLevel !== 'function') return;
    let quiet = 0, heard = false;
    this._silenceTimer = setInterval(() => {
      if (this.state.toothy !== 'live') { clearInterval(this._silenceTimer); return; }
      let level = 0;
      try { level = this._vapi.getLocalAudioLevel() || 0; } catch (e) { return; }
      if (level > 0.01) { heard = true; quiet = 0; if (this.state.micWarn) this.setState({ micWarn: false }); return; }
      quiet++;
      // Eight seconds of silence before we say anything: people pause, and nobody wants a warning
      // for thinking. Only warn if we have never heard them at all.
      if (quiet === 8 && !heard) {
        this.vlog('no local audio detected after 8s — input may be muted or wrong device');
        this.setState({ micWarn: true });
      }
    }, 1000);
  }

  hangUp() {
    clearInterval(this._callTimer);
    clearInterval(this._silenceTimer);
    // stop() is async; the call-end listener performs the teardown once it has actually ended, so
    // the microphone is released after the call rather than during it.
    if (this._vapi && this._vapiLive) {
      try { Promise.resolve(this._vapi.stop()).catch(() => {}); return; } catch (e) {}
    }
    this.releaseMic();
    this.finishDemo();
  }

  // Naming the actual control beats "check your browser settings". Once a visitor has denied the
  // microphone, most browsers will not prompt again, so they have to be told where the switch is.
  micInstructions() {
    const ua = navigator.userAgent || '';
    const ios = /iPad|iPhone|iPod/.test(ua);
    if (/Firefox/.test(ua)) return 'Click the microphone icon in the address bar, remove the block, then reload the page and try again.';
    if (ios) return 'Open Settings, then Safari, then Microphone, and allow this site. Then reload the page.';
    if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return 'Open Safari, then Settings for This Website, set Microphone to Allow, then reload the page.';
    if (/Android/.test(ua)) return 'Tap the lock icon beside the address bar, open Permissions, allow the microphone, then reload the page.';
    return 'Click the lock or microphone icon at the left of the address bar, set the microphone to Allow, then reload the page.';
  }

  // Opening a panel is a real interaction worth measuring: it tells us which part of the console
  // practice owners actually want to see before they commit.
  pickDash(i) {
    if (this.state.dashActive === i) return;
    this.setState({ dashActive: i });
    const shot = this.DASH_SHOTS[i];
    this.track('cta_click', { location: 'dashboard_' + (shot ? shot.id : i) });
  }

  // Give the frame the screenshot's own aspect ratio the moment it loads. These are full-page
  // captures whose dimensions are not known when the markup is written, so measuring beats
  // guessing: a fixed box would crop a tall capture, and a letterboxed one would waste half the
  // panel on a wide one.
  sizeDash(e) {
    const img = e && (e.target || e.currentTarget);
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const frame = img.closest ? img.closest('.dd-dash-frame') : null;
    if (frame) frame.style.setProperty('--ar', (img.naturalWidth / img.naturalHeight).toFixed(4));
    // A very tall capture scrolls inside its frame rather than stretching the page; a short one
    // simply shows in full. Either way the whole image is reachable and none of it is cut off.
    const scroller = img.parentElement;
    if (scroller && img.naturalHeight / img.naturalWidth < 1.2) scroller.style.maxHeight = 'none';
  }

  // Called from the mic-denied panel. Clears the error and runs the whole start path again against
  // the same client instance, so no listeners are duplicated.
  retryDemo() {
    this.setState({ micState: 'unknown', micWarn: false, bubble: '' });
    this.startDemo();
  }

  currentFrame() {
    const s = this.state;
    if (s.toothy === 'live' || s.toothy === 'connecting') return this.YAP_CYCLE[s.yapIdx || 0];
    if (s.toothy === 'ended' || s.toothy === 'limited') return 'happy';
    return s.bubble ? 'happy' : 'neutral';
  }

  componentDidUpdate() {
    // Focus management: move focus into an opening dialog, restore it on close
    if (this.state.modal !== this._prevModal) {
      if (this.state.modal) {
        this._lastFocus = document.activeElement;
        setTimeout(() => {
          const d = document.querySelector('[role="dialog"]');
          if (!d) return;
          const f = d.querySelector('input, select, button:not([aria-label="Close"]), a[href]');
          (f || d).focus();
        }, 80);
      } else if (this._lastFocus && this._lastFocus.focus) { this._lastFocus.focus(); }
      this._prevModal = this.state.modal;
    }
    // Sprite src is set imperatively — a {{ }} hole in an img src fires a bogus fetch during raw HTML parse.
    const el = document.getElementById('denty-sprite');
    if (el) {
      const src = this.FRAMES[this.currentFrame()];
      if (el.getAttribute('src') !== src) el.setAttribute('src', src);
    }
    const fpEl = document.getElementById('founder-photo');
    if (fpEl && fpEl.getAttribute('src') !== this.FOUNDER_PHOTO) fpEl.setAttribute('src', this.FOUNDER_PHOTO);
  }

  finishDemo() {
    if (this.state.toothy === 'ended') return;
    clearInterval(this._yapTimer);
    localStorage.setItem('dd_demo_used', '1');
    this.setState({ toothy: 'ended', demoUsed: true, bubble: 'That was the same receptionist your patients would reach.' });
    this.track('demo_complete', { seconds: (this._demoTotal || 60) - this.state.remaining });
    this.notifyLead('demo_call');
    // Post-form calls: once the conversation ends, bring the form popup back up.
    if (this.state.formDone) this._timers.push(setTimeout(() => { if (!this.state.modal) this.setState({ modal: 'booking' }); }, 1400));
  }

  // ---- Booking modal ----
  EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
  // BUG-10: every step now says what it wants instead of silently refusing to advance.
  STEP_PROMPTS = [
    'Your name, so we know who we’re talking to.',
    'Your practice’s name, so we can look it up before the call.',
    'Pick a country to continue.',
    'Pick a rough call volume to continue.',
    'How many locations? Enter at least 1.',
    'That email doesn’t look right. Try something like you@practice.com.'
  ];

  valid(step) {
    const s = this.state;
    return [s.bName, s.bPractice, s.bCountry, s.bVolume, s.bLocations, s.bEmail][step] !== '' || step > 5;
  }

  refuse(msg) {
    this.setState({ formError: msg, shake: true });
    clearTimeout(this._shakeT);
    this._shakeT = setTimeout(() => this.setState({ shake: false }), 460);
    this._timers.push(this._shakeT);
  }

  next() {
    const s = this.state;
    if (s.step === 5) {
      if (!this.EMAIL_RE.test(String(s.bEmail).trim())) {
        this.refuse(this.STEP_PROMPTS[5]);
        this.track('form_error', { step: 6, field: 'email' });
        return;
      }
      // Lead delivery: /api/notify-lead inserts into Supabase and emails the owner via Resend.
      localStorage.setItem('dd_form_done', '1');
      this.setState({ step: 6, sendState: 'sending', formDone: true, formError: '' });
      this.track('form_step_5');
      this.track('form_submit', { volume: s.bVolume, locations: s.bLocations, country: s.bCountry, demoed: !!s.demoUsed });
      this.submitLead();
    } else if (this.valid(s.step)) {
      this.setState({ step: s.step + 1, formError: '' });
      this.track('form_step_' + (s.step + 1));
    } else {
      this.refuse(this.STEP_PROMPTS[s.step]);
      this.track('form_error', { step: s.step + 1 });
    }
  }

  submitLead() {
    const payload = this.leadPayload('form');
    try {
      // Primary: serverless route (Supabase insert + Resend email to the owner's inbox).
      fetch('/api/notify-lead', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dd-site': this.SITE_TOKEN }, body: JSON.stringify(payload) })
        .then(r => r.json())
        .then(j => { if (j && j.ok) this.setState({ sendState: 'sent' }); else { this.insertDirect(payload); } })
        .catch(() => this.insertDirect(payload));
    } catch (e) { this.setState({ sendState: 'queued' }); }
  }

  insertDirect(payload) {
    // Fallback when no serverless runtime exists: write the lead straight to Supabase from the
    // browser, under the insert-only RLS policy.
    //
    // The row is built column by column rather than by spreading the payload. PostgREST rejects
    // the whole insert if it sees a key with no matching column, and the payload deliberately
    // carries fields the table does not have: the honeypot, the nested utm object, the raw
    // referrer. (This previously destructured `website` out and then sent the original payload
    // anyway, so every fallback insert was being rejected.)
    if (payload.website) return; // bot: drop it here too
    const u = payload.utm || {};
    let referrerHost = null;
    if (payload.ref) { try { referrerHost = new URL(payload.ref).hostname.replace(/^www\./, ''); } catch (e) { referrerHost = null; } }
    const core = {
      name: payload.name, practice_name: payload.practice_name, email: payload.email,
      phone: payload.phone, country: payload.country,
      monthly_call_volume: payload.monthly_call_volume, locations: payload.locations,
      source: payload.source
    };
    const attributed = Object.assign({}, core, {
      visitor_id: payload.vid || null, session_id: payload.sid || null,
      utm_source: u.source || null, utm_medium: u.medium || null, utm_campaign: u.campaign || null,
      referrer_host: referrerHost
    });
    const post = row => fetch(this.SUPABASE_URL + '/rest/v1/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + this.SUPABASE_PUBLISHABLE_KEY, Prefer: 'return=minimal' },
      body: JSON.stringify(row)
    });
    try {
      // If the attribution columns are not there yet (page deployed ahead of the migration),
      // retry with the columns the table has always had. Losing the campaign tag is a small
      // cost; losing the lead is not.
      post(attributed)
        .then(r => r.ok ? r : post(core))
        .then(r => this.setState({ sendState: r.ok ? 'saved' : 'queued' }))
        .catch(() => this.setState({ sendState: 'queued' }));
    } catch (e) { this.setState({ sendState: 'queued' }); }
  }

  // ---- Pricing card 3D tilt + glare (spring-smoothed, hover-capable pointers only) ----
  _tiltEnabled() {
    return !this._reduced && window.matchMedia && window.matchMedia('(hover:hover) and (pointer:fine)').matches;
  }
  _tiltMove(e) {
    const el = this._tiltEl;
    if (!el || !this._tiltEnabled()) return;
    const r = el.getBoundingClientRect(), max = 12;
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    this._tiltTarget = { rx: (0.5 - py) * max, ry: (px - 0.5) * max };
    if (this._glareEl) this._glareEl.style.background = `radial-gradient(circle at ${(px * 100).toFixed(1)}% ${(py * 100).toFixed(1)}%, #0A1A2F, transparent 50%)`;
    this._tiltRun();
  }
  _tiltLeave() {
    if (!this._tiltEl) return;
    this._tiltTarget = { rx: 0, ry: 0 };
    this._tiltRun();
  }
  _tiltRun() {
    if (this._tiltRaf) return;
    const st = this._tiltState || (this._tiltState = { rx: 0, ry: 0, vx: 0, vy: 0 });
    const k = 200, d = 15, m = 0.3, dt = 1 / 60; // SPRING_MOUSE: stiffness 200, damping 15, mass 0.3
    const step = () => {
      const t = this._tiltTarget || { rx: 0, ry: 0 }, el = this._tiltEl;
      st.vx += ((t.rx - st.rx) * k - st.vx * d) / m * dt; st.rx += st.vx * dt;
      st.vy += ((t.ry - st.ry) * k - st.vy * d) / m * dt; st.ry += st.vy * dt;
      if (el) el.style.transform = `perspective(1000px) rotateX(${st.rx.toFixed(3)}deg) rotateY(${st.ry.toFixed(3)}deg)`;
      const settled = Math.abs(t.rx - st.rx) < 0.02 && Math.abs(t.ry - st.ry) < 0.02 && Math.abs(st.vx) < 0.02 && Math.abs(st.vy) < 0.02;
      if (settled) {
        st.rx = t.rx; st.ry = t.ry; st.vx = 0; st.vy = 0;
        if (el) el.style.transform = t.rx === 0 && t.ry === 0 ? '' : `perspective(1000px) rotateX(${t.rx}deg) rotateY(${t.ry}deg)`;
        this._tiltRaf = 0;
      } else {
        this._tiltRaf = requestAnimationFrame(step);
      }
    };
    this._tiltRaf = requestAnimationFrame(step);
  }

  componentDidCatch(err) { console.error('Boundary caught:', err); this.setState({ crashed: true }); }

  renderVals() {
    const fallback = { crashed: true, appOk: false, reloadPage: () => location.reload() };
    if (this.state.crashed) return fallback;
    try { return { crashed: false, appOk: true, ...this._vals() }; }
    catch (e) { console.error('renderVals failed, showing fallback:', e); return fallback; }
  }

  // ROI calculator bounds. Kept in one place so the number inputs, the range
  // sliders and the clamp below can never drift apart.
  CALC = {
    size:  { min: 1,   max: 10   },
    calls: { min: 5,   max: 200  },
    value: { min: 50,  max: 3000 }
  };

  // Fields hold raw strings so a half-typed or momentarily empty box doesn't fight
  // the user. Clamp only when computing; normalise the text on blur.
  _calcNum(raw, key) {
    const b = this.CALC[key];
    const n = parseInt(String(raw).replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(n)) return key === 'value' ? (this.props.firstVisitValue ?? 850) : b.min;
    return Math.max(b.min, Math.min(b.max, n));
  }

  _vals() {
    const s = this.state;
    const c = this.CALLERS[s.heroIdx];
    const total = this._demoTotal || (this.props.demoSeconds ?? 60);
    const rate = this.props.bookingRate ?? 0.30;   // share of missed calls that are booking opportunities
    const MISSED_RATE = 0.17;                      // unanswered share — low end of the cited 17–38%
    const WORK_DAYS = 5, WEEKS = 52;

    const calcSizeN = this._calcNum(s.calcSize, 'size');
    const calcCallsN = this._calcNum(s.calcCalls, 'calls');
    const calcValueN = this._calcNum(s.calcValue, 'value');

    const callsYear = calcSizeN * calcCallsN * WORK_DAYS * WEEKS;
    const missedYear = Math.round(callsYear * MISSED_RATE);
    const lost = Math.round(missedYear * rate * calcValueN);
    const bars = n => Array.from({ length: n }, (_, i) => ({ delay: (i * 0.11 % 0.9).toFixed(2) + 's' }));
    // FAQ order is deliberate: compliance first (the #1 US dental objection), then
    // the "is it obviously a robot" fear, then the hidden-cost fear, then accuracy,
    // then the two comparison questions, then logistics and terms.
    // NOTE FOR BENNY: the HIPAA answer and the contracts/data answer below make no
    // certification claims by design. Have your own counsel read both before launch.
    const faqData = [
      { q: 'Is this HIPAA-compliant?', a: "Call audio is handled by enterprise voice-AI infrastructure and is not shared with us unless you ask us to review a call. We configure Denty to never ask for or repeat protected health information beyond what's needed to book an appointment, and the demo is limited to 60 seconds with no patient data. We'll walk you through exactly how data flows on your strategy call, and we're happy to sign a BAA with the voice platform if your practice requires one." },
      { q: "Will patients know it's AI?", a: "Some ask. The voice is natural enough that most don't. It never pretends to be human when asked directly. It says it's the practice's automated receptionist and keeps the conversation moving. What patients notice is that the phone got answered on the first ring at 9 PM." },
      { q: 'What does usage roughly cost monthly?', a: 'Usage is billed at cost on your own voice-platform account: typically $0.10–$0.15 per minute of live conversation. A practice handling 300 answered calls a month usually lands between $60 and $150. No markup from us, and nothing else is billed monthly unless you choose a care plan.' },
      { q: 'What if it mishears something, or books the wrong details?', a: "It confirms every detail that matters. Name, phone number, and appointment time are read back to the caller before anything is booked. If a caller needs something outside its script, it takes a message and flags it for your staff instead of guessing. And when something does slip through, it slips through where you can see it: the appointment sits in your calendar like any other, so your team fixes it in seconds and we tune the script so it doesn't happen twice." },
      { q: 'How is this different from an answering service?', a: "An answering service takes a message. This takes the booking. A service bills you per call or per minute for as long as you use it, works from a script that takes days to change, and still hands your front desk a callback list, and every callback is another chance for that patient to book somewhere else. Denty answers on the first ring, answers insurance and service questions from your own list, and writes the appointment into your calendar while the caller is still on the phone. One setup fee, not a bill that grows every time you get busier." },
      { q: 'Does it replace my front desk?', a: "No. It catches what they physically can't: after-hours calls, lunch rushes, the second line while they're checking a patient in. Your team keeps doing what humans do best, with a calendar that fills itself." },
      { q: 'Will this work with Dentrix, Eaglesoft or Open Dental?', a: "Usually yes, and we check yours before you pay anything. Every setup includes Google Calendar, which works on day one no matter what practice-management software you run. Writing appointments straight into Dentrix, Eaglesoft, Open Dental or another PMS depends on what your system exposes. That is the $299/month care plan, and we confirm on the strategy call whether your setup supports it. If it doesn't, Denty still books into a calendar your team already lives in." },
      { q: 'How fast is go-live?', a: 'Days, not months. We configure the assistant to your services, insurance list, and calendar, test it against real scenarios with you, then flip it on. Most practices are live within 7 days of the onboarding call, and the clock starts once we have your services list, insurance list, and calendar access.' },
      { q: 'Contracts, cancellation, and data?', a: "No long-term contract. The setup fee is one-time, and care plans cancel anytime: the current month finishes and nothing renews. On data: what you send through this site is stored only so we can reply to you, and it is never sold or shared. Call audio is handled by the enterprise voice platform that powers the conversations, under its own security and data-processing terms; we don't receive or keep recordings unless you ask us to review a specific call. If your practice needs a BAA or a data-processing agreement signed before go-live, tell us on the strategy call and we'll have it in place before a single patient call is answered. Ask us to delete anything you've given us and it's deleted." },
      { q: "How much does an AI receptionist for a dental practice cost?", a: "Setup is $2,000, one time. That covers the voice AI configured to your practice, your calendar, call scripting for your services and insurance list, testing and go-live. You can split it: $1,000 up front and the remaining $1,000 only once a real patient is booked into your calendar within 14 days of go-live — if that doesn't happen, you don't owe it. After that the only running cost is voice usage on your own platform account, billed at cost, typically $0.10–$0.15 per minute of live conversation, which lands most practices between $60 and $150 a month. Ongoing care plans are optional at $149 or $299 a month and cancel anytime." },
      { q: "Can it answer calls after hours, at lunch, and on weekends?", a: "That is the entire point. A practice answering phones roughly 40 hours a week is unreachable for the other 128, and the calls that land in those hours are the ones your marketing already paid for. It answers on the first ring at 7 PM, on Saturday, over lunch, and on the second line while your front desk is checking a patient in. There is no separate after-hours mode to switch on: it is the same receptionist, all 168 hours." },
      { q: "What happens if a patient calls with a dental emergency?", a: "It follows the rules you set, and it does not make clinical judgements. You tell us what counts as urgent for your practice and what should happen: route the caller to your on-call number, give them your emergency instructions, book them into the first available slot, or take the details and flag them immediately. Anything outside the script gets escalated rather than guessed at, and every call is transcribed and logged so your team sees exactly what was said." },
      { q: "Can it handle multiple callers at the same time?", a: "Yes. Several callers can be on the line at once and each one is answered on the first ring — no hold queue, no busy signal, no voicemail. This is the part a single receptionist physically cannot do: when a campaign lands or a Monday morning rush hits, the third and fourth callers get the same answer as the first." },
      { q: 'What is one missed call at a dental practice actually worth?', a: "More than the appointment attached to it. At the rates cited on our homepage — 32–38% of calls unanswered during business hours, 78% of voicemail callers hanging up without leaving a message, and $8,000–$10,000 of lifetime value per new patient — a single missed high-intent call is a four-figure decision rather than a $150 scheduling problem. Someone calling about implants, Invisalign or sedation has usually already decided to spend and is choosing between practices, not browsing. We worked the arithmetic through case by case in our own long-form write-up on Medium, ‘The Real Cost of a Missed Call at Your Dental Practice’." },
      { q: 'Do the busiest practices in my area already answer after hours?', a: "In the markets we have looked at, no. When we reviewed the top-ranked practices in a metro for that same write-up, the pattern was consistent: polished websites, strong review counts, and voicemail after 5 PM. That gap is the opening. Being the practice that answers at 7:42 PM on a Sunday costs one setup fee and takes days to switch on, and it is the one advantage a competitor cannot buy back with a bigger ad budget. This is our own review of a specific market, published under the founder’s byline, not an independent industry study." }
    ];
    const vols = ['<200', '200–500', '500–1,000', '1,000+'];
    const navSolid = s.scrolled || s.navOpen || this.PAGE === 'deep';
    return {
      // nav
      // The home page opens on cream, so the bar starts transparent with dark type and
      // only fills in on scroll. The deep page opens on navy, where transparent-with-dark
      // type would be invisible, so there the bar is solid from the first pixel. Opening
      // the mobile menu also fills it, or the panel would hang off nothing.
      navSolid, navBg: navSolid ? 'rgba(10,26,47,0.88)' : 'rgba(10,26,47,0)',
      navFg: navSolid ? '#FAF9F6' : '#0A1A2F',
      navOpen: s.navOpen,
      navToggleLabel: s.navOpen ? 'Close menu' : 'Open menu',
      toggleNav: () => this.setState({ navOpen: !this.state.navOpen }),
      closeNav: () => this.setState({ navOpen: false }),
      // The demo link inside the mobile panel: close the panel, then hand off to
      // scrollToEl, which scrolls on the deep page and navigates from the home page.
      // Same-page anchors in the panel only need closeNav — the browser does the rest.
      navDemoMenu: e => { e && e.preventDefault(); this.setState({ navOpen: false }); this.track('cta_click', { location: 'nav_menu_demo' }); this.scrollToEl('demo'); },
      isHome: this.PAGE === 'home',
      isDeep: this.PAGE === 'deep',
      deepUrl: this.DEEP_URL,
      // aria-current on the link for the document you are already reading.
      navCurHome: this.PAGE === 'home' ? 'page' : undefined,
      navCurDeep: this.PAGE === 'deep' ? 'page' : undefined,
      // legal dialogs, rendered from one source on both pages
      privacyNote: this.LEGAL.privacyNote,
      privacyParas: this.LEGAL.privacy,
      termsNote: this.LEGAL.termsNote,
      termsParas: this.LEGAL.terms,
      // hero loop
      heroLoading: !s.heroReady,
      hp0: !!s.heroReady && s.heroPhase === 0, hp1: !!s.heroReady && s.heroPhase === 1, hp2: !!s.heroReady && s.heroPhase === 2,
      heroTag: c.tag, heroL1: c.l1, heroL2: c.l2, heroBooked: c.booked, heroCap: c.cap,
      heroBars: bars(10), demoBars: bars(12),
      // calculator — raw strings drive the number boxes, clamped numbers drive the sliders
      calcSize: s.calcSize, calcCalls: s.calcCalls, calcValue: s.calcValue,
      calcSizeN, calcCallsN, calcValueN,
      setCalcSize: e => { this.setState({ calcSize: e.target.value }); this.trackCalc('locations'); },
      setCalcCalls: e => { this.setState({ calcCalls: e.target.value }); this.trackCalc('calls_per_day'); },
      setCalcValue: e => { this.setState({ calcValue: e.target.value }); this.trackCalc('patient_value'); },
      blurCalcSize: () => this.setState({ calcSize: String(this._calcNum(this.state.calcSize, 'size')) }),
      blurCalcCalls: () => this.setState({ calcCalls: String(this._calcNum(this.state.calcCalls, 'calls')) }),
      blurCalcValue: () => this.setState({ calcValue: String(this._calcNum(this.state.calcValue, 'value')) }),
      calcMissedWeek: Math.round(missedYear / WEEKS).toLocaleString('en-US'),
      calcMissedYear: missedYear.toLocaleString('en-US'),
      lostYear: '$' + lost.toLocaleString('en-US'),
      // "New patients" is the unit dentists actually think in — same maths as the dollar figure.
      lostPatients: Math.round(missedYear * rate).toLocaleString('en-US'),
      // BUG-8: the number inputs take their type from here so the pre-hydration HTML parse
      // never sees "{{ }}" inside a type="number" value attribute (4 console warnings gone).
      numType: 'number',
      // Carries the demo into the handoff: the Calendly link is tagged with how they got there,
      // so a booked call can be traced back to "they talked to it first".
      calendlyUrl: this.CALENDLY_URL + (s.demoUsed ? '?utm_source=digidental&utm_medium=site&utm_content=after_demo' : '?utm_source=digidental&utm_medium=site&utm_content=form'),
      // toothy

      bubbleOn: !!s.bubble, bubble: s.bubble,
      tLive: s.toothy === 'live', tEnded: s.toothy === 'ended',
      ringOn: s.toothy === 'live' || s.toothy === 'connecting',
      // The mascot is not clickable while a call is being set up or is already running.
      tBusy: s.starting || s.toothy === 'connecting' || s.toothy === 'live',
      micBlocked: s.micState === 'denied',
      micWarn: !!s.micWarn && s.toothy === 'live',
      micHelp: this.micInstructions(),
      ringColor: s.remaining <= 10 && s.toothy === 'live' ? '#0F8B80' : '#5A6E86',
      ringOffset: Math.round(427 * (1 - s.remaining / total)),
      remaining: s.remaining,
      startDemo: () => this.startDemo(),
      retryDemo: () => this.retryDemo(),
      endDemo: () => this.hangUp(),
      // faq
      // Indices into faqData, not copies of it: HIPAA, PMS compatibility, go-live speed.
      // Editing an answer in one place changes it everywhere it appears.
      faqTop: [0, 6, 7].map(i => faqData[i]).filter(Boolean).map(f => ({ q: f.q, a: f.a })),
      faqs: faqData.map((f, i) => ({ ...f, open: s.faqOpen === i, icon: s.faqOpen === i ? '−' : '+', toggle: () => this.setState({ faqOpen: s.faqOpen === i ? -1 : i }) })),
      // pricing card tilt
      tiltRef: el => { this._tiltEl = el; },
      glareRef: el => { this._glareEl = el; },
      tiltMove: e => this._tiltMove(e),
      tiltLeave: () => this._tiltLeave(),
      // modals + navigation
      mBooking: s.modal === 'booking', mPrivacy: s.modal === 'privacy', mTerms: s.modal === 'terms', mExit: s.modal === 'exit',
      // Every booking CTA carries where it was clicked, so drop-off can be read per placement.
      openBooking: () => this.openBookingFrom('other'),
      openBookingNav: () => this.openBookingFrom('nav'),
      openBookingHero: () => this.openBookingFrom('hero'),
      openBookingSection: () => this.openBookingFrom('before_after'),
      openBookingCalc: () => this.openBookingFrom('calculator'),
      openBookingPostDemo: () => this.openBookingFrom('post_demo'),
      openBookingSticky: () => this.openBookingFrom('sticky_mobile'),
      openBookingFinal: () => this.openBookingFrom('final_cta'),
      navDemo: e => { e && e.preventDefault(); this.track('cta_click', { location: 'nav_demo' }); this.scrollToEl('demo'); },
      stickyDemo: () => { this.track('cta_click', { location: 'sticky_demo' }); this.scrollToEl('demo'); },
      trackWhatsappHero: () => this.track('cta_click', { location: 'hero_whatsapp' }),
      trackCalendlyPricing: () => this.track('calendly_click', { location: 'pricing' }),
      trackCalendlyModal: () => this.track('calendly_click', { location: 'form_complete' }),
      trackCalendlyExit: () => this.track('calendly_click', { location: 'exit_intent' }),
      // Founder card: the portrait swaps itself for the monogram if the file is not there yet.
      hasSocialProof: this.SOCIAL_PROOF.length > 0,
      socialProof: this.SOCIAL_PROOF.map(sp => ({ quote: sp.quote, name: sp.name, practice: sp.practice })),
      // Home page: one capture as evidence, reusing the tour's own frame classes so
      // sizeDash() measures it the same way. The full four-panel tour lives on the
      // deep page; this is the teaser that earns the click to it.
      proofSrc: '/api/image?name=' + this.DASH_SHOTS[0].id,
      proofAlt: 'Digi Dental dashboard: ' + this.DASH_SHOTS[0].title.toLowerCase(),
      proofSized: e => this.sizeDash(e),
      dashShots: this.DASH_SHOTS.map((d, i) => ({
        id: d.id, title: d.title, note: d.note,
        src: '/api/image?name=' + d.id,
        alt: 'Digi Dental dashboard: ' + d.title.toLowerCase(),
        active: s.dashActive === i,
        pick: () => this.pickDash(i),
        // Runs on the image's own load event, which is the only moment the true dimensions are
        // known. Nothing in the layout assumes a ratio before this.
        sized: e => this.sizeDash(e)
      })),
      founderPhotoOn: !!s.founderPhotoOk,
      founderMonogramOn: !s.founderPhotoOk,
      trackFounderWhatsapp: () => this.track('cta_click', { location: 'founder_whatsapp' }),
      trackFounderEmail: () => this.track('cta_click', { location: 'founder_email' }),
      trackFounderLinkedin: () => this.track('cta_click', { location: 'founder_linkedin' }),
      trackFounderPortfolio: () => this.track('cta_click', { location: 'founder_portfolio' }),
      caseStudyUrl: this.CASE_STUDY.url,
      caseStudyTitle: this.CASE_STUDY.title,
      trackCaseStudy: () => this.track('cta_click', { location: 'case_study_medium' }),
      trackVsl: () => this.track('video_play', { clip: 'vsl' }),
      trackDemoVideo: () => this.track('video_play', { clip: 'demo_recording' }),
      openPrivacy: e => { e && e.preventDefault(); this.setState({ modal: 'privacy' }); },
      openTerms: e => { e && e.preventDefault(); this.setState({ modal: 'terms' }); },
      closeModal: () => this.setState({ modal: null }),
      stopProp: e => e.stopPropagation(),
      dismissExit: () => this.setState({ modal: null }),
      tryDemoFromExit: () => { this.track('exit_intent_demo'); this.setState({ modal: null }); this.scrollToEl('demo'); },
      scrollToToothy: e => { e && e.preventDefault(); this.track('cta_click', { location: 'hero_demo' }); this.scrollToEl('demo'); },
      showSticky: s.showSticky,
      scrolled: s.scrolled,
      backToTop: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
      // booking steps
      st0: s.step === 0, st1: s.step === 1, st2: s.step === 2, st3: s.step === 3, st4: s.step === 4, st5: s.step === 5, st6: s.step === 6,
      stNav: s.step < 6,
      dots: Array.from({ length: 6 }, (_, i) => ({ bg: i <= s.step ? '#0F8B80' : '#D8D2C4' })),
      bName: s.bName, bPractice: s.bPractice, bCountry: s.bCountry, bLocations: s.bLocations, bEmail: s.bEmail, bPhone: s.bPhone,
      setName: e => this.setState({ bName: e.target.value, formError: '' }),
      setPractice: e => this.setState({ bPractice: e.target.value, formError: '' }),
      setCountry: e => { this.setState({ bCountry: e.target.value, step: e.target.value ? 3 : 2, formError: '' }); if (e.target.value) this.track('form_step_3'); },
      setLocations: e => this.setState({ bLocations: e.target.value, formError: '' }),
      setEmail: e => this.setState({ bEmail: e.target.value, formError: '' }),
      setPhone: e => this.setState({ bPhone: e.target.value }),
      bWebsite: s.bWebsite,
      setWebsite: e => this.setState({ bWebsite: e.target.value }),
      bookingKey: e => { if (e.key === 'Enter') this.next(); },
      volumeChips: vols.map(v => ({
        label: v,
        border: s.bVolume === v ? '#0F8B80' : '#D8D2C4',
        bg: s.bVolume === v ? '#0F8B80' : '#FFFFFF',
        color: s.bVolume === v ? '#FAF9F6' : '#0A1A2F',
        pick: () => { this.setState({ bVolume: v, step: 4, formError: '' }); this.track('form_step_4'); }
      })),
      // Inline validation feedback (BUG-10)
      hasFormError: !!s.formError, formError: s.formError,
      emailInvalid: !!s.formError && s.step === 5,
      emailBorder: (!!s.formError && s.step === 5) ? '#B4453C' : '#D8D2C4',
      nextAnim: s.shake ? 'dd-shake .45s cubic-bezier(.36,.07,.19,.97) both' : 'none',
      next: () => this.next(),
      back: () => this.setState({ step: Math.max(0, s.step - 1) }),
      backColor: s.step === 0 ? 'transparent' : '#5A6E86',
      nextLabel: s.step === 5 ? 'Submit' : 'Continue',
      // step 6: qualification verdict + delivery status
      qualifyTitle: (['200–500', '500–1,000', '1,000+'].includes(s.bVolume) || parseInt(s.bLocations, 10) > 1) ? "You're a fit." : 'Worth twenty minutes.',
      // Someone who has already talked to the receptionist gets that acknowledged, not repeated at.
      qualifyLead: s.demoUsed ? "You've already heard exactly what your patients would hear. " : '',
      qualifyBody: ['200–500', '500–1,000', '1,000+'].includes(s.bVolume)
        ? `At ${s.bVolume} calls a month, even a small miss rate is real money. Pick a time below; on the call we'll map exactly where yours are going.`
        : (parseInt(s.bLocations, 10) > 1
          ? `Across ${s.bLocations} locations, missed calls multiply fast. Pick a time below; on the call we'll map exactly where yours are going.`
          : 'Under 200 calls a month, the math still holds: five missed calls a week is roughly $66,000 a year at conservative numbers. The call will tell you if it makes sense, no pressure either way.'),
      sentNote: s.sendState === 'sent' ? 'Your details just landed in our inbox. We reply within one business day.'
        : (s.sendState === 'saved' ? 'Details received. We reply within one business day.'
        : (s.sendState === 'sending' ? 'Sending your details to our inbox…' : 'Details saved. We reply within one business day.'))
    };
  }
}
      );
    }
  };
})();
