import tailwindcssAnimate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        btc: {
          DEFAULT: '#F7931A',
          light: '#FFB020',
          deep: '#D97A0B',
        },
        ink: {
          900: '#0B0E14',
          800: '#141922',
          700: '#1C2430',
          600: '#232C3B',
        },
        up: '#0ECB81',
        down: '#F6465D',
        warn: '#E8A33D',
        info: '#2E90FA',
        muted: '#6B7688',
        subtle: '#A7B1C2',
      },
      fontFamily: {
        sans: [
          'PingFang SC',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: ['SF Mono', 'JetBrains Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        heading: ['28px', { lineHeight: '1.25', fontWeight: '600' }],
        sub: ['18px', { lineHeight: '1.4', fontWeight: '500' }],
      },
      boxShadow: {
        glass: '0 8px 32px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
        glow: '0 0 24px rgba(247, 147, 26, 0.28)',
        'glow-up': '0 0 20px rgba(14, 203, 129, 0.24)',
        'glow-down': '0 0 20px rgba(246, 70, 93, 0.24)',
      },
      backgroundImage: {
        'btc-gradient': 'linear-gradient(135deg, #F7931A 0%, #FFB020 100%)',
        'glass-sheen':
          'linear-gradient(135deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.01) 100%)',
      },
      keyframes: {
        'flash-up': {
          '0%': { color: '#0ECB81', transform: 'scale(1.04)' },
          '100%': { color: 'inherit', transform: 'scale(1)' },
        },
        'flash-down': {
          '0%': { color: '#F6465D', transform: 'scale(1.04)' },
          '100%': { color: 'inherit', transform: 'scale(1)' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.45', transform: 'scale(0.82)' },
        },
      },
      animation: {
        'flash-up': 'flash-up 0.6s ease-out',
        'flash-down': 'flash-down 0.6s ease-out',
        'fade-in-up': 'fade-in-up 0.35s ease-out both',
        shimmer: 'shimmer 2.4s linear infinite',
        'pulse-dot': 'pulse-dot 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
