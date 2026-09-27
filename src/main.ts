import './ui/styles.css';
import { probeCapabilities } from './engine/capabilities';
import { evaluateCapabilities } from './engine/capabilityRules';
import { startSkyRenderer } from './render/renderer';
import { renderCapabilityReport, renderErrorScreen } from './ui/capabilityReport';
import { createFrameStats } from './ui/frameStats';
import { mountHud } from './ui/hud';
import { createShell } from './ui/shell';

async function boot(root: HTMLElement): Promise<void> {
  const report = await probeCapabilities();
  const evaluation = evaluateCapabilities(report);
  if (!evaluation.ok) {
    renderErrorScreen(root, report, evaluation);
    return;
  }
  const shell = createShell(root);
  renderCapabilityReport(shell.sidePanel, report, evaluation);
  const stats = createFrameStats();
  mountHud(shell.toolbar, stats);
  startSkyRenderer(shell.canvasHost, (ms) => stats.push(ms));
}

const root = document.getElementById('app');
if (root === null) throw new Error('#app element missing from index.html');
const start: Promise<void> = new URLSearchParams(location.search).get('lab') === 'noise'
  ? import('./ui/lab/noiseLab').then((m) => m.mountNoiseLab(root))
  : boot(root);
start.catch((error: unknown) => {
  const pre = document.createElement('pre');
  pre.textContent = `Boot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
  root.replaceChildren(pre);
});
