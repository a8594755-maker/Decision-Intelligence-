import React from 'react';

/**
 * Card Component
 * Reusable card container component
 */
export const Card = ({
  children,
  className = "",
  onClick,
  hoverEffect = false
}) => {
  return (
    <div
      onClick={onClick}
      className={`bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-4 md:p-6 ${
        hoverEffect
          ? 'hover:shadow-lg hover:border-blue-500 dark:hover:border-blue-400 cursor-pointer transition-all duration-200'
          : ''
      } ${className}`}
    >
      {children}
    </div>
  );
};

export default Card;
