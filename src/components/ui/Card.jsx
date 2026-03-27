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
    'bg-[var(--brand-600)] text-white',
    'rounded-xl border-0',
    'shadow-[0_4px_16px_rgba(13,148,136,0.3)]',
  ].join(' '),
};

export const CARD_CATEGORIES = {
  data: '--cat-data',
  forecast: '--cat-forecast',
  plan: '--cat-plan',
  risk: '--cat-risk',
  analysis: '--cat-analysis',
  system: '--cat-system',
};

export const Card = ({
  children,
  className = '',
  variant = 'default',
  category,
  onClick,
  hoverEffect = false,
  compact = false,
  loading = false,
}) => {
  const padding = compact ? 'p-3' : 'p-4 md:p-6';

  return (
    <div
      onClick={onClick}
      className={[
        VARIANTS[variant] || VARIANTS.default,
        padding,
        'relative',
        category && CARD_CATEGORIES[category]
          ? `border-l-[3px] border-l-[var(${CARD_CATEGORIES[category]})]`
          : '',
        hoverEffect
          ? 'hover:shadow-[var(--shadow-elevated)] hover:border-[var(--brand-500)]/40 cursor-pointer transition-all duration-200'
          : '',
        className,
      ].filter(Boolean).join(' ')}
    >
      {loading && (
        <div className="absolute inset-0 bg-[var(--surface-card)]/80 rounded-xl flex items-center justify-center z-10">
          <div className="w-full max-w-[80%] space-y-3">
            <div className="h-4 bg-[var(--surface-subtle)] rounded animate-pulse w-3/4" />
            <div className="h-3 bg-[var(--surface-subtle)] rounded animate-pulse w-full" />
            <div className="h-3 bg-[var(--surface-subtle)] rounded animate-pulse w-2/3" />
          </div>
        </div>
      )}
      {children}
    </div>
  );
};

export default Card;
