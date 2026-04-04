/**
 * Kaiban Distributed — Service Worker Registration
 *
 * Kept in a separate file so that the strict CSP on each viewer page
 * (script-src 'self') allows it to run without inline-script permissions.
 *
 * The SW is registered with scope './' so it controls the viewer directory
 * it is loaded from, regardless of where sw.js actually lives.
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('../../shared/viewer/sw.js', { scope: './' })
    .catch(function () { /* SW registration is optional — silently ignore failures */ });
}
