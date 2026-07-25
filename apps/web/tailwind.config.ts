import type { Config } from 'tailwindcss';

/**
 * Terminal-first design tokens.
 *
 * Dark mode is the default and the light theme is the variant, not the other way
 * round: this is a tool people stare at for hours next to charts, and the
 * reference points (Bloomberg, TradingView) are dark. Semantic colours are
 * defined once here so a "bearish" red is the same red in the timeline, the
 * charts and the alert badges.
 */
export default {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Tabular numerals matter: a column of prices that shifts horizontally
        // as digits change is unreadable at a glance.
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        // Surfaces, darkest to lightest.
        base: {
          950: '#08090b',
          900: '#0b0d10',
          850: '#101317',
          800: '#15181d',
          700: '#1d2127',
          600: '#282d35',
          500: '#3a4048',
        },
        ink: {
          DEFAULT: '#e8eaed',
          muted: '#9aa4b2',
          faint: '#646d7a',
        },
        // Directional colours. Green/red are the conventional pair; both are
        // shifted toward cyan/magenta slightly so they remain distinguishable
        // for the most common forms of colour vision deficiency.
        bull: { DEFAULT: '#10b981', strong: '#059669', soft: '#064e3b' },
        bear: { DEFAULT: '#f43f5e', strong: '#e11d48', soft: '#4c0519' },
        neutral: { DEFAULT: '#64748b' },
        accent: { DEFAULT: '#6366f1', soft: '#312e81' },
        warn: { DEFAULT: '#f59e0b', soft: '#451a03' },
      },
      fontSize: {
        // A dense scale: the terminal shows a lot of rows.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1.1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
      },
      animation: {
        'fade-in': 'fadeIn 200ms ease-out',
        'flash-bull': 'flashBull 700ms ease-out',
        'flash-bear': 'flashBear 700ms ease-out',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0', transform: 'translateY(-2px)' }, to: { opacity: '1', transform: 'none' } },
        // Price ticks flash their direction — the standard terminal affordance.
        flashBull: { '0%': { backgroundColor: 'rgba(16,185,129,0.18)' }, '100%': { backgroundColor: 'transparent' } },
        flashBear: { '0%': { backgroundColor: 'rgba(244,63,94,0.18)' }, '100%': { backgroundColor: 'transparent' } },
      },
    },
  },
  plugins: [],
} satisfies Config;
