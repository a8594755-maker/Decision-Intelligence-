import React, { useState } from 'react';

export default function ResizableDivider({ onPointerDown, onDoubleClick }) {
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const handlePointerDown = (e) => {
    setIsDragging(true);
    onPointerDown?.(e);
    
    // Add global cursor style during drag
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    
    const handlePointerUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
    
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  };

  return (
    <button
      type="button"
      aria-label="Resize panels - drag to adjust, double-click to reset"
      onPointerDown={handlePointerDown}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="relative w-4 -mx-1 cursor-col-resize group flex items-center justify-center focus:outline-none"
    >
      {/* Invisible hit area */}
      <span className="absolute inset-0" />
      
      {/* Visual divider line */}
      <span 
        className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-px transition-colors duration-150 ${
          isDragging 
            ? 'bg-blue-500' 
            : isHovered 
            ? 'bg-blue-400' 
            : 'bg-slate-200 dark:bg-slate-700'
        }`} 
      />
      
      {/* Draggable handle indicator */}
      <span 
        className={`relative h-8 w-1 rounded-full transition-all duration-150 ${
          isDragging
            ? 'bg-blue-500 scale-y-125'
            : isHovered
            ? 'bg-blue-400 scale-y-110'
            : 'bg-transparent group-hover:bg-slate-300 dark:group-hover:bg-slate-600'
        }`}
      />
      
      {/* Tooltip on hover */}
      {isHovered && !isDragging && (
        <span className="absolute left-1/2 -translate-x-1/2 -top-8 px-2 py-1 bg-slate-800 dark:bg-slate-700 text-white text-[10px] rounded opacity-90 pointer-events-none whitespace-nowrap z-50">
          Drag to resize
          <span className="block text-slate-400">Double-click to reset</span>
        </span>
      )}
    </button>
  );
}
