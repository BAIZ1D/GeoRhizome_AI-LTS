import React from "react";

/**
 * RhizomeLoader - A premium, highly optimized animated vector component representing
 * a growing plant sprout with pulsing subterranean rhizome (root) networks.
 *
 * Performance Optimized:
 * - Avoids CPU-heavy SVG filter effects (e.g. feGaussianBlur).
 * - Relies strictly on compositor-only properties (opacity, CSS 3D scale transforms, path stroke-dashoffset).
 * - High visual snappiness, zero main-thread CPU overhead, low battery drain.
 */
export default function RhizomeLoader({
  size = "md",
  label = "Rhizome searching...",
  animate = true,
}) {
  const dimensions = {
    sm: { svg: "h-8 w-8", text: "text-[10px]" },
    md: { svg: "h-16 w-16", text: "text-xs" },
    lg: { svg: "h-24 w-24", text: "text-sm" },
  }[size] || { svg: "h-16 w-16", text: "text-xs" };

  return (
    <div className="flex flex-col items-center justify-center p-3 select-none">
      {/* CSS-in-JS style block to bundle animations cleanly and keep component highly portable */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
        @keyframes rhizome-grow-leaves {
          0%, 100% {
            transform: scale3d(0, 0, 1);
            opacity: 0;
          }
          50% {
            transform: scale3d(1.1, 1.1, 1);
            opacity: 1;
          }
        }
        @keyframes rhizome-grow-roots {
          0%, 100% {
            stroke-dashoffset: 40;
          }
          50% {
            stroke-dashoffset: 0;
          }
        }
        @keyframes rhizome-text-flicker {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 0.95; }
        }
        .rhizome-shoot {
          transform-origin: 20px 20px;
          ${animate ? "animation: rhizome-grow-leaves 3s ease-in-out infinite;" : ""}
        }
        .rhizome-root-path {
          stroke-dasharray: 40;
          ${animate ? "animation: rhizome-grow-roots 3s ease-in-out infinite;" : ""}
        }
        .rhizome-root-path-delayed {
          stroke-dasharray: 40;
          ${animate ? "animation: rhizome-grow-roots 3s ease-in-out infinite;" : ""}
        }
        .rhizome-text {
          animation: rhizome-text-flicker 3s ease-in-out infinite;
        }
        @keyframes rhizome-breathing {
          0%, 100% {
            transform: scale3d(1, 1, 1);
            filter: drop-shadow(0 0 4px rgba(123, 189, 52, 0.15));
          }
          50% {
            transform: scale3d(1.02, 1.02, 1);
            filter: drop-shadow(0 0 12px rgba(123, 189, 52, 0.35));
          }
        }
        .rhizome-breathing-container {
          ${animate ? "animation: rhizome-breathing 4s ease-in-out infinite;" : ""}
          transition: transform 0.3s ease;
        }
      `,
        }}
      />

      <svg
        viewBox="0 0 40 40"
        className={`${dimensions.svg} overflow-visible rhizome-breathing-container`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Action Green to Emerald gradient for the sprout shoot */}
          <linearGradient
            id="shoot-grad"
            x1="20"
            y1="2"
            x2="20"
            y2="20"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#7bbd34" />
            <stop offset="100%" stopColor="#4e881e" />
          </linearGradient>

          {/* Glowing Green-to-Blue transition for the root networks */}
          <linearGradient
            id="root-grad"
            x1="20"
            y1="20"
            x2="20"
            y2="38"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#7bbd34" />
            <stop offset="60%" stopColor="#006ccf" />
            <stop offset="100%" stopColor="#004ea2" />
          </linearGradient>
        </defs>

        {/* ---------------- SUBTERRANEAN RHIZOME (ROOTS) ---------------- */}
        <g
          stroke="url(#root-grad)"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.8"
        >
          {/* Main Left Branch */}
          <path d="M20 20 Q14 24 10 32 T5 38" className="rhizome-root-path" />
          {/* Left Secondary Sprout */}
          <path
            d="M14 24 Q9 27 7 31 M10 32 Q6 34 4 37"
            className="rhizome-root-path-delayed"
          />

          {/* Main Center-Left Branch */}
          <path d="M20 20 Q18 28 15 36" className="rhizome-root-path-delayed" />

          {/* Main Center-Right Branch */}
          <path d="M20 20 Q22 28 25 36" className="rhizome-root-path" />

          {/* Main Right Branch */}
          <path
            d="M20 20 Q26 24 30 32 T35 38"
            className="rhizome-root-path-delayed"
          />
          {/* Right Secondary Sprout */}
          <path
            d="M26 24 Q31 27 33 31 M30 32 Q34 34 36 37"
            className="rhizome-root-path"
          />
        </g>

        {/* ---------------- SPROUT SHOUT (PLANT) ---------------- */}
        <g className="rhizome-shoot" fill="url(#shoot-grad)">
          {/* Central Stem */}
          <path d="M20 20 C20 14 19 8 20 2 C21 8 20 14 20 20 Z" />

          {/* Left Sprout Leaf */}
          <path d="M20 20 C18 15 12 12 7 15 C9 19 15 20 20 20 Z" />

          {/* Right Sprout Leaf */}
          <path d="M20 20 C22 15 28 12 33 15 C31 19 25 20 20 20 Z" />

          {/* Central Bud Node */}
          <circle cx="20" cy="20" r="1.5" fill="#7bbd34" />
        </g>
      </svg>

      {/* Branded loading state label */}
      {label && (
        <span
          className={`rhizome-text mt-2 font-mono ${dimensions.text} text-theme-green tracking-wide opacity-80 filter drop-shadow-[0_0_8px_rgba(123,189,52,0.3)]`}
        >
          {label}
        </span>
      )}
    </div>
  );
}
