/**
 * Switching between light and dark, instantly.
 *
 * It used to be a form post: the server saved the choice and sent the whole
 * page again, two trips to a database on the other side of the world before
 * anything changed. Now the page switches at once — every colour is already
 * in the stylesheet for both themes — and the choice is saved in the
 * background. Without JavaScript the form still works the old way.
 */
(function () {
  'use strict';
  var root = document.documentElement;

  function apply(theme) {
    // A colour transition across the whole page reads as lag, not polish.
    root.classList.add('theme-switching');
    root.setAttribute('data-theme', theme);
    var scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.setAttribute('content', theme);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { root.classList.remove('theme-switching'); });
    });
  }

  document.addEventListener('submit', function (e) {
    var form = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (!form || !window.fetch) return;
    e.preventDefault();

    var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    apply(next);
    form.elements.theme.value = next === 'light' ? 'dark' : 'light';

    var body = new URLSearchParams(new FormData(form));
    body.set('theme', next);
    fetch(form.action, {
      method: 'POST',
      body: body,
      headers: { 'x-theme-switch': '1' },
      credentials: 'same-origin',
      keepalive: true
    }).catch(function () { /* the page has switched; the next load will simply show the old choice */ });
  });
})();
