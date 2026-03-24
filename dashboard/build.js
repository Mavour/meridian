import { mkdir, cp, readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname);
const distDir = join(srcDir, '..', 'docs');

// Read current data files with fallback
function readJson(filepath, fallback) {
  try {
    return existsSync(filepath) ? JSON.parse(readFileSync(filepath, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

const stateData = readJson(join(srcDir, '..', 'state.json'), { positions: {} });
const lessonsData = readJson(join(srcDir, '..', 'lessons.json'), { performance: [] });
const configData = readJson(join(srcDir, '..', 'user-config.json'), { screening: {} });

// Create dist directory
mkdir(distDir, { recursive: true }, () => {});

// Copy dashboard files
cp(join(srcDir, 'index.html'), join(distDir, 'index.html'), () => {});

// Create data files for static serving
writeFileSync(join(distDir, 'data.json'), JSON.stringify({
  state: stateData,
  lessons: lessonsData,
  config: configData
}, null, 2));

// Create config for API endpoint
writeFileSync(join(distDir, 'config.js'), `
// Dashboard Configuration
// Update this to point to your API server
window.API_CONFIG = {
  apiBase: '', // Leave empty for same-origin (when using server)
  // Or set your deployed API URL:
  // apiBase: 'https://your-agent.railway.app/api'
  
  // For static GitHub Pages without API, set useStatic: true
  useStatic: true,
  
  // Static data refresh interval (ms)
  staticRefreshInterval: 60000
};
`);

console.log('Dashboard built to ./docs');
console.log('');
console.log('For GitHub Pages:');
console.log('1. Push to GitHub');
console.log('2. Enable GitHub Pages in repo Settings → Source: GitHub Actions');
console.log('');
console.log('For live data, deploy API server separately and update config.js');
