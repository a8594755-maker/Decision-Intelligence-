const VARIANTS = {
  /* Default: subtle border + light shadow */
  default: [
    'bg-[var(--surface-card)]',
    'border border-[var(--border-default)]',
    'shadow-[var(--shadow-card)]',
    'rounded-xl',
  ].join(' '),

  /* Elevated: deeper shadow, no border — for KPIs & key metrics */
  elevated: [
    'bg-[var(--surface-card)]',
    'shadow-[var(--shadow-elevated)]',
    'rounded-xl',
  ].join(' '),

  /* Alert: left colour stripe — for warnings & risk items */
  alert: [
    'bg-[var(--surface-card)]',
    'border-l-4 border-l-[var(--risk-critical)]',
    'border border-[var(--border-default)]',
    'rounded-r-xl rounded-l-none',
  ].join(' '),

  /* Glass: translucent — for overlays only */
  glass: [
    'bg-white/60 dark:bg-black/40',
    'backdrop-blur-xl',
    'border border-white/20',
    'rounded-xl',
  ].join(' '),

  /* Filled: brand-coloured solid — for primary CTAs */
  filled: [
    'bg-indigo-600 text-white',
    'rounded-xl border-0',
    'shadow-[0_4px_16px_rgba(79,70,229,0.3)]',
  ].join(' '),
};

export const Card = ({
  children,
  className = '',
  variant = 'default',
  onClick,
  hoverEffect = false,
}) => {
  return (
    <div
      onClick={onClick}
      className={[
        VARIANTS[variant] || VARIANTS.default,
        'p-4 md:p-6',
        hoverEffect
          ? 'hover:shadow-[var(--shadow-elevated)] hover:border-indigo-500/40 cursor-pointer transition-all duration-200'
          : '',
        className,
      ].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  );
};

export default Card;
