/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./*.html', './js/**/*.js', './css/**/*.css'],
  theme: {
    extend: {
      // 玻璃用色与圆角可在此扩展，便于 utility 引用
      borderRadius: { glass: '1.7rem' },
      boxShadow: {
        glass: '0 16px 46px rgba(40,60,100,0.20), inset 0 2px 0 rgba(255,255,255,0.95), inset 0 0 0 1px rgba(255,255,255,0.55), inset 0 0 34px rgba(255,255,255,0.30)'
      }
    }
  },
  plugins: []
};
