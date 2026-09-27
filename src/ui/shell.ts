export interface Shell {
  toolbar: HTMLElement;
  canvasHost: HTMLElement;
  sidePanel: HTMLElement;
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

export function createShell(root: HTMLElement): Shell {
  const shell = div('shell');
  const toolbar = div('toolbar');
  const title = document.createElement('strong');
  title.textContent = 'world-imaginer-voxel';
  toolbar.append(title);
  const canvasHost = div('canvas-host');
  const sidePanel = div('side-panel');
  shell.append(toolbar, canvasHost, sidePanel);
  root.replaceChildren(shell);
  return { toolbar, canvasHost, sidePanel };
}
