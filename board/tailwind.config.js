/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // KaibanJS-inspired dark palette
        surface: {
          DEFAULT: '#0f172a', // slate-900 — page background
          card: '#1e293b',    // slate-800 — card background
          border: '#334155',  // slate-700 — card borders
          muted: '#475569',   // slate-600 — muted text
        },
      },
      animation: {
        'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};
