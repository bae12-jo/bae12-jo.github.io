(function() {
  function getLang() {
    var meta = document.querySelector('meta[name="page-lang"]');
    if (meta && meta.getAttribute('content')) return meta.getAttribute('content');
    return localStorage.getItem('preferred-lang') || 'ko';
  }

  function setLang(lang) {
    localStorage.setItem('preferred-lang', lang);
  }

  function filterSidebar(lang) {
    document.querySelectorAll('.book-summary li[data-lang]').forEach(function(li) {
      li.style.display = li.getAttribute('data-lang') === lang ? '' : 'none';
    });
  }

  function updateBtn(lang) {
    document.querySelectorAll('.lang-toggle-btn').forEach(function(btn) {
      btn.textContent = lang === 'ko' ? 'EN' : '한';
    });
  }

  function getPeer() {
    var meta = document.querySelector('meta[name="lang-peer"]');
    return meta ? meta.getAttribute('content') : null;
  }

  function injectButton() {
    if (document.querySelector('.lang-toggle-btn')) return;
    var header = document.querySelector('.book-header');
    if (!header) return;

    var btn = document.createElement('a');
    btn.className = 'lang-toggle-btn';
    btn.href = '#';
    btn.style.cssText = 'position:absolute;right:16px;top:0;line-height:50px;padding:0 12px;font-size:13px;font-weight:bold;color:inherit;text-decoration:none;z-index:10;';
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      var current = getLang();
      var next = current === 'ko' ? 'en' : 'ko';
      setLang(next);
      var peer = getPeer();
      if (peer) {
        window.location.href = peer;
      } else {
        filterSidebar(next);
        updateBtn(next);
      }
    });
    header.style.position = 'relative';
    header.appendChild(btn);
  }

  function init() {
    var lang = getLang();
    injectButton();
    updateBtn(lang);
    filterSidebar(lang);
  }

  // Initial load
  document.addEventListener('DOMContentLoaded', init);

  // GitBook SPA navigation
  if (typeof gitbook !== 'undefined') {
    gitbook.events.bind('page.change', function() { setTimeout(init, 100); });
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof gitbook !== 'undefined') {
        gitbook.events.bind('page.change', function() { setTimeout(init, 100); });
      }
    });
  }

  // MutationObserver fallback: re-init when book-header content changes
  var observer = new MutationObserver(function(mutations) {
    for (var m of mutations) {
      if (m.target.classList && m.target.classList.contains('book-header')) {
        if (!document.querySelector('.lang-toggle-btn')) {
          setTimeout(init, 50);
        }
        break;
      }
    }
  });

  document.addEventListener('DOMContentLoaded', function() {
    var header = document.querySelector('.book-header');
    if (header) {
      observer.observe(header, { childList: true, subtree: true });
    }
    // Also observe body for header replacement
    observer.observe(document.body, { childList: true, subtree: false });
  });
})();
