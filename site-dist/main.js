/* Voice Agent OS landing — count-up stats + mobile menu */

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- stat count-up ---------- */

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function formatValue(value, decimals) {
    return value.toFixed(decimals);
  }

  function runCountUp(el, index) {
    var target = parseFloat(el.dataset.target || "0");
    var decimals = parseInt(el.dataset.decimals || "0", 10);
    var numEl = el.querySelector(".num");
    if (!numEl) return;

    if (reduceMotion) {
      numEl.textContent = formatValue(target, decimals);
      return;
    }

    var duration = 1500 + index * 80;
    var startOffset = 480 + index * 90;
    var startTime = null;

    function frame(now) {
      if (startTime === null) startTime = now;
      var elapsed = now - startTime;
      if (elapsed < startOffset) {
        requestAnimationFrame(frame);
        return;
      }
      var t = Math.min((elapsed - startOffset) / duration, 1);
      numEl.textContent = formatValue(target * easeOutCubic(t), decimals);
      if (t < 1) requestAnimationFrame(frame);
      else numEl.textContent = formatValue(target, decimals);
    }

    requestAnimationFrame(frame);
  }

  var stats = Array.prototype.slice.call(document.querySelectorAll(".stat"));

  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          observer.unobserve(el);
          runCountUp(el, stats.indexOf(el));
        });
      },
      { threshold: 0.25 },
    );
    stats.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    stats.forEach(function (el, i) {
      runCountUp(el, i);
    });
  }

  /* ---------- mobile menu ---------- */

  var burger = document.querySelector(".burger");
  var menu = document.getElementById("mobile-menu");
  var overlay = document.getElementById("menu-overlay");

  function isOpen() {
    return document.body.classList.contains("menu-open");
  }

  function openMenu() {
    if (!burger || !menu || !overlay) return;
    document.body.classList.add("menu-open");
    burger.setAttribute("aria-expanded", "true");
    burger.setAttribute("aria-label", "Close menu");
    menu.hidden = false;
    overlay.hidden = false;
  }

  function closeMenu() {
    if (!burger || !menu || !overlay) return;
    document.body.classList.remove("menu-open");
    burger.setAttribute("aria-expanded", "false");
    burger.setAttribute("aria-label", "Open menu");
    menu.hidden = true;
    overlay.hidden = true;
  }

  function toggleMenu() {
    if (isOpen()) closeMenu();
    else openMenu();
  }

  if (burger) burger.addEventListener("click", toggleMenu);
  if (overlay) overlay.addEventListener("click", closeMenu);

  if (menu) {
    menu.addEventListener("click", function (event) {
      var target = event.target;
      if (target && target.tagName === "A") closeMenu();
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && isOpen()) closeMenu();
  });

  window.addEventListener("resize", function () {
    if (window.innerWidth > 720 && isOpen()) closeMenu();
  });
})();
