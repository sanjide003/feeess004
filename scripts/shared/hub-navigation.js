/**
 * Universal Official Hub Navigation Widget
 * Provides seamless return-to-hub navigation and a floating quick-switcher
 * across Fee Collection, Result Management, and Admin pages without session loss.
 */
(() => {
  const currentPath = window.location.pathname.toLowerCase();
  const isOfficialHub = currentPath.includes('official.html');
  if (isOfficialHub) return; // Not needed on hub itself

  const injectHubNavigation = () => {
    try {
      // Remove any existing floating switcher if present
      document.getElementById('hub-floating-switcher')?.remove();
      document.getElementById('floating-hub-switcher')?.remove();

      // Add Top-Bar "Official Hub" button in collection.html & result.html if not already present
      const mobileToggle = document.querySelector('.mobile-toggle');
      if (mobileToggle && mobileToggle.parentNode && mobileToggle.parentNode.contains(mobileToggle) && !document.getElementById('topbar-hub-link')) {
        const hubBtn = document.createElement('a');
        hubBtn.id = 'topbar-hub-link';
        hubBtn.href = 'official.html';
        hubBtn.className = 'hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200 transition-all mr-2';
        hubBtn.title = 'Back to Official Hub';
        hubBtn.innerHTML = '<i class="fas fa-th-large text-blue-600"></i><span>Official Hub</span>';
        mobileToggle.parentNode.insertBefore(hubBtn, mobileToggle);
      }
    } catch (err) {
      console.warn('Hub navigation injection warning:', err);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectHubNavigation);
  } else {
    injectHubNavigation();
  }
})();
