# TITAN CORE — Vercel Deployment Guide

## Issue Summary
You were seeing exit code 126 on Vercel with "Unexpected token ':'" error. This typically means a build command couldn't execute due to configuration or file structure issues.

## ✅ Fixed Issues

### 1. **Character Encoding in index.html**
- **Problem**: Em dash character was corrupted (showing as `â€"`)
- **Fixed**: Updated to proper UTF-8 em dash (—)

### 2. **Project Structure**
- Ensure your directory layout matches:
```
your-project/
├── index.html
├── vite.config.js
├── package.json
├── src/
│   ├── main.jsx
│   └── App.jsx
└── node_modules/ (auto-generated)
```

## 📋 Pre-Deployment Checklist

### Local Testing (Before Pushing to Vercel)

```bash
# 1. Install dependencies
npm install

# 2. Test dev server
npm run dev
# Should open http://localhost:5173

# 3. Test production build locally
npm run build
# Should create /dist folder with no errors

# 4. Preview production build
npm run preview
```

### If `npm install` fails locally:
- Clear npm cache: `npm cache clean --force`
- Delete node_modules: `rm -rf node_modules package-lock.json`
- Try again: `npm install`

---

## 🚀 Deploying to Vercel

### Option A: Via Vercel CLI
```bash
npm i -g vercel
vercel login
vercel
# Follow the prompts
```

### Option B: Via Vercel Dashboard
1. Push your code to GitHub
2. Go to [vercel.com](https://vercel.com)
3. Import your repository
4. Vercel auto-detects Vite and sets:
   - **Framework**: Vite
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
   - **Install Command**: `npm install`

### Option C: Via GitHub Integration
1. Push to GitHub
2. Connect your GitHub repo to Vercel
3. Auto-deploys on every push

---

## ❌ Common Vercel Errors & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| Exit code 126 | Config file missing/wrong | Ensure `vite.config.js` exists in root |
| "Unexpected token" | Syntax error in JS/JSX | Run `npm run build` locally first |
| Module not found | Missing dependencies | Run `npm install`, check `package.json` |
| Out of memory | Large bundle | Optimize imports, use dynamic imports |

---

## 📁 Environment Variables (if needed)

If your code uses environment variables, create a `.env.local` file locally:
```
VITE_API_URL=https://api.example.com
```

For Vercel, add them in **Project Settings → Environment Variables**.

---

## 🔍 Debugging Build Errors

If build still fails on Vercel:

1. **Check Vercel Build Logs**: Click on a failed deployment to see full output
2. **Test locally**: Run `npm run build` and share the error
3. **Check Node version**: Vercel uses Node 18+ by default
4. **Clear Vercel cache**: In Project Settings → Advanced → Clear cache and redeploy

---

## ✨ Performance Tips for TITAN CORE

Since your game is canvas-heavy:
- ✓ Already optimized with Vite
- ✓ Game loop is efficient (128Hz)
- ✓ Spatial hash grid reduces collisions

Your bundle should be small (<50KB gzipped). Monitor in:
- Vercel Analytics dashboard
- Chrome DevTools Network tab

---

## Files Included

✓ `package.json` - Fixed
✓ `vite.config.js` - Fixed  
✓ `index.html` - Fixed (character encoding)
✓ `src/main.jsx` - No changes needed
✓ `src/App.jsx` - No changes needed

---

**Ready to deploy!** Push these files to your repo and redeploy on Vercel.
