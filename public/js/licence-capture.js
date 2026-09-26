/**
 * Taking a photograph of a driving licence, on a phone or from a file.
 *
 * A modern phone camera produces several megabytes; a licence is legible at a
 * fraction of that. The picture is therefore drawn down to a readable size in
 * the browser and only then sent, which keeps the upload quick on a hotel
 * wi-fi and keeps a contract's attachments in the hundreds of kilobytes rather
 * than the tens of megabytes.
 *
 * Markup it expects, per slot:
 *   <div class="shot" data-shot>
 *     <input type="file" accept="image/*" capture="environment" data-file>
 *     <input type="hidden" name="licence_front" data-field>
 *     <img data-preview hidden>
 *     <p data-status></p>
 *   </div>
 */
(function () {
  'use strict';

  var MAX_EDGE = 1100;      // enough to read a licence number, not a poster
  var QUALITY = 0.72;
  var LIMIT = 600 * 1024;   // refused by the server above this

  function readable(bytes) {
    return bytes > 1024 * 1024
      ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
      : Math.round(bytes / 1024) + ' KB';
  }

  function shrink(file, done, fail) {
    var reader = new FileReader();
    reader.onerror = function () { fail('That file could not be read.'); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { fail('That file is not an image.'); };
      img.onload = function () {
        var scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));

        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';           // a PNG with transparency would print hollow
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        var quality = QUALITY;
        var out = canvas.toDataURL('image/jpeg', quality);
        // Rare, but a very busy photograph can still come out over the limit.
        while (out.length * 0.75 > LIMIT && quality > 0.35) {
          quality -= 0.12;
          out = canvas.toDataURL('image/jpeg', quality);
        }
        if (out.length * 0.75 > LIMIT) return fail('That photo is too detailed to send. Try again in better light.');
        done(out, Math.floor(out.length * 0.75));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function wire(slot) {
    var file = slot.querySelector('[data-file]');
    var field = slot.querySelector('[data-field]');
    var preview = slot.querySelector('[data-preview]');
    var status = slot.querySelector('[data-status]');
    if (!file || !field) return;

    file.addEventListener('change', function () {
      var chosen = file.files && file.files[0];
      if (!chosen) return;

      slot.classList.remove('bad');
      status.textContent = 'Preparing the photo…';

      shrink(chosen, function (dataUrl, bytes) {
        field.value = dataUrl;
        if (preview) {
          preview.src = dataUrl;
          preview.hidden = false;
        }
        slot.classList.add('filled');
        status.textContent = 'Ready to send · ' + readable(bytes);
        slot.dispatchEvent(new CustomEvent('shot:ready', { bubbles: true }));
      }, function (reason) {
        field.value = '';
        slot.classList.add('bad');
        slot.classList.remove('filled');
        status.textContent = reason;
      });
    });
  }

  document.querySelectorAll('[data-shot]').forEach(wire);

  // The form is only worth sending once both sides are in it.
  var form = document.querySelector('[data-licence-form]');
  if (form) {
    var button = form.querySelector('[data-licence-submit]');
    var check = function () {
      var fields = form.querySelectorAll('[data-field]');
      var ready = Array.prototype.every.call(fields, function (f) { return f.value; });
      if (button) button.disabled = !ready;
    };
    form.addEventListener('shot:ready', check);
    check();
  }
})();
