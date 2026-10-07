/**
 * Tables become cards on a phone.
 *
 * A seven-column table on a 375px screen either scrolls sideways or crushes
 * its columns until contract numbers break over three lines. Below a phone's
 * width each row is laid out as a card instead, every value labelled with its
 * column's name. The labels come from the table's own header, copied here,
 * so no page has to repeat them; without JavaScript the table simply scrolls
 * sideways as before.
 */
(function () {
  'use strict';
  document.querySelectorAll('.table-wrap table').forEach(function (table) {
    var heads = Array.prototype.map.call(table.querySelectorAll('thead th'), function (th) {
      return th.textContent.replace(/\s+/g, ' ').trim();
    });
    if (!heads.length) return;
    table.classList.add('cards');
    table.querySelectorAll('tbody tr').forEach(function (tr) {
      if (tr.querySelector('td[colspan]')) { tr.classList.add('card-wide'); return; }
      Array.prototype.forEach.call(tr.children, function (td, i) {
        if (heads[i]) td.setAttribute('data-label', heads[i]);
        if (td.querySelector('.row-actions, .btn')) td.classList.add('card-actions');
      });
      if (tr.children[0]) tr.children[0].classList.add('card-lead');
    });
  });
})();
