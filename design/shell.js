// Fullscreen shell used on real phones (replaces the desktop iPhone preview frame).
window.BloomShell = function BloomShell({ children }) {
  return React.createElement('div', {
    style: { position: 'fixed', inset: 0, background: '#F6F5F0', overflow: 'hidden' }
  }, children);
};
