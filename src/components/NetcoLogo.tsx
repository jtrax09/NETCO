import React, { useState } from 'react';

interface TraxLogoProps {
  variant?: 'banner' | 'compact';
  className?: string;
}

export const TRAX_LOGO_URL = '/assets/trax-link-app-icon.jpg';
export const NETCO_LOGO_URL = TRAX_LOGO_URL;

export function TraxMark({ className = 'w-8 h-8' }: { className?: string }) {
  const [imgFailed, setImgFailed] = useState(false);

  if (imgFailed) {
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

  return (
    <img
      src="/src/assets/images/trax_link_app_icon_1795820604926.jpg"
      alt="TRAX LINK App Icon"
      referrerPolicy="no-referrer"
      onError={() => setImgFailed(true)}
      className={`${className} rounded-[22%] object-cover border border-sky-400/35`}
    />
  );
}

export function TraxLogo({ variant = 'compact', className = '' }: TraxLogoProps) {
  if (variant === 'banner') {
    return (
      <div className={`inline-flex items-center gap-3.5 select-none shrink-0 ${className}`}>
        <TraxMark className="w-11 h-11 shrink-0 drop-shadow-[0_0_12px_rgba(255,212,0,0.3)]" />
        <div className="text-left leading-none">
          <div className="font-futuristic text-xl sm:text-2xl font-extrabold tracking-[0.14em] text-white">
            TRAX <span className="text-[#FFD400]">LINK</span>
          </div>
          <div className="font-mono text-[10px] tracking-[0.26em] text-zinc-400 mt-1.5">
            CONNECT. MANAGE. GROW.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`inline-flex items-center gap-2.5 select-none shrink-0 whitespace-nowrap ${className}`}>
      <TraxMark className="w-8 h-8 shrink-0 drop-shadow-[0_0_8px_rgba(255,212,0,0.22)]" />
      <span className="font-futuristic text-sm sm:text-base font-extrabold tracking-[0.12em] text-[#101010] dark:text-white whitespace-nowrap">
        TRAX <span className="text-[#B8860B] dark:text-[#FFD400]">LINK</span>
      </span>
    </div>
  );
}

export const NetcoLogo = TraxLogo;
