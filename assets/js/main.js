document.addEventListener("DOMContentLoaded", function () {

  /* ===== Section label brand marks ===== */
  document.querySelectorAll(".section__label, .hero-eyebrow, .about-role").forEach(function (label) {
    var dark = label.closest(".hero, .section--navy, .section--cta");
    var img = document.createElement("img");
    img.src = dark ? "assets/images/SPLogo-Offwhite.svg" : "assets/images/favicon.svg";
    img.alt = "";
    img.style.height = "16px";
    img.style.width = "auto";
    img.style.display = "inline-block";
    img.style.verticalAlign = "middle";
    img.style.marginRight = "10px";
    img.style.maxHeight = "16px";
    img.setAttribute("aria-hidden", "true");
    label.prepend(img);
  });

  /* ===== Nav: transparent → solid navy on scroll ===== */
  var nav = document.querySelector(".site-nav");
  if (nav) {
    var onScroll = function () {
      if (window.scrollY > 40) {
        nav.classList.add("scrolled");
      } else {
        nav.classList.remove("scrolled");
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ===== Mobile nav toggle ===== */
  var toggle = document.querySelector(".site-nav__toggle");
  var navLinks = document.querySelector(".site-nav__links");

  if (toggle && navLinks) {
    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      var isOpen = navLinks.classList.toggle("open");
      toggle.classList.toggle("open", isOpen);
      toggle.setAttribute("aria-expanded", String(isOpen));
    });

    /* Close on outside click */
    document.addEventListener("click", function (e) {
      if (navLinks.classList.contains("open") &&
          !navLinks.contains(e.target) &&
          !toggle.contains(e.target)) {
        navLinks.classList.remove("open");
        toggle.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ===== Active nav link ===== */
  var currentPage = window.location.pathname.split("/").pop() || "index.html";
  var links = document.querySelectorAll(".site-nav__links a");
  links.forEach(function (link) {
    if (link.getAttribute("href") === currentPage) {
      link.classList.add("active");
    }
  });

  /* ===== Smooth scroll for anchor links ===== */
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener("click", function (e) {
      var target = document.querySelector(this.getAttribute("href"));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth" });
      }
    });
  });

  /* ===== Scroll-reveal (IntersectionObserver) ===== */
  var reveals = document.querySelectorAll(".reveal");
  if (reveals.length && "IntersectionObserver" in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    reveals.forEach(function (el) { observer.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("visible"); });
  }

  /* ===== Contact form ===== */
  var form = document.getElementById("contact-form");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = document.getElementById("form-status");

      /* Check required fields */
      var requiredFields = form.querySelectorAll("[required]");
      var missing = false;
      requiredFields.forEach(function (field) {
        if (!field.value.trim()) { missing = true; }
      });

      if (missing) {
        status.className = "form-status form-status--error";
        status.textContent = "Please fill in all required fields.";
        status.style.display = "block";
        return;
      }

      /* Check if Formspree endpoint is configured */
      var action = form.getAttribute("action");
      if (!action || action === "FORMSPREE_ENDPOINT_HERE") {
        status.className = "form-status form-status--error";
        status.textContent = "Form endpoint not configured. Set the Formspree URL in the form action attribute.";
        status.style.display = "block";
        return;
      }

      /* Submit via fetch */
      var data = new FormData(form);
      fetch(action, {
        method: "POST",
        body: data,
        headers: { "Accept": "application/json" }
      })
      .then(function (response) {
        if (response.ok) {
          /* Replace form with confirmation message */
          var wrapper = form.parentElement;
          form.remove();
          var note = wrapper.querySelector(".form-note");
          if (note) { note.remove(); }

          var confirmation = document.createElement("div");
          confirmation.className = "form-success";
          confirmation.innerHTML = "<p>Application received. I read every application personally and will respond within five business days.</p>";
          wrapper.appendChild(confirmation);
        } else {
          status.className = "form-status form-status--error";
          status.textContent = "Something went wrong. Please try again or email us directly.";
          status.style.display = "block";
        }
      })
      .catch(function () {
        status.className = "form-status form-status--error";
        status.textContent = "Something went wrong. Please try again or email us directly.";
        status.style.display = "block";
      });
    });
  }
});
