// All words in the video live here. One object per scene: change a line, re-render. `*…*` marks the accent word(s)
// (Lora italic, olive). The Arabic is Levantine.
export interface SceneCopy {
  /** Small label above the headline (hidden with the text). */
  tag: string;
  en: string;
  ar: string;
  /** A chip that pops next to the screenshot (hidden with the text). */
  callout?: string;
}

export const copy = {
  hook: { tag: '', en: 'Here’s how it *works.*', ar: 'هيك بيشتغل' } satisfies SceneCopy,
  steps: [
    {
      tag: 'Step 1',
      en: 'Tell it what you *want.*',
      ar: 'احكي شو بدك بكلمات عادية',
      callout: 'Plain words, no setup',
    },
    {
      tag: 'Step 2',
      en: 'Review the plan and the *team.*',
      ar: 'راجع الخطة والفريق',
      callout: '2 milestones · 4 tasks · 3 helpers',
    },
    {
      tag: 'Step 3',
      en: 'Approve it. *One click.*',
      ar: 'وافق بضغطة وحدة',
      callout: 'You decide',
    },
    {
      tag: 'Step 4',
      en: 'Helpers get to *work.*',
      ar: 'المساعدين بيشتغلوا عنك',
      callout: 'Every action logged',
    },
    {
      tag: 'Step 5',
      en: 'Follow progress on your *board.*',
      ar: 'تابع التقدم على اللوحة',
      callout: '29 of 60 done',
    },
    {
      tag: 'Step 6',
      en: 'You approve every *result.*',
      ar: 'وإنت بتوافق على كل نتيجة',
      callout: 'Awaiting your review',
    },
  ] satisfies SceneCopy[],
  close: {
    tag: '',
    en: 'Get your life and projects *in order.*',
    ar: 'رتّب حياتك ومشاريعك',
    /** The plain closing line, shown after the list of steps. */
    line: { en: 'Start with one sentence.', ar: 'ابدأ بجملة وحدة' },
  },
} as const;
