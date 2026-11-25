import React from 'react';

interface TraxLogoProps {
  variant?: 'banner' | 'compact';
  className?: string;
}

export const TRAX_LOGO_URL = '/assets/aistudio/NETCO_Cyber_Network_Logo_098b26cc.png';
export const NETCO_LOGO_URL = TRAX_LOGO_URL;

export function TraxMark({ className = 'w-8 h-8' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="2" width="36" height="36" rx="10" fill="#101010" stroke="#FFD400" strokeWidth="2.2" />
      <path
        d="M11 14H29M20 14V27"
        stroke="#FFD400"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 24.5C14.8 26.8 17.3 28 20 28C22.7 28 25.2 26.8 27 24.5"
        stroke="#FAFAFA"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="29" cy="14" r="2.2" fill="#FFD400" />
    </svg>
  );
}

export function TraxLogo({ variant = 'compact', className = '' }: TraxLogoProps) {
  if (variant === 'banner') {
    return (
      <div className={`inline-flex items-center gap-3 select-none shrink-0 ${className}`}>
        <TraxMark className="w-11 h-11 shrink-0" />
        <div className="text-left leading-none">
          <div className="font-display text-xl sm:text-2xl font-extrabold tracking-tight text-white">
            TRAX <span className="text-[#FFD400]">LINK</span>
          </div>
          <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-400 mt-1">
            CONNECT. MANAGE. GROW.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`inline-flex items-center gap-2.5 select-none shrink-0 whitespace-nowrap ${className}`}>
      <TraxMark className="w-8 h-8 shrink-0" />
      <span className="font-display text-base sm:text-lg font-extrabold tracking-tight text-[#101010] dark:text-white whitespace-nowrap">
        TRAX <span className="text-[#B8860B] dark:text-[#FFD400]">LINK</span>
      </span>
    </div>
  );
}

export const NetcoLogo = TraxLogo;
