import React, { useEffect } from 'react';
import { AnimatePresence, motion, type Transition } from 'motion/react';

export const NATIVE_SPRING: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 34,
  mass: 0.82,
};

export const MODAL_SPRING: Transition = {
  type: 'spring',
  stiffness: 460,
  damping: 36,
  mass: 0.78,
};

export const VIEW_TRANSITION: Transition = {
  duration: 0.19,
  ease: [0.16, 1, 0.3, 1],
};

interface MobilePageTransitionProps {
  children: React.ReactNode;
  className?: string;
  direction?: number;
}

const pageVariants = {
  enter: (direction: number) => ({
    opacity: 0,
    x: direction > 0 ? 18 : direction < 0 ? -18 : 0,
    y: direction === 0 ? 10 : 4,
    scale: 0.993,
  }),
  center: {
    opacity: 1,
    x: 0,
    y: 0,
    scale: 1,
  },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction > 0 ? -14 : direction < 0 ? 14 : 0,
    y: direction === 0 ? -6 : 0,
    scale: 0.995,
  }),
};

export function MobilePageTransition({
  children,
  className = '',
  direction = 0,
}: MobilePageTransitionProps) {
  return (
    <motion.div
      custom={direction}
      variants={pageVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={VIEW_TRANSITION}
      className={className}
    >
      {children}
    </motion.div>
  );
}

interface MobileModalProps {
  open: boolean;
  onClose: () => void;
  maxWidthClass?: string;
  panelClassName?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}

export function MobileModal({
  open,
  onClose,
  maxWidthClass = 'max-w-md',
  panelClassName = '',
  ariaLabel,
  children,
}: MobileModalProps) {
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          className="no-print fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            aria-hidden="true"
          />
          <motion.div
            initial={{ opacity: 0, y: 36, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={MODAL_SPRING}
            className={`relative z-10 w-full ${maxWidthClass} bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 rounded-t-[26px] sm:rounded-2xl p-5 sm:p-6 shadow-2xl max-h-[90vh] overflow-y-auto ${panelClassName}`}
          >
            <div
              className="sm:hidden w-9 h-1 rounded-full bg-zinc-400/35 mx-auto mb-3"
              aria-hidden="true"
            />
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  side?: 'left' | 'right';
  panelClassName?: string;
  wrapperClassName?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}

export function MobileDrawer({
  open,
  onClose,
  side = 'right',
  panelClassName = 'max-w-lg w-full h-full bg-white dark:bg-[#161618] border-l border-stone-200 dark:border-white/10 p-6 overflow-y-auto',
  wrapperClassName = '',
  ariaLabel,
  children,
}: MobileDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  const offscreenX = side === 'left' ? '-100%' : '100%';

  return (
    <AnimatePresence>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          className={`no-print fixed inset-0 z-50 flex ${side === 'right' ? 'justify-end' : 'justify-start'} ${wrapperClassName}`}
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            aria-hidden="true"
          />
          <motion.div
            initial={{ x: offscreenX, opacity: 0.8 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: offscreenX, opacity: 0.8 }}
            transition={NATIVE_SPRING}
            className={`relative z-10 ${panelClassName}`}
          >
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
