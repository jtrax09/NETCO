import React from 'react';

interface NetcoLogoProps {
  variant?: 'banner' | 'compact';
  className?: string;
}

export const NETCO_LOGO_URL = '/assets/aistudio/NETCO_Cyber_Network_Logo_098b26cc.png';

export function NetcoLogo({ variant = 'compact', className = '' }: NetcoLogoProps) {
  if (variant === 'banner') {
    return (
      <div className={`inline-flex items-center justify-center bg-transparent shrink-0 ${className}`}>
        <img
          src={NETCO_LOGO_URL}
          alt="NETCO — Connect. Control. Experience. Network Management System"
          className="w-full max-w-[240px] sm:max-w-[270px] h-auto object-contain select-none drop-shadow-[0_4px_14px_rgba(8,11,18,0.45)] dark:drop-shadow-[0_4px_18px_rgba(22,184,255,0.28)]"
        />
      </div>
    );
  }

  return (
    <div className={`inline-flex items-center justify-center bg-transparent shrink-0 ${className}`}>
      <img
        src={NETCO_LOGO_URL}
        alt="NETCO Network Management System"
        className="h-9 sm:h-11 w-auto object-contain select-none drop-shadow-[0_2px_8px_rgba(8,11,18,0.4)] dark:drop-shadow-[0_2px_10px_rgba(22,184,255,0.25)]"
      />
    </div>
  );
}
