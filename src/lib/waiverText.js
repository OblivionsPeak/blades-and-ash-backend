// The Client Service Agreement, Liability Waiver & Release — the one copy.
// The website fetches this to render the signing page, and the emailed copy
// is built from it too, so the client reads, signs, and receives the same
// wording. Bump WAIVER_VERSION in forms.js whenever this text changes.
//
// Paragraphs are plain strings; `bullets` is an optional list rendered
// after the paragraph.

export const WAIVER_TITLE = 'Client Service Agreement, Liability Waiver & Release';

export const WAIVER_INTRO =
  'Please read this agreement carefully in full before signing. By signing below, you acknowledge that you have read, understood, and agree to be bound by every section of this document.';

export const WAIVER_SECTIONS = [
  {
    title: '1. Non-Refundable Services',
    body:
      'All services rendered at Blade & Ash Studio are non-refundable. Once a service has been performed, no refund will be issued for any reason, including but not limited to dissatisfaction with the result, change of mind, or subsequent styling preferences. If a concern arises with a service, the client agrees to notify the stylist so that a correction may be discussed.',
  },
  {
    title: '2. Deposit & Card on File',
    body:
      'A non-refundable deposit is required to reserve all appointments and will be applied toward the total cost of the scheduled service. A valid credit or debit card must be kept on file as a condition of booking. The client authorizes Blade & Ash Studio to charge the card on file for the deposit, remaining service balance, applicable cancellation or no-show fees as outlined in this agreement, and any other charges owed under this agreement.',
  },
  {
    title: '3. Cancellation Policy',
    body: 'The client agrees to the following cancellation terms:',
    bullets: [
      'Cancellations made at least 72 hours before the scheduled appointment: 50% of the total service fee will be charged to the card on file.',
      'Cancellations made the day of the appointment, or no-shows: 100% of the total service fee will be charged to the card on file.',
    ],
  },
  {
    title: '4. Photo & Video Release',
    body:
      "The client grants Blade & Ash Studio the right to photograph and/or video record the client's hair and service results, and to use, reproduce, publish, and post such photos and videos in any format and on any platform — including but not limited to social media, the studio website, and print or digital marketing materials — without further compensation or approval. This release applies for the full duration the studio wishes to use the content.",
  },
  {
    title: '5. Assumption of Risk & Liability Release',
    body:
      "The client acknowledges that certain salon services (including but not limited to chemical treatments, coloring, extensions, and cutting services) carry inherent risks, including allergic or chemical reactions, skin or scalp irritation, hair breakage, and other unforeseen reactions. The client releases and holds harmless Blade & Ash Studio and its owner/stylist from any and all liability, claims, damages, or expenses arising from: (a) any chemical reaction, allergic reaction, injury, or adverse outcome experienced by the client or any guest accompanying the client; and (b) any injury, accident, or property damage occurring inside the client's suite or in any common/community area of the building. This release applies to the fullest extent permitted by law.",
  },
  {
    title: '6. Acknowledgment',
    body:
      'By signing below, the client confirms they are 18 years of age or older (or are signing as the parent/legal guardian of a minor client), have read this entire agreement, understand its terms, and voluntarily agree to be bound by them.',
  },
];
