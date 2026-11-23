import React, { useId } from 'react';
import type { AppLanguage } from '../lib/i18n.ts';

function TanzaniaFlag({ className = 'w-4 h-3' }: { className?: string }) {
  const clipId = useId();
  return (
    <svg
      viewBox="0 0 24 16"
      aria-hidden="true"
      className={`${className} rounded-[2px] shrink-0 shadow-[0_0_0_1px_rgba(15,23,42,0.14)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.18)]`}
    >
      <defs>
        <clipPath id={clipId}>
          <rect width="24" height="16" rx="2" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <polygon points="0,0 24,0 0,16" fill="#1EB53A" />
        <polygon points="24,0 24,16 0,16" fill="#00A3DD" />
        <line x1="-2" y1="17.33" x2="26" y2="-1.33" stroke="#FCD116" strokeWidth="5.2" />
        <line x1="-2" y1="17.33" x2="26" y2="-1.33" stroke="#000000" strokeWidth="3.3" />
      </g>
    </svg>
  );
}

function UkFlag({ className = 'w-4 h-3' }: { className?: string }) {
  const clipId = useId();
  return (
    <svg
      viewBox="0 0 24 16"
      aria-hidden="true"
      className={`${className} rounded-[2px] shrink-0 shadow-[0_0_0_1px_rgba(15,23,42,0.14)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.18)]`}
    >
      <defs>
        <clipPath id={clipId}>
          <rect width="24" height="16" rx="2" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect width="24" height="16" fill="#012169" />
        <line x1="0" y1="0" x2="24" y2="16" stroke="#FFFFFF" strokeWidth="3.2" />
        <line x1="24" y1="0" x2="0" y2="16" stroke="#FFFFFF" strokeWidth="3.2" />
        <line x1="0" y1="0" x2="24" y2="16" stroke="#C8102E" strokeWidth="1.5" />
        <line x1="24" y1="0" x2="0" y2="16" stroke="#C8102E" strokeWidth="1.5" />
        <line x1="12" y1="0" x2="12" y2="16" stroke="#FFFFFF" strokeWidth="4.4" />
        <line x1="0" y1="8" x2="24" y2="8" stroke="#FFFFFF" strokeWidth="4.4" />
        <line x1="12" y1="0" x2="12" y2="16" stroke="#C8102E" strokeWidth="2.6" />
        <line x1="0" y1="8" x2="24" y2="8" stroke="#C8102E" strokeWidth="2.6" />
      </g>
    </svg>
  );
}

interface LanguageSwitcherProps {
  lang: AppLanguage;
  onToggleLang: () => void;
  showFullLabels?: boolean;
}

export function LanguageSwitcher({
  lang,
  onToggleLang,
  showFullLabels = false,
}: LanguageSwitcherProps) {
  const selectLanguage = (target: AppLanguage) => {
    if (target !== lang) {
      onToggleLang();
    }
  };

  return (
    <div
      role="group"
      aria-label="Language selector"
      className="inline-flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-[#080B12] border border-slate-200 dark:border-slate-700/80 min-h-[38px] sm:min-h-[40px]"
    >
      <button
        type="button"
        onClick={() => selectLanguage('en')}
        aria-pressed={lang === 'en'}
        aria-label="Switch to English"
        className={`inline-flex items-center gap-1.5 px-2 sm:px-2.5 h-[32px] sm:h-[34px] rounded-md text-[11px] font-semibold transition-all cursor-pointer ${
          lang === 'en'
            ? 'bg-white dark:bg-[#101827] text-slate-900 dark:text-white shadow-xs border border-slate-200/80 dark:border-slate-700'
            : 'text-slate-500 dark:text-[#8793A5] hover:text-slate-900 dark:hover:text-white border border-transparent'
        }`}
      >
        <UkFlag />
        <span>{showFullLabels ? 'English' : 'EN'}</span>
      </button>

      <button
        type="button"
        onClick={() => selectLanguage('sw')}
        aria-pressed={lang === 'sw'}
        aria-label="Badili kwenda Kiswahili"
        className={`inline-flex items-center gap-1.5 px-2 sm:px-2.5 h-[32px] sm:h-[34px] rounded-md text-[11px] font-semibold transition-all cursor-pointer ${
          lang === 'sw'
            ? 'bg-white dark:bg-[#101827] text-slate-900 dark:text-white shadow-xs border border-slate-200/80 dark:border-slate-700'
            : 'text-slate-500 dark:text-[#8793A5] hover:text-slate-900 dark:hover:text-white border border-transparent'
        }`}
      >
        <TanzaniaFlag />
        <span>{showFullLabels ? 'Kiswahili' : 'SW'}</span>
      </button>
    </div>
  );
}
