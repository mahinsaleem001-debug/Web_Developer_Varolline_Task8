// Runs before first paint so the saved theme does not flash.
(function () {
  var t = null;
  try { t = localStorage.getItem('taskflow-theme'); } catch (e) { /* storage blocked */ }
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
})();
