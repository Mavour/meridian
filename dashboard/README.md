# Meridian Dashboard

Real-time monitoring dashboard for the DLMM LP Agent.

## Quick Start (Local)

```bash
# Install dependencies
npm install

# Run dashboard with API server
npm run dashboard

# Or run both agent + dashboard
npm run start:all
```

Open: http://localhost:3001

---

## Deploy to GitHub Pages (Free)

### Step 1: Push to GitHub

```bash
git init
git add .
git commit -m "Add DLMM agent with dashboard"
git remote add origin https://github.com/YOUR_USERNAME/meridian.git
git push -u origin main
```

### Step 2: Enable GitHub Pages

1. Go to your repository on GitHub
2. Settings → Pages
3. Source: Select **GitHub Actions**
4. The workflow will auto-deploy

### Step 3: Access Your Dashboard

Your dashboard will be available at:
```
https://YOUR_USERNAME.github.io/meridian/
```

---

## Deploy API Server (for live data)

For real-time data, deploy the API server separately:

### Option 1: Railway (Recommended)

1. Create account at https://railway.app
2. Connect your GitHub repo
3. Add environment variables
4. Deploy with start command: `npm run dashboard`

### Option 2: Render

1. Create account at https://render.com
2. Create new Web Service
3. Set start command: `npm run dashboard`
4. Add environment variables

### Option 3: Fly.io

```bash
fly launch
fly secrets set WALLET_PRIVATE_KEY=xxx RPC_URL=xxx OPENROUTER_API_KEY=xxx
fly deploy
```

---

## Architecture

```
┌─────────────────┐
│  GitHub Pages   │  Static HTML/CSS/JS
│  (Dashboard)     │
└────────┬────────┘
         │ (optional)
         ▼
┌─────────────────┐
│  API Server     │  Express + JSON files
│  (Railway/etc)  │
└────────┬────────┘
         │
    ┌────┴────┐
    │ JSON    │
    │ files   │
    └─────────┘
```

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | Agent status and wallet info |
| `GET /api/positions` | Open positions list |
| `GET /api/config` | Current thresholds |
| `GET /api/performance` | Performance summary |

---

## Customization

Edit `dashboard/index.html` to customize:
- Colors: CSS variables in `:root`
- Refresh interval: `refreshInterval` in JavaScript
- API endpoint: `window.API_CONFIG`
