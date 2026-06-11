/* 1891 Interpreter — sandbox seed datasets.
 *
 * Three "vibes" (scenario datasets), one shape. Every record is synthetic:
 * invented people, @example.com addresses only, public place names at most.
 * Dates are computed relative to *now* at load time so the day board always
 * looks alive. Shapes mirror the live product's objects (Jobs, Interpreters,
 * Invoices, smart-fill candidates with the public 30/20/20/15/15 breakdown).
 *
 * Attaches exactly one global: window.ITP_SANDBOX_SEEDS.
 */
(function () {
  'use strict';

  // d(dayOffset, hour, min) → ISO string relative to today, local time.
  function d(dayOffset, hour, min) {
    var t = new Date();
    t.setDate(t.getDate() + dayOffset);
    t.setHours(hour, min || 0, 0, 0);
    return t.toISOString();
  }

  function interp(id, name, deaf, langs, modalities, certs, rate, jobs30) {
    return {
      interpreter_id: id, display_name: name, deaf: deaf,
      languages: langs, modalities: modalities, certifications: certs,
      base_rate: rate, jobs_30d: jobs30, status: 'active'
    };
  }

  // Candidate scores follow the public smart-fill weights:
  // certification 30 · location 20 · requestor preference 20 ·
  // workload balance 15 · prior performance 15.
  function cand(id, name, deaf, c, l, p, w, perf, note) {
    return {
      interpreter_id: id, display_name: name, deaf: deaf,
      score: { total: c + l + p + w + perf, max: 100,
               breakdown: { certification: c, location: l, preference: p, workload: w, performance: perf } },
      note: note
    };
  }

  // ---------------------------------------------------------------------------
  // Vibe 1 — medical: hospital-heavy ASL agency (the flagship demo).
  // ---------------------------------------------------------------------------

  var MEDICAL = {
    label: 'Medical-heavy ASL agency',
    agency: { name: 'Riverside Interpreting', tagline: 'Sample agency — medical & community ASL', slug: 'riverside' },
    interpreters: [
      interp('i-01', 'Maria Rivera',    true,  ['ASL'], ['on-site', 'VRI'], ['CDI'],            '$78/hr', 14),
      interp('i-02', 'Marcus Thompson', false, ['ASL'], ['on-site', 'VRI'], ['NIC-Advanced'],   '$64/hr', 18),
      interp('i-03', 'Dana Whitfield',  false, ['ASL'], ['on-site'],        ['NIC', 'EIPA 4.6'],'$58/hr', 11),
      interp('i-04', 'Theo Nakamura',   false, ['ASL'], ['VRI'],            ['NIC'],            '$55/hr', 22),
      interp('i-05', 'Renee Calloway',  true,  ['ASL', 'ProTactile'], ['on-site'], ['CDI'],     '$80/hr', 8),
      interp('i-06', 'Jordan Pike',     false, ['ASL'], ['on-site', 'VRI'], ['NIC-Master'],     '$70/hr', 16),
      interp('i-07', 'Alice Beaumont',  false, ['ASL'], ['on-site'],        ['NIC'],            '$56/hr', 6)
    ],
    clients: [
      { client_id: 'c-01', name: 'Catoctin Regional Medical', kind: 'Hospital network', terms: 'NET30', contact: 'scheduling@example.com' },
      { client_id: 'c-02', name: 'Midstate Behavioral Health', kind: 'Clinic group', terms: 'NET30', contact: 'access@example.com' },
      { client_id: 'c-03', name: 'Riverside Family Practice', kind: 'Private practice', terms: 'DUE_ON_RECEIPT', contact: 'frontdesk@example.com' },
      { client_id: 'c-04', name: 'Frederick Dental Collective', kind: 'Dental group', terms: 'NET30', contact: 'office@example.com' },
      { client_id: 'c-05', name: 'Liberty Hill Community College', kind: 'Higher ed', terms: 'NET30', contact: 'access.services@example.com' }
    ],
    jobs: [
      { job_id: 'J-1041', status: 'OPEN', client_id: 'c-01', setting: 'Cardiology follow-up',
        location: 'Catoctin Regional — Tower B', modality: 'on-site', language: 'ASL',
        starts_at: d(0, 14, 0), ends_at: d(0, 15, 0), consumer: 'L.M.', pay_estimate: '$128–$156',
        requirements: ['Medical experience', 'Consumer prefers female interpreter'], team_size: 1 },
      { job_id: 'J-1042', status: 'OPEN', client_id: 'c-02', setting: 'Intake session (sensitive)',
        location: 'Midstate Behavioral — Suite 240', modality: 'on-site', language: 'ASL',
        starts_at: d(1, 10, 0), ends_at: d(1, 11, 30), consumer: 'R.T.', pay_estimate: '$174–$210',
        requirements: ['CDI strongly recommended', 'Strict privacy mode'], team_size: 2 },
      { job_id: 'J-1043', status: 'OPEN', client_id: 'c-05', setting: 'Biology lecture (recurring)',
        location: 'Liberty Hill CC — Science Hall 110', modality: 'on-site', language: 'ASL',
        starts_at: d(1, 13, 0), ends_at: d(1, 14, 15), consumer: 'K.D.', pay_estimate: '$95–$110',
        requirements: ['Recurring Tue/Thu through the semester'], team_size: 1 },
      { job_id: 'J-1044', status: 'OPEN', client_id: 'c-03', setting: 'Annual physical',
        location: 'VRI', modality: 'VRI', language: 'ASL',
        starts_at: d(0, 16, 30), ends_at: d(0, 17, 0), consumer: 'B.A.', pay_estimate: '$48–$60',
        requirements: [], team_size: 1 },
      { job_id: 'J-1038', status: 'OFFERED', client_id: 'c-01', setting: 'Pre-op consult',
        location: 'Catoctin Regional — Main', modality: 'on-site', language: 'ASL',
        starts_at: d(1, 8, 30), ends_at: d(1, 9, 30), consumer: 'S.V.', pay_estimate: '$128–$156',
        offered_to: 'Marcus Thompson', requirements: ['Medical experience'], team_size: 1 },
      { job_id: 'J-1036', status: 'CLAIMED', client_id: 'c-04', setting: 'Crown placement',
        location: 'Frederick Dental — Market St', modality: 'on-site', language: 'ASL',
        starts_at: d(0, 11, 0), ends_at: d(0, 12, 0), consumer: 'P.O.', pay_estimate: '$96–$118',
        claimed_by: 'Dana Whitfield', requirements: [], team_size: 1 },
      { job_id: 'J-1031', status: 'CONFIRMED', client_id: 'c-01', setting: 'Labor & delivery (on call)',
        location: 'Catoctin Regional — L&D', modality: 'on-site', language: 'ASL',
        starts_at: d(0, 19, 0), ends_at: d(0, 23, 0), consumer: 'initials withheld', pay_estimate: '$420–$480',
        claimed_by: 'Maria Rivera', requirements: ['CDI', 'Team of 2 on standby'], team_size: 2 },
      { job_id: 'J-1030', status: 'CONFIRMED', client_id: 'c-02', setting: 'Group session',
        location: 'Midstate Behavioral — Annex', modality: 'on-site', language: 'ASL',
        starts_at: d(2, 15, 0), ends_at: d(2, 16, 30), consumer: 'group', pay_estimate: '$174–$200',
        claimed_by: 'Jordan Pike', requirements: [], team_size: 1 },
      { job_id: 'J-1024', status: 'COMPLETED', client_id: 'c-01', setting: 'ER follow-up',
        location: 'Catoctin Regional — Main', modality: 'on-site', language: 'ASL',
        starts_at: d(-1, 9, 0), ends_at: d(-1, 10, 0), consumer: 'T.W.', pay_estimate: '$128',
        claimed_by: 'Marcus Thompson', requirements: [], team_size: 1 },
      { job_id: 'J-1022', status: 'COMPLETED', client_id: 'c-05', setting: 'Advising appointment',
        location: 'Liberty Hill CC — Admin', modality: 'VRI', language: 'ASL',
        starts_at: d(-2, 14, 0), ends_at: d(-2, 14, 45), consumer: 'K.D.', pay_estimate: '$68',
        claimed_by: 'Theo Nakamura', requirements: [], team_size: 1 }
    ],
    smartfill: {
      'J-1041': [
        cand('i-02', 'Marcus Thompson', false, 30, 20, 18, 9, 13, 'Strong cardiology history with this client'),
        cand('i-01', 'Maria Rivera',    true,  30, 16, 20, 6, 14, 'Requestor-preferred · CDI'),
        cand('i-03', 'Dana Whitfield',  false, 30, 14, 10, 12, 11, 'Available, lighter medical record'),
        cand('i-07', 'Alice Beaumont',  false, 30, 12, 6, 15, 10, 'Most rested this week'),
        cand('i-04', 'Theo Nakamura',   false, 30, 8, 4, 5, 12, 'VRI-primary; on-site distance is a stretch')
      ],
      'J-1042': [
        cand('i-05', 'Renee Calloway',  true,  30, 18, 20, 13, 14, 'CDI · prior sessions with this clinic'),
        cand('i-01', 'Maria Rivera',    true,  30, 18, 14, 6, 14, 'CDI · heavy load this week'),
        cand('i-06', 'Jordan Pike',     false, 30, 16, 12, 9, 13, 'Hearing teamer for the CDI pairing'),
        cand('i-03', 'Dana Whitfield',  false, 30, 14, 8, 12, 11, 'Available as second-position teamer')
      ],
      'J-1043': [
        cand('i-03', 'Dana Whitfield',  false, 30, 18, 16, 12, 12, 'EIPA 4.6 · education specialist'),
        cand('i-07', 'Alice Beaumont',  false, 30, 16, 10, 15, 10, 'Open Tue/Thu all semester'),
        cand('i-02', 'Marcus Thompson', false, 30, 14, 8, 9, 13, 'Capable; semester recurrence strains load'),
        cand('i-04', 'Theo Nakamura',   false, 30, 8, 6, 5, 12, 'Prefers VRI')
      ],
      'J-1044': [
        cand('i-04', 'Theo Nakamura',   false, 30, 20, 12, 5, 12, 'VRI-first · fastest connect record'),
        cand('i-06', 'Jordan Pike',     false, 30, 20, 10, 9, 13, 'Available in that window'),
        cand('i-07', 'Alice Beaumont',  false, 30, 20, 6, 15, 10, 'Lightest load')
      ]
    },
    invoices: [
      { invoice_id: 'INV-2031', client_id: 'c-01', period: 'May 16–31', amount: 4862.00, status: 'sent', due: d(5, 0, 0), lines: 14 },
      { invoice_id: 'INV-2030', client_id: 'c-02', period: 'May 16–31', amount: 1740.50, status: 'sent', due: d(-3, 0, 0), lines: 6 },
      { invoice_id: 'INV-2029', client_id: 'c-05', period: 'May 1–31', amount: 2210.00, status: 'paid', due: d(-12, 0, 0), lines: 9 },
      { invoice_id: 'INV-2032', client_id: 'c-03', period: 'June 1–15', amount: 384.00, status: 'draft', due: null, lines: 3 }
    ]
  };

  // ---------------------------------------------------------------------------
  // Vibe 2 — education: K-12 + post-secondary.
  // ---------------------------------------------------------------------------

  var EDUCATION = {
    label: 'K-12 & college agency',
    agency: { name: 'Blue Ridge Access', tagline: 'Sample agency — education ASL & CART', slug: 'blueridge' },
    interpreters: [
      interp('i-11', 'Priya Shah',      false, ['ASL'], ['on-site'], ['EIPA 4.8', 'NIC'], '$54/hr', 19),
      interp('i-12', 'Cole Maxwell',    false, ['ASL'], ['on-site', 'VRI'], ['EIPA 4.2'], '$48/hr', 15),
      interp('i-13', 'Simone Duval',    true,  ['ASL'], ['on-site'], ['CDI'], '$76/hr', 7),
      interp('i-14', 'Harriet Linden',  false, ['CART'], ['on-site', 'remote'], ['NCRA-CRC'], '$92/hr', 12),
      interp('i-15', 'Gus Okafor',      false, ['ASL'], ['on-site'], ['NIC', 'EIPA 4.0'], '$52/hr', 21),
      interp('i-16', 'Wren Castillo',   false, ['ASL'], ['VRI'], ['NIC'], '$50/hr', 10)
    ],
    clients: [
      { client_id: 'c-11', name: 'Frederick County Public Schools', kind: 'K-12 district', terms: 'NET30', contact: 'ap@example.com' },
      { client_id: 'c-12', name: 'Liberty Hill Community College', kind: 'Higher ed', terms: 'NET30', contact: 'access.services@example.com' },
      { client_id: 'c-13', name: 'Monocacy Montessori', kind: 'Private school', terms: 'NET15', contact: 'admin@example.com' },
      { client_id: 'c-14', name: 'Summit Vocational Institute', kind: 'Trade school', terms: 'NET30', contact: 'studentlife@example.com' }
    ],
    jobs: [
      { job_id: 'J-2107', status: 'OPEN', client_id: 'c-11', setting: 'IEP meeting',
        location: 'Gov. Thomas Johnson HS', modality: 'on-site', language: 'ASL',
        starts_at: d(0, 15, 30), ends_at: d(0, 16, 30), consumer: 'parent (Deaf)', pay_estimate: '$78–$92',
        requirements: ['Parent-facing; education vocabulary'], team_size: 1 },
      { job_id: 'J-2108', status: 'OPEN', client_id: 'c-12', setting: 'Statistics midterm review',
        location: 'Liberty Hill CC — Hall 2', modality: 'on-site', language: 'CART',
        starts_at: d(1, 11, 0), ends_at: d(1, 12, 30), consumer: 'M.J.', pay_estimate: '$184–$210',
        requirements: ['CART — realtime captioning'], team_size: 1 },
      { job_id: 'J-2109', status: 'OPEN', client_id: 'c-14', setting: 'Welding safety orientation',
        location: 'Summit Vocational — Welding bay', modality: 'on-site', language: 'ASL',
        starts_at: d(2, 9, 0), ends_at: d(2, 11, 0), consumer: 'D.P.', pay_estimate: '$140–$165',
        requirements: ['Technical vocabulary', 'PPE provided on site'], team_size: 1 },
      { job_id: 'J-2103', status: 'CLAIMED', client_id: 'c-11', setting: 'Algebra II (daily block)',
        location: 'Oakdale Middle', modality: 'on-site', language: 'ASL',
        starts_at: d(0, 9, 15), ends_at: d(0, 10, 0), consumer: 'student', pay_estimate: '$62',
        claimed_by: 'Priya Shah', requirements: ['EIPA 4.0+'], team_size: 1 },
      { job_id: 'J-2101', status: 'CONFIRMED', client_id: 'c-13', setting: 'Parent night',
        location: 'Monocacy Montessori', modality: 'on-site', language: 'ASL',
        starts_at: d(1, 18, 0), ends_at: d(1, 19, 30), consumer: 'two Deaf parents', pay_estimate: '$117–$140',
        claimed_by: 'Simone Duval', requirements: ['CDI preferred for mixed audience'], team_size: 2 },
      { job_id: 'J-2096', status: 'COMPLETED', client_id: 'c-12', setting: 'Chemistry lab',
        location: 'Liberty Hill CC — Lab 4', modality: 'on-site', language: 'ASL',
        starts_at: d(-1, 13, 0), ends_at: d(-1, 15, 0), consumer: 'M.J.', pay_estimate: '$124',
        claimed_by: 'Gus Okafor', requirements: [], team_size: 1 }
    ],
    smartfill: {
      'J-2107': [
        cand('i-13', 'Simone Duval',   true,  30, 18, 20, 11, 13, 'CDI · parent-meeting specialist'),
        cand('i-11', 'Priya Shah',     false, 30, 18, 16, 7, 13, 'Knows the school; heavy daily load'),
        cand('i-15', 'Gus Okafor',     false, 30, 16, 10, 8, 12, 'Available right after his block'),
        cand('i-12', 'Cole Maxwell',   false, 30, 14, 8, 12, 10, 'Lighter load this week')
      ],
      'J-2108': [
        cand('i-14', 'Harriet Linden', false, 30, 20, 18, 10, 14, 'Only NCRA-CRC writer on the roster'),
        cand('i-16', 'Wren Castillo',  false, 0, 20, 6, 12, 10, 'No CART certification — shown for contrast')
      ],
      'J-2109': [
        cand('i-15', 'Gus Okafor',     false, 30, 16, 14, 8, 12, 'Trade-program regular'),
        cand('i-12', 'Cole Maxwell',   false, 30, 16, 10, 12, 10, 'Available both hours'),
        cand('i-11', 'Priya Shah',     false, 30, 14, 8, 7, 13, 'Would need sub coverage for first period')
      ]
    },
    invoices: [
      { invoice_id: 'INV-3055', client_id: 'c-11', period: 'May (monthly)', amount: 11240.00, status: 'sent', due: d(8, 0, 0), lines: 41 },
      { invoice_id: 'INV-3054', client_id: 'c-12', period: 'May 16–31', amount: 3318.00, status: 'sent', due: d(-1, 0, 0), lines: 12 },
      { invoice_id: 'INV-3050', client_id: 'c-13', period: 'May 1–31', amount: 940.00, status: 'paid', due: d(-9, 0, 0), lines: 4 }
    ]
  };

  // ---------------------------------------------------------------------------
  // Vibe 3 — spoken-mix: spoken-language + ASL, courts & business.
  // ---------------------------------------------------------------------------

  var SPOKEN = {
    label: 'Spoken + signed mixed agency',
    agency: { name: 'Patapsco Language Partners', tagline: 'Sample agency — spoken, signed, courts & business', slug: 'patapsco' },
    interpreters: [
      interp('i-21', 'Lucia Ferreira',  false, ['Spanish', 'Portuguese'], ['on-site', 'OPI', 'VRI'], ['State court cert'], '$62/hr', 17),
      interp('i-22', 'Wei Chen',        false, ['Mandarin'], ['on-site', 'OPI'], ['Medical interpreter cert'], '$66/hr', 13),
      interp('i-23', 'Yusuf Diallo',    false, ['French', 'Wolof'], ['OPI', 'VRI'], [], '$54/hr', 9),
      interp('i-24', 'Marie-Claude Joseph', false, ['Haitian Creole'], ['on-site', 'OPI'], ['Medical interpreter cert'], '$60/hr', 15),
      interp('i-25', 'Maria Rivera',    true,  ['ASL'], ['on-site', 'VRI'], ['CDI'], '$78/hr', 12),
      interp('i-26', 'Sam Whitcomb',    false, ['ASL'], ['on-site', 'VRI'], ['NIC', 'SC:L'], '$74/hr', 14)
    ],
    clients: [
      { client_id: 'c-21', name: 'Catoctin County Court', kind: 'Court system', terms: 'NET45', contact: 'fiscal@example.com' },
      { client_id: 'c-22', name: 'Catoctin Regional Medical', kind: 'Hospital network', terms: 'NET30', contact: 'scheduling@example.com' },
      { client_id: 'c-23', name: 'Harborline Logistics', kind: 'Employer (HR)', terms: 'NET30', contact: 'hr@example.com' },
      { client_id: 'c-24', name: 'New Day Resettlement', kind: 'Nonprofit', terms: 'NET30', contact: 'programs@example.com' }
    ],
    jobs: [
      { job_id: 'J-3201', status: 'OPEN', client_id: 'c-21', setting: 'Status hearing',
        location: 'Catoctin County Court — Rm 3', modality: 'on-site', language: 'Spanish',
        starts_at: d(1, 9, 0), ends_at: d(1, 10, 0), consumer: 'defendant', pay_estimate: '$93–$110',
        requirements: ['Court-certified required'], team_size: 1 },
      { job_id: 'J-3202', status: 'OPEN', client_id: 'c-22', setting: 'Discharge instructions',
        location: 'OPI (phone)', modality: 'OPI', language: 'Haitian Creole',
        starts_at: d(0, 13, 30), ends_at: d(0, 14, 0), consumer: 'J.B.', pay_estimate: '$30–$38',
        requirements: ['Medical vocabulary'], team_size: 1 },
      { job_id: 'J-3203', status: 'OPEN', client_id: 'c-23', setting: 'New-hire safety training',
        location: 'Harborline DC-2', modality: 'on-site', language: 'ASL',
        starts_at: d(2, 8, 0), ends_at: d(2, 12, 0), consumer: 'three Deaf hires', pay_estimate: '$296–$340',
        requirements: ['Team of 2', 'Industrial setting'], team_size: 2 },
      { job_id: 'J-3198', status: 'OFFERED', client_id: 'c-24', setting: 'Benefits enrollment workshop',
        location: 'New Day — Community Rm', modality: 'on-site', language: 'French',
        starts_at: d(1, 14, 0), ends_at: d(1, 16, 0), consumer: 'workshop', pay_estimate: '$108–$130',
        offered_to: 'Yusuf Diallo', requirements: [], team_size: 1 },
      { job_id: 'J-3195', status: 'CONFIRMED', client_id: 'c-21', setting: 'Mediation session',
        location: 'Catoctin County Court — Annex', modality: 'on-site', language: 'ASL',
        starts_at: d(0, 10, 30), ends_at: d(0, 12, 30), consumer: 'petitioner', pay_estimate: '$148–$170',
        claimed_by: 'Sam Whitcomb', requirements: ['SC:L (legal) certification'], team_size: 1 },
      { job_id: 'J-3190', status: 'COMPLETED', client_id: 'c-22', setting: 'Oncology consult',
        location: 'Catoctin Regional — Tower A', modality: 'on-site', language: 'Mandarin',
        starts_at: d(-1, 11, 0), ends_at: d(-1, 12, 0), consumer: 'H.L.', pay_estimate: '$66',
        claimed_by: 'Wei Chen', requirements: [], team_size: 1 }
    ],
    smartfill: {
      'J-3201': [
        cand('i-21', 'Lucia Ferreira', false, 30, 18, 20, 9, 14, 'Court-certified · knows this docket'),
        cand('i-23', 'Yusuf Diallo',   false, 0, 18, 4, 13, 10, 'No Spanish — shown for contrast')
      ],
      'J-3202': [
        cand('i-24', 'Marie-Claude Joseph', false, 30, 20, 18, 9, 13, 'Medical cert · OPI-fast'),
        cand('i-23', 'Yusuf Diallo',   false, 0, 20, 6, 13, 10, 'French ≠ Haitian Creole — never auto-matched')
      ],
      'J-3203': [
        cand('i-26', 'Sam Whitcomb',   false, 30, 16, 16, 9, 13, 'Industrial-setting regular'),
        cand('i-25', 'Maria Rivera',   true,  30, 16, 14, 10, 14, 'CDI · strong teamer pairing'),
        cand('i-21', 'Lucia Ferreira', false, 0, 16, 4, 9, 14, 'No ASL — shown for contrast')
      ]
    },
    invoices: [
      { invoice_id: 'INV-4012', client_id: 'c-21', period: 'May (monthly)', amount: 6240.00, status: 'sent', due: d(14, 0, 0), lines: 22 },
      { invoice_id: 'INV-4011', client_id: 'c-22', period: 'May 16–31', amount: 2188.00, status: 'sent', due: d(-2, 0, 0), lines: 9 },
      { invoice_id: 'INV-4009', client_id: 'c-23', period: 'April training block', amount: 1480.00, status: 'paid', due: d(-20, 0, 0), lines: 3 }
    ]
  };

  window.ITP_SANDBOX_SEEDS = {
    default_vibe: 'medical',
    vibes: { medical: MEDICAL, education: EDUCATION, spoken_mix: SPOKEN }
  };
})();
