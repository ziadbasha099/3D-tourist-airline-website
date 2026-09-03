/* ---------------------------------------------------------
   Halcyon Air — canvas scroll-scrubbed frame sequence
   + reveal animations

   Why canvas instead of <video>:
   Seeking a compressed video (video.currentTime = x) forces
   the browser to decode from the nearest keyframe on every
   call, which is what caused the original stutter. A canvas
   frame sequence has zero decode cost on the scroll path —
   each frame is a plain bitmap, so a redraw is just a
   drawImage() call. Combined with GSAP's shared ticker (one
   rAF loop for the whole page instead of several competing
   ones) and a "only redraw if the frame actually changed"
   guard, this comfortably holds 60fps on scroll.
--------------------------------------------------------- */
(function () {
  "use strict";

  gsap.registerPlugin(ScrollTrigger);

  /* =========================================================
     1. ScrollFrameSequence
     A reusable canvas + GSAP ScrollTrigger component that
     scrubs a pre-rendered image sequence against scroll
     position. Drop-in reusable for other hero sections.
  ========================================================= */
  function ScrollFrameSequence(opts) {
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext("2d", { alpha: false });
    this.basePath = opts.basePath;       // e.g. "assets/frames/"
    this.manifestUrl = opts.manifestUrl; // JSON: { pattern, count, width, height }
    this.onProgress = opts.onProgress || null;
    this.onReady = opts.onReady || null;

    this.images = [];
    this.loadedCount = 0;
    this.totalFrames = 0;
    this.frameW = 0;
    this.frameH = 0;

    this.targetIndex = 0;     // where scroll wants us to be
    this.shownIndex = -1;     // last frame actually drawn (fractional, lerped)
    this.lastDrawnFrame = -1; // last integer frame drawn (redraw guard)

    this._resizeBound = this._resize.bind(this);
    this._tickBound = this._tick.bind(this);
  }

  ScrollFrameSequence.prototype.init = function () {
    var self = this;
    return fetch(this.manifestUrl)
      .then(function (r) { return r.json(); })
      .then(function (manifest) {
        self.totalFrames = manifest.count;
        self.frameW = manifest.width;
        self.frameH = manifest.height;
        self._buildUrls(manifest.pattern);
        self._resize();
        window.addEventListener("resize", self._resizeBound);
        return self._preload();
      })
      .then(function () {
        self._bindScrollTrigger();
        gsap.ticker.add(self._tickBound);
        if (self.onReady) self.onReady();
      });
  };

  ScrollFrameSequence.prototype._buildUrls = function (pattern) {
    this.urls = [];
    for (var i = 1; i <= this.totalFrames; i++) {
      var padded = String(i).padStart(4, "0");
      this.urls.push(this.basePath + pattern.replace("%04d", padded));
    }
  };

  ScrollFrameSequence.prototype._preload = function () {
    var self = this;

    // Load frame 1 first so there is something on screen almost
    // immediately, then stream the rest in behind it. Scrubbing
    // is clamped to whatever is loaded so far (see _tick), so the
    // page never blocks on the full sequence before scrolling.
    function loadOne(i) {
      return new Promise(function (resolve) {
        var img = new Image();
        img.decoding = "async";
        img.onload = function () {
          self.images[i] = img;
          self.loadedCount++;
          if (self.onProgress) {
            self.onProgress(self.loadedCount / self.totalFrames);
          }
          resolve();
        };
        img.onerror = resolve; // don't let one bad frame block the sequence
        img.src = self.urls[i];
      });
    }

    return loadOne(0).then(function () {
      self._draw(0);

      // stream the remaining frames with a small concurrency cap
      // so we don't saturate the network/main thread all at once
      var CONCURRENCY = 6;
      var next = 1;
      function pump() {
        var batch = [];
        while (next < self.totalFrames && batch.length < CONCURRENCY) {
          batch.push(loadOne(next));
          next++;
        }
        if (!batch.length) return Promise.resolve();
        return Promise.all(batch).then(pump);
      }
      return pump();
    });
  };

  ScrollFrameSequence.prototype._bindScrollTrigger = function () {
    var self = this;
    // The entire document's scroll range maps to the sequence.
    // onUpdate is intentionally cheap: it only stores a number.
    // All actual drawing happens in the ticker below.
    ScrollTrigger.create({
      trigger: document.documentElement,
      start: "top top",
      end: "bottom bottom",
      onUpdate: function (st) {
        self.targetIndex = st.progress * (self.totalFrames - 1);
      }
    });
  };

  ScrollFrameSequence.prototype._tick = function () {
    if (!this.totalFrames) return;

    // clamp to what's actually loaded so scrubbing never
    // outruns the network
    var maxLoaded = Math.max(0, this.loadedCount - 1);
    var target = Math.min(this.targetIndex, maxLoaded);

    if (this.shownIndex < 0) this.shownIndex = target;

    // lerp for a smooth, momentum-like glide between frames
    // instead of snapping straight to the scroll position
    this.shownIndex += (target - this.shownIndex) * 0.18;
    if (Math.abs(target - this.shownIndex) < 0.02) this.shownIndex = target;

    var frame = Math.round(this.shownIndex);

    // the single most important guard for scroll performance:
    // never touch the canvas unless the visible frame actually changed
    if (frame !== this.lastDrawnFrame && this.images[frame]) {
      this._draw(frame);
      this.lastDrawnFrame = frame;
    }
  };

  ScrollFrameSequence.prototype._draw = function (index) {
    var img = this.images[index];
    if (!img) return;
    var ctx = this.ctx;
    var cw = this.canvas.width;
    var ch = this.canvas.height;

    // manual "object-fit: cover" math
    var scale = Math.max(cw / this.frameW, ch / this.frameH);
    var dw = this.frameW * scale;
    var dh = this.frameH * scale;
    var dx = (cw - dw) / 2;
    var dy = (ch - dh) / 2;

    ctx.drawImage(img, dx, dy, dw, dh);
  };

  ScrollFrameSequence.prototype._resize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.lastDrawnFrame = -1; // force a redraw at the new size
    if (this.loadedCount) {
      this._draw(Math.round(this.shownIndex < 0 ? 0 : this.shownIndex));
    }
  };

  /* =========================================================
     2. Wire it up to the hero canvas
  ========================================================= */
  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var preloadBar = document.getElementById("preloadBar");
  var preloadFill = preloadBar ? preloadBar.querySelector("span") : null;

  var sequence = new ScrollFrameSequence({
    canvas: document.getElementById("bgCanvas"),
    basePath: "assets/frames/",
    manifestUrl: "assets/frames/manifest.json",
    onProgress: function (fraction) {
      if (preloadFill) preloadFill.style.width = Math.round(fraction * 100) + "%";
      if (fraction >= 1 && preloadBar) preloadBar.classList.add("is-done");
    },
    onReady: function () {
      if (preloadBar) preloadBar.classList.add("is-done");
      ScrollTrigger.refresh();
    }
  });

  if (reduceMotion) {
    // respect the user's OS preference: skip continuous scrubbing,
    // just land on a single representative frame
    sequence.init().then(function () {
      gsap.ticker.remove(sequence._tickBound);
    });
  } else {
    sequence.init();
  }

  /* ---------------------------------------------------------
     3. Scroll-triggered reveals
     Every [data-reveal] element fades / slides / scales into
     place once, the first time it crosses into view.
  --------------------------------------------------------- */
  var revealEls = document.querySelectorAll("[data-reveal]");

  revealEls.forEach(function (el) {
    ScrollTrigger.create({
      trigger: el,
      start: "top 88%",
      once: true,
      onEnter: function () {
        el.classList.add("is-visible");
      }
    });
  });

  ScrollTrigger.refresh();

  /* ---------------------------------------------------------
     4. Nav background fade-in after leaving the hero
  --------------------------------------------------------- */
  var nav = document.querySelector(".nav");
  ScrollTrigger.create({
    trigger: "#hero",
    start: "bottom top",
    onEnter: function () { nav.classList.add("nav--scrolled"); },
    onLeaveBack: function () { nav.classList.remove("nav--scrolled"); }
  });

  /* ---------------------------------------------------------
     5. Smooth in-page anchor scrolling for nav links
  --------------------------------------------------------- */
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener("click", function (e) {
      var id = link.getAttribute("href");
      if (id.length < 2) return;
      var target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
})();
