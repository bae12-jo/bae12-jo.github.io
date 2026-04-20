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

  function getSidebarOpen() {
    return document.querySelector('.book').classList.contains('with-summary');
  }

  function setSidebarOpen(open) {
    var book = document.querySelector('.book');
    if (!book) return;
    if (open) {
      book.classList.add('with-summary');
    } else {
      book.classList.remove('with-summary');
    }
  }

  function getScrollTop() {
    var el = document.querySelector('.body-inner') || document.querySelector('.page-inner');
    return el ? el.scrollTop : window.scrollY;
  }

  function restoreScrollTop(val) {
    var el = document.querySelector('.body-inner') || document.querySelector('.page-inner');
    if (el) {
      el.scrollTop = val;
    } else {
      window.scrollTo(0, val);
    }
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
        // Save state before navigation
        sessionStorage.setItem('restore-scroll', getScrollTop());
        sessionStorage.setItem('restore-sidebar', getSidebarOpen() ? '1' : '0');
        window.location.href = peer;
      } else {
        filterSidebar(next);
        updateBtn(next);
      }
    });
    header.style.position = 'relative';
    header.appendChild(btn);
  }

  function restoreState() {
    var scroll = sessionStorage.getItem('restore-scroll');
    var sidebar = sessionStorage.getItem('restore-sidebar');

    if (scroll !== null) {
      sessionStorage.removeItem('restore-scroll');
      setTimeout(function() { restoreScrollTop(parseInt(scroll, 10)); }, 200);
    }
    if (sidebar !== null) {
      sessionStorage.removeItem('restore-sidebar');
      setTimeout(function() { setSidebarOpen(sidebar === '1'); }, 50);
    }
  }

  function init() {
    var lang = getLang();
    injectButton();
    updateBtn(lang);
    filterSidebar(lang);
    restoreState();
  }

  document.addEventListener('DOMContentLoaded', init);

  function bindGitbook() {
    if (typeof gitbook !== 'undefined') {
      gitbook.events.bind('page.change', function() { setTimeout(init, 100); });
    }
  }

  document.addEventListener('DOMContentLoaded', function() {
    bindGitbook();
    if (typeof gitbook === 'undefined') setTimeout(bindGitbook, 1000);
  });

  var observer = new MutationObserver(function() {
    if (!document.querySelector('.lang-toggle-btn')) {
      setTimeout(init, 50);
    }
  });
  document.addEventListener('DOMContentLoaded', function() {
    var header = document.querySelector('.book-header');
    if (header) observer.observe(header, { childList: true, subtree: true });
  });
})();
